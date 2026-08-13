import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type GitOptions,
  type GitRemoteRead,
  hasDotGitEntry,
  inspectPath,
  type PathKind,
  readRemoteUrl,
} from '../repositories/git.js';
import { classifyRemote, type GithubRemote } from './remote.js';

/**
 * The filesystem half of `POST /repositories/discover`: walk the configured discovery roots
 * (`integrations.github.discoveryRoots`, §7.2) and report every git working tree under them,
 * classified.
 *
 * **Bounded on four axes, because this runs inside a request.** An operator can put `C:\` in
 * discoveryRoots, and a scan that walks it is a scan that never returns:
 *
 *   - **depth** — `maxDepth` levels below each root (default 3, which covers
 *     `D:\Repos\{org}\{repo}`);
 *   - **breadth** — at most `maxEntriesPerDirectory` entries read from any one directory, and a
 *     denylist of directories that are never repositories but always enormous;
 *   - **count** — at most `maxCandidates` working trees, after which the scan stops and says
 *     `truncated: true` rather than quietly returning a prefix;
 *   - **time** — a wall-clock deadline for the whole scan. Every `git` invocation additionally
 *     carries its own timeout (`repositories/git.ts`), so a single stalled network share
 *     cannot hold the request open.
 *
 * A root that is a working tree itself is a candidate and is **not descended into**: registering
 * `D:\Repos\MCS` and then also its `docs/` submodule is not what the operator asked for.
 */

/** Deep enough for `root/org/repo`, shallow enough that a home directory is not a corpus. */
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_CANDIDATES = 200;
export const DEFAULT_MAX_ENTRIES_PER_DIRECTORY = 2_000;
/** The whole scan, not one directory. Chosen to stay well inside a browser's patience. */
export const DEFAULT_SCAN_DEADLINE_MS = 20_000;
/** Shorter than the general git bound: discovery makes many calls, each trivially cheap. */
export const DEFAULT_DISCOVERY_GIT_TIMEOUT_MS = 5_000;
/** How many `git remote get-url` probes run at once. Process spawns, not sockets. */
export const DEFAULT_PROBE_CONCURRENCY = 4;

/**
 * Directories that are never a repository the operator meant and are frequently the largest
 * things on disk. Matched case-insensitively on the exact directory name.
 */
const NEVER_DESCEND: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'venv',
  '.venv',
  '.pnpm-store',
  '.cache',
  '.next',
  '.turbo',
  '.gradle',
  'bin',
  'obj',
]);

export type RootStatus =
  | 'scanned'
  /** The root itself is a working tree; it was taken as a candidate and not descended. */
  | 'scanned_as_repository'
  | 'path_missing'
  | 'not_a_directory'
  | 'not_absolute'
  | 'unreadable'
  /** The scan's deadline or candidate cap was reached before this root was finished. */
  | 'truncated';

export interface RootReport {
  readonly path: string;
  readonly status: RootStatus;
  /** Working trees found under this root, before classification. */
  readonly found: number;
  readonly detail: string | null;
}

/** Why a working tree cannot become a Repository. Mirrors the API's `skipped[].reason`. */
export type CandidateProblem =
  | 'not_a_git_repository'
  | 'no_remote'
  | 'remote_not_github'
  | 'remote_unreadable';

export interface DiscoveryCandidate {
  /** Absolute native path to the working tree. */
  readonly localPath: string;
  /** `null` when `problem` is set. */
  readonly remote: GithubRemote | null;
  readonly problem: CandidateProblem | null;
  readonly detail: string | null;
}

export interface ScanResult {
  readonly roots: readonly RootReport[];
  readonly candidates: readonly DiscoveryCandidate[];
  /** A cap or the deadline stopped the scan; some working trees were not examined. */
  readonly truncated: boolean;
}

export interface ScanOptions {
  readonly git?: GitOptions | undefined;
  readonly remoteName?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxCandidates?: number | undefined;
  readonly maxEntriesPerDirectory?: number | undefined;
  readonly deadlineMs?: number | undefined;
  readonly probeConcurrency?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Injected by unit tests so the walk is exercised without a real filesystem. */
  readonly fs?: ScanFilesystem | undefined;
}

/** The two filesystem operations the walk needs, as a port so tests need no fixtures on disk. */
export interface ScanFilesystem {
  inspect(path: string): Promise<PathKind>;
  /** Directory names only, unsorted. Rejects are caught by the caller and reported. */
  listDirectories(path: string): Promise<string[]>;
  isWorkingTree(path: string): Promise<boolean>;
  readRemote(path: string, remoteName: string, git: GitOptions): Promise<GitRemoteRead>;
}

export const REAL_SCAN_FILESYSTEM: ScanFilesystem = {
  inspect: inspectPath,
  async listDirectories(path) {
    const entries = await readdir(path, { withFileTypes: true });
    // `isDirectory()` is false for a directory *symlink*, which is exactly right: following
    // them turns a bounded walk into a cycle, and a symlinked repository is reachable through
    // its real path anyway.
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  isWorkingTree: hasDotGitEntry,
  readRemote: (path, remoteName, git) => readRemoteUrl(path, remoteName, git),
};

export async function scanDiscoveryRoots(
  roots: readonly string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const fs = options.fs ?? REAL_SCAN_FILESYSTEM;
  const now = options.now ?? (() => Date.now());
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxEntries = options.maxEntriesPerDirectory ?? DEFAULT_MAX_ENTRIES_PER_DIRECTORY;
  const deadline = now() + (options.deadlineMs ?? DEFAULT_SCAN_DEADLINE_MS);
  const remoteName = options.remoteName ?? 'origin';
  const git: GitOptions = { timeoutMs: DEFAULT_DISCOVERY_GIT_TIMEOUT_MS, ...options.git };

  const reports: RootReport[] = [];
  const workingTrees: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const rawRoot of roots) {
    const root = rawRoot.trim();
    if (root.length === 0) continue;

    if (!isAbsolute(root)) {
      // F8.1: discovery roots are absolute native paths. A relative one would resolve against
      // the Backend's working directory, which is a systemd unit's idea of "here" in production.
      reports.push({ path: root, status: 'not_absolute', found: 0, detail: null });
      continue;
    }

    const normalized = resolve(root);

    if (now() >= deadline || workingTrees.length >= maxCandidates) {
      truncated = true;
      reports.push({ path: normalized, status: 'truncated', found: 0, detail: null });
      continue;
    }

    const kind = await fs.inspect(normalized);
    if (kind !== 'directory') {
      reports.push({ path: normalized, status: kind, found: 0, detail: null });
      continue;
    }

    const before = workingTrees.length;

    if (await fs.isWorkingTree(normalized)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        workingTrees.push(normalized);
      }
      reports.push({
        path: normalized,
        status: 'scanned_as_repository',
        found: workingTrees.length - before,
        detail: null,
      });
      continue;
    }

    const walk = await walkDirectory(fs, normalized, {
      depth: 0,
      maxDepth,
      maxEntries,
      deadline,
      now,
      maxCandidates,
      seen,
      workingTrees,
    });

    truncated = truncated || walk.truncated;
    reports.push({
      path: normalized,
      status: walk.error === null ? (walk.truncated ? 'truncated' : 'scanned') : 'unreadable',
      found: workingTrees.length - before,
      detail: walk.error,
    });
  }

  const candidates = await probeCandidates(fs, workingTrees, {
    remoteName,
    git,
    concurrency: options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY,
  });

  return { roots: reports, candidates, truncated };
}

interface WalkState {
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly maxCandidates: number;
  readonly seen: Set<string>;
  readonly workingTrees: string[];
}

async function walkDirectory(
  fs: ScanFilesystem,
  path: string,
  state: WalkState,
): Promise<{ truncated: boolean; error: string | null }> {
  if (state.depth >= state.maxDepth) return { truncated: false, error: null };

  let names: string[];
  try {
    names = await fs.listDirectories(path);
  } catch (error) {
    // A permission-denied subdirectory is a fact about that directory, not a failed scan.
    return { truncated: false, error: describe(error) };
  }

  let truncated = names.length > state.maxEntries;

  for (const name of names.slice(0, state.maxEntries)) {
    if (state.now() >= state.deadline || state.workingTrees.length >= state.maxCandidates) {
      return { truncated: true, error: null };
    }
    if (NEVER_DESCEND.has(name.toLowerCase())) continue;
    // `.git` itself, and every other dot-directory: none of them is a working tree the
    // operator meant, and `.git/modules` is full of things that look like one.
    if (name.startsWith('.')) continue;

    const child = join(path, name);

    if (await fs.isWorkingTree(child)) {
      if (!state.seen.has(child)) {
        state.seen.add(child);
        state.workingTrees.push(child);
      }
      // Do not descend into a working tree — see the module header.
      continue;
    }

    const nested = await walkDirectory(fs, child, { ...state, depth: state.depth + 1 });
    truncated = truncated || nested.truncated;
  }

  return { truncated, error: null };
}

async function probeCandidates(
  fs: ScanFilesystem,
  paths: readonly string[],
  options: { remoteName: string; git: GitOptions; concurrency: number },
): Promise<DiscoveryCandidate[]> {
  const results: DiscoveryCandidate[] = new Array<DiscoveryCandidate>(paths.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const path = paths[index];
      if (path === undefined) return;
      results[index] = await probeCandidate(fs, path, options);
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, paths.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return results;
}

async function probeCandidate(
  fs: ScanFilesystem,
  localPath: string,
  options: { remoteName: string; git: GitOptions },
): Promise<DiscoveryCandidate> {
  const remote = await fs.readRemote(localPath, options.remoteName, options.git);

  if (remote.url === null) {
    return {
      localPath,
      remote: null,
      problem:
        remote.unavailableReason === 'no_remote'
          ? 'no_remote'
          : remote.unavailableReason === 'not_a_git_repository'
            ? 'not_a_git_repository'
            : 'remote_unreadable',
      detail: remote.detail,
    };
  }

  const classified = classifyRemote(remote.url);

  if (classified.kind === 'github') {
    return { localPath, remote: classified.remote, problem: null, detail: null };
  }

  return {
    localPath,
    remote: null,
    problem: 'remote_not_github',
    // The HOST, never the URL: a remote URL can carry a credential and this string is
    // persisted nowhere but is returned to the client and may be logged by it.
    detail:
      classified.kind === 'other_host'
        ? `origin points at ${classified.host}, which is not github.com`
        : 'origin is not a URL Mission Control can parse',
  };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}
