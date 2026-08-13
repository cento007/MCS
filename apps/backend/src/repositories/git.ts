import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Local git, invoked directly — never through a shell (F8.1: "no shell-outs to
 * platform-specific commands; git/CLI invocations use `execFile` with explicit executable
 * paths"). This module is the only place in the Backend that runs `git`.
 *
 * Three properties the rest of the system depends on, in order of importance:
 *
 *  1. **Bounded.** Every invocation carries a wall-clock timeout and an output cap. A
 *     pathological repository (a network drive that stalls, a multi-gigabyte untracked tree,
 *     an index another process is holding) fails as `timed_out` in a known number of
 *     milliseconds instead of holding a request handler open. The session-start hang was this
 *     exact failure mode.
 *  2. **Total.** "git is not installed", "that path is not a repository" and "git printed
 *     something we did not expect" are *ordinary answers* returned as data, never thrown and
 *     never a 500. Nothing here rejects: `runGit` resolves with a failure discriminator.
 *  3. **Cross-platform.** No shell, no `.cmd`/`.sh` wrapper, no platform branch. `execFile`
 *     resolves the executable through PATH on both Windows and Linux; `--porcelain=v2` output
 *     is byte-identical on both, and `LC_ALL=C` keeps git's *stderr* English so the
 *     "not a repository" classification below does not depend on the operator's locale.
 */

/**
 * PATH lookup, not an absolute path: Mission Control has no `git.path` setting yet (the
 * settings service is unimplemented), and F1.5 already requires Git for Windows on the dev
 * host. `GitOptions.executable` is the seam a future setting fills — it is not a shell string
 * and is never concatenated into one.
 */
export const DEFAULT_GIT_EXECUTABLE = 'git';

/**
 * Long enough for a cold index refresh on a large repository, short enough to be a request.
 *
 * Measured, not guessed: `git status` over this repository on the Windows 11 development host
 * takes ~3.3 s cold (first call after a restart, with an on-access virus scanner in the path)
 * and ~0.6 s warm. A 5 s bound left almost no headroom on the very repository the operator
 * will register first, and a spurious timeout degrades the launch modal to "cannot verify" —
 * the state this endpoint exists to remove.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 10_000;

/** `git status` on a sane tree is kilobytes. A megabyte of it means something is wrong. */
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** How much of git's own complaint is passed back to the operator. */
const MAX_DETAIL_LENGTH = 300;

const NOT_A_REPOSITORY = /not a git repository|not a working tree/i;

/** Why an invocation produced no usable answer. */
export type GitFailure = 'git_unavailable' | 'timed_out' | 'git_failed';

/** Why a working tree could not be read. `null` (see below) means it could. */
export type WorkingTreeUnavailableReason =
  | 'path_missing'
  | 'not_a_directory'
  | 'not_a_git_repository'
  | GitFailure;

export interface GitOptions {
  /** Defaults to `DEFAULT_GIT_EXECUTABLE`. */
  readonly executable?: string;
  /** Defaults to `DEFAULT_GIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface GitCommandOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process never ran or was killed before exiting. */
  readonly exitCode: number | null;
  /** `null` iff `ok`. */
  readonly failure: GitFailure | null;
}

/**
 * Run one git command in `cwd` and resolve with its outcome.
 *
 * Never rejects. `shell` is left at its default (`false`) — arguments reach git as an argv
 * array, so a repository path containing spaces, `&` or a quote is data, not syntax.
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  options: GitOptions = {},
): Promise<GitCommandOutcome> {
  const executable = options.executable ?? DEFAULT_GIT_EXECUTABLE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  return new Promise((settle) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          // A read-only probe must never block on a credential helper or a pinentry dialog.
          GIT_TERMINAL_PROMPT: '0',
          // Keeps git's diagnostics English so `NOT_A_REPOSITORY` classifies rather than guesses.
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          settle({ ok: true, stdout, stderr, exitCode: 0, failure: null });
          return;
        }

        const failed = error as NodeJS.ErrnoException & {
          readonly killed?: boolean;
          readonly signal?: NodeJS.Signals | null;
        };

        settle({
          ok: false,
          stdout,
          stderr,
          exitCode: typeof failed.code === 'number' ? failed.code : null,
          failure: classify(failed),
        });
      },
    );
  });
}

function classify(
  error: NodeJS.ErrnoException & { readonly killed?: boolean; readonly signal?: unknown },
): GitFailure {
  // The child was killed rather than exiting — which, with a `timeout` set and no other
  // killer in the process, is the timeout firing.
  if (error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL') {
    return 'timed_out';
  }
  // libuv could not start the process at all: no git on PATH, or not executable.
  if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') {
    return 'git_unavailable';
  }
  return 'git_failed';
}

/** A repository's working tree as of *right now*. Derived on read; never persisted. */
export interface WorkingTreeStatus {
  readonly isGitWorkingTree: boolean;
  /** `null` when detached, unborn-and-unnamed, or unreadable. */
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  /** `null` in a repository with no commits yet. */
  readonly headSha: string | null;
  /** Tracked modifications + staged changes + untracked entries. `null` when unreadable. */
  readonly uncommittedFiles: number | null;
  /** Commits ahead of / behind the upstream branch; `null` when there is no upstream. */
  readonly ahead: number | null;
  readonly behind: number | null;
  /** `null` iff the tree was read successfully. */
  readonly unavailableReason: WorkingTreeUnavailableReason | null;
  /** git's own first line of complaint, truncated. Never invented. */
  readonly detail: string | null;
}

/**
 * Read a repository's current branch and uncommitted-file count (TDS 06 §5.4.1 / WC11).
 *
 * One process, not four: `--porcelain=v2 --branch` answers "is this a working tree", "which
 * branch", "what is HEAD" and "how many uncommitted entries" in a single invocation, so the
 * whole probe carries exactly one timeout and one chance to hang.
 *
 * `--untracked-files` is left at git's own default (`normal`), which is what the operator sees
 * when they run `git status` in that directory themselves — an untracked *directory* therefore
 * counts as one entry, not one per file. That is a deliberate bound as well as a consistency
 * choice: `-uall` walks every ignored-but-not-really tree on disk, which is precisely the
 * pathological case this probe must not sit inside.
 *
 * `--no-optional-locks` keeps the probe from taking `index.lock` — Mission Control polling a
 * repository must never make the operator's own `git commit` in the next terminal fail.
 */
export async function probeWorkingTree(
  localPath: string,
  options: GitOptions = {},
): Promise<WorkingTreeStatus> {
  const kind = await inspectPath(localPath);
  if (kind !== 'directory') return unavailable(kind, null);

  const outcome = await runGit(
    ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
    localPath,
    options,
  );

  if (!outcome.ok) {
    const reason: WorkingTreeUnavailableReason =
      outcome.failure === 'git_failed' && NOT_A_REPOSITORY.test(outcome.stderr)
        ? 'not_a_git_repository'
        : (outcome.failure ?? 'git_failed');

    return unavailable(reason, firstLine(outcome.stderr));
  }

  const parsed = parseStatusPorcelainV2(outcome.stdout);

  return {
    isGitWorkingTree: true,
    currentBranch: parsed.currentBranch,
    detachedHead: parsed.detachedHead,
    headSha: parsed.headSha,
    uncommittedFiles: parsed.uncommittedFiles,
    ahead: parsed.ahead,
    behind: parsed.behind,
    unavailableReason: null,
    detail: null,
  };
}

export interface ParsedWorkingTree {
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  readonly headSha: string | null;
  readonly uncommittedFiles: number;
  readonly ahead: number | null;
  readonly behind: number | null;
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * Format (git ≥ 2.11, stable and documented as machine-readable): `# ` header lines carry
 * `branch.oid`, `branch.head`, `branch.upstream` and `branch.ab`; every other non-empty line is
 * exactly one changed entry — ordinary (`1`), renamed/copied (`2`), unmerged (`u`) or untracked
 * (`?`). Counting lines is therefore counting entries, including for a rename: without `-z`,
 * paths containing whitespace or newlines are C-quoted by git, so no entry can span two lines.
 */
export function parseStatusPorcelainV2(stdout: string): ParsedWorkingTree {
  let currentBranch: string | null = null;
  let detachedHead = false;
  let headSha: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let uncommittedFiles = 0;

  for (const raw of stdout.split('\n')) {
    // Defensive: git writes LF, but a CRLF-translating layer between here and there would
    // otherwise leave `\r` glued to a branch name.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;

    if (line.startsWith('# ')) {
      const oid = header(line, '# branch.oid ');
      if (oid !== null) {
        // `(initial)` — a repository with no commits yet. Not an error, just no HEAD.
        headSha = oid === '(initial)' ? null : oid;
        continue;
      }

      const head = header(line, '# branch.head ');
      if (head !== null) {
        if (head === '(detached)') {
          detachedHead = true;
          currentBranch = null;
        } else {
          currentBranch = head;
        }
        continue;
      }

      const ab = header(line, '# branch.ab ');
      if (ab !== null) {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(ab);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    uncommittedFiles += 1;
  }

  return { currentBranch, detachedHead, headSha, uncommittedFiles, ahead, behind };
}

/**
 * Does this directory contain a `.git` entry?
 *
 * A *file* named `.git` counts: that is how git records a linked worktree or a submodule, and
 * refusing to register one would reject a perfectly real working tree. This is the git-free
 * half of registration validation — it lets an operator register a repository on a machine
 * where git is not on PATH, which is exactly the machine where the probe cannot help.
 */
export async function hasDotGitEntry(localPath: string): Promise<boolean> {
  try {
    await stat(join(localPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Why a remote could not be read. `null` (see below) means it could. */
export type RemoteUnavailableReason =
  /** The directory is a working tree, but has no remote by that name. */
  'no_remote' | 'not_a_git_repository' | GitFailure;

export interface GitRemoteRead {
  /** The configured URL, verbatim. **May contain credentials** — see `github/remote.ts`. */
  readonly url: string | null;
  /** `null` iff `url` is non-null. */
  readonly unavailableReason: RemoteUnavailableReason | null;
  readonly detail: string | null;
}

/**
 * Read one remote's URL — **one** `git` invocation that answers two questions at once.
 *
 * That is the whole reason this exists rather than a `rev-parse` followed by a `config --get`:
 * discovery runs it over every candidate directory under every configured root, and on Windows
 * a process spawn costs 100–300 ms with an on-access scanner in the path. Two spawns per
 * candidate turns a twenty-repository scan from four seconds into eight, for information the
 * one call already carries — `git remote get-url` fails with "not a git repository" for a
 * directory that only *looks* like one, and with "No such remote" for a working tree that has
 * no origin. Both are answers, not errors.
 *
 * The returned URL is **not** sanitized here: `git remote get-url` prints exactly what is in
 * `.git/config`, which may be `https://user:ghp_…@github.com/o/r.git`. Sanitizing is
 * `github/remote.ts`'s job and it rebuilds the URL rather than trimming it; callers must not
 * persist or log this value directly.
 */
export async function readRemoteUrl(
  localPath: string,
  remoteName: string,
  options: GitOptions = {},
): Promise<GitRemoteRead> {
  const kind = await inspectPath(localPath);
  if (kind !== 'directory') return remoteUnavailable('not_a_git_repository', null);

  const outcome = await runGit(
    ['--no-optional-locks', 'remote', 'get-url', remoteName],
    localPath,
    options,
  );

  if (!outcome.ok) {
    if (outcome.failure === 'git_failed') {
      return NOT_A_REPOSITORY.test(outcome.stderr)
        ? remoteUnavailable('not_a_git_repository', firstLine(outcome.stderr))
        : // Any other non-zero exit from `remote get-url` on a real working tree means the
          // remote does not exist; git says "No such remote 'origin'" and exits 2.
          remoteUnavailable('no_remote', firstLine(outcome.stderr));
    }
    return remoteUnavailable(outcome.failure ?? 'git_failed', firstLine(outcome.stderr));
  }

  // A repository can be configured with an empty remote URL; that is "no remote" in practice.
  const url = outcome.stdout.split('\n')[0]?.trim() ?? '';
  if (url.length === 0) return remoteUnavailable('no_remote', null);

  return { url, unavailableReason: null, detail: null };
}

function remoteUnavailable(reason: RemoteUnavailableReason, detail: string | null): GitRemoteRead {
  return { url: null, unavailableReason: reason, detail };
}

export type PathKind = 'directory' | 'path_missing' | 'not_a_directory';

export async function inspectPath(localPath: string): Promise<PathKind> {
  try {
    const stats = await stat(localPath);
    return stats.isDirectory() ? 'directory' : 'not_a_directory';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a *component* of the path is a file, so the path cannot exist as written.
    return code === 'ENOTDIR' ? 'not_a_directory' : 'path_missing';
  }
}

function unavailable(
  reason: WorkingTreeUnavailableReason,
  detail: string | null,
): WorkingTreeStatus {
  return {
    isGitWorkingTree: false,
    currentBranch: null,
    detachedHead: false,
    headSha: null,
    uncommittedFiles: null,
    ahead: null,
    behind: null,
    unavailableReason: reason,
    detail,
  };
}

function header(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

function firstLine(stderr: string): string | null {
  const line = stderr.split('\n')[0]?.trim() ?? '';
  return line.length === 0 ? null : line.slice(0, MAX_DETAIL_LENGTH);
}
