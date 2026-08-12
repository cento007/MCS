import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStatusPorcelainV2, probeWorkingTree, runGit } from './git.js';

/**
 * The git probe (TDS 06 §5.4.1 / WC11), with **no database and no Fastify** — a real
 * temporary repository on disk is the only fixture, because the thing under test is what git
 * actually prints, not what we imagine it prints.
 *
 * The three properties `git.ts` claims, each with a test that fails if it stops being true:
 *   - bounded: a child that never exits is killed, and the call returns, in ~a timeout;
 *   - total: "no git", "not a repository", "no such path" are values, not exceptions;
 *   - cross-platform: nothing below branches on `process.platform`, and every path is built
 *     with `node:path` against the OS temp root (TDS 07 §4).
 */

/**
 * Every case that spawns git gets this instead of the 5 s default. A `git` process costs
 * hundreds of milliseconds to start on Windows and more on a cold CI runner, and a fixture
 * that flakes on timing teaches the team to ignore the suite.
 */
const GIT_TEST_TIMEOUT_MS = 30_000;

const temporaryPaths: string[] = [];

/** Determined before collection so the git-dependent cases can be skipped, not failed. */
const gitAvailable = (await runGit(['--version'], tmpdir())).ok;

afterAll(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const outcome = await runGit(args, cwd, { timeoutMs: 30_000 });
  if (!outcome.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr || outcome.stdout}`);
  }
}

/**
 * A real repository with one commit on `main`.
 *
 * Identity and signing are set per-repository with `git config`, never globally: a test that
 * writes to the developer's `~/.gitconfig` is a test that changed their machine.
 */
async function createRepository(): Promise<string> {
  const directory = temporaryDirectory('mc-git-repo-');

  await git(['init', '--initial-branch=main'], directory);
  await git(['config', 'user.email', 'tests@mission-control.invalid'], directory);
  await git(['config', 'user.name', 'Mission Control Tests'], directory);
  await git(['config', 'commit.gpgsign', 'false'], directory);

  writeFileSync(join(directory, 'README.md'), '# fixture\n');
  await git(['add', '.'], directory);
  await git(['commit', '-m', 'initial'], directory);

  return directory;
}

/**
 * Built once, then **copied** per test rather than rebuilt.
 *
 * Six `git` spawns cost seconds on Windows, which is enough to blow the default per-test
 * timeout on its own — and a fixture that is slow enough to time out gets deleted rather than
 * maintained. A directory copy of an already-initialised repository is a byte-for-byte
 * independent repository, so isolation is not traded away for the speed.
 */
let templateRepository: string | null = null;

beforeAll(async () => {
  if (!gitAvailable) return;
  templateRepository = await createRepository();
}, 120_000);

function freshRepository(): string {
  if (templateRepository === null) throw new Error('template repository was not created');
  const directory = temporaryDirectory('mc-git-copy-');
  cpSync(templateRepository, directory, { recursive: true });
  return directory;
}

describe('probeWorkingTree — a real repository', () => {
  it.skipIf(!gitAvailable)(
    'reads branch, HEAD and a clean tree',
    async () => {
      const directory = freshRepository();

      const status = await probeWorkingTree(directory);

      expect(status.isGitWorkingTree).toBe(true);
      expect(status.currentBranch).toBe('main');
      expect(status.detachedHead).toBe(false);
      expect(status.uncommittedFiles).toBe(0);
      expect(status.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(status.unavailableReason).toBeNull();
      // No upstream in a local-only fixture — `null`, not a fabricated zero.
      expect(status.ahead).toBeNull();
      expect(status.behind).toBeNull();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it.skipIf(!gitAvailable)(
    'counts modified, staged and untracked entries alike',
    async () => {
      const directory = freshRepository();

      writeFileSync(join(directory, 'README.md'), '# fixture\nchanged\n'); // modified, unstaged
      writeFileSync(join(directory, 'staged.txt'), 'staged\n');
      await git(['add', 'staged.txt'], directory); // staged
      writeFileSync(join(directory, 'untracked.txt'), 'untracked\n'); // untracked

      const status = await probeWorkingTree(directory);

      expect(status.isGitWorkingTree).toBe(true);
      expect(status.uncommittedFiles).toBe(3);
      expect(status.currentBranch).toBe('main');
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it.skipIf(!gitAvailable)(
    'reports the branch the tree is on, not its default',
    async () => {
      const directory = freshRepository();
      await git(['checkout', '-b', 'feature/launch-modal'], directory);

      const status = await probeWorkingTree(directory);

      // The whole point of WC11: `main` is what the Repository row says, `feature/…` is the
      // truth the operator is about to have overwritten.
      expect(status.currentBranch).toBe('feature/launch-modal');
      expect(status.detachedHead).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it.skipIf(!gitAvailable)(
    'reports a detached HEAD as detached, with no branch',
    async () => {
      const directory = freshRepository();
      await git(['checkout', '--detach'], directory);

      const status = await probeWorkingTree(directory);

      expect(status.detachedHead).toBe(true);
      expect(status.currentBranch).toBeNull();
      expect(status.isGitWorkingTree).toBe(true);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe('probeWorkingTree — the answers that are not a working tree', () => {
  it.skipIf(!gitAvailable)(
    'reports an ordinary directory as not_a_git_repository',
    async () => {
      const status = await probeWorkingTree(temporaryDirectory('mc-git-plain-'));

      expect(status.isGitWorkingTree).toBe(false);
      expect(status.unavailableReason).toBe('not_a_git_repository');
      expect(status.uncommittedFiles).toBeNull();
      expect(status.currentBranch).toBeNull();
      // git's own words, so the operator sees what git said rather than our paraphrase.
      expect(status.detail).toMatch(/not a git repository/i);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it('reports a path that does not exist as path_missing', async () => {
    const status = await probeWorkingTree(join(temporaryDirectory('mc-git-gone-'), 'nowhere'));

    expect(status.unavailableReason).toBe('path_missing');
    expect(status.isGitWorkingTree).toBe(false);
  });

  it('reports a file as not_a_directory', async () => {
    const directory = temporaryDirectory('mc-git-file-');
    const file = join(directory, 'not-a-repo.txt');
    writeFileSync(file, 'plain file\n');

    const status = await probeWorkingTree(file);

    expect(status.unavailableReason).toBe('not_a_directory');
  });

  it('reports a missing git executable as git_unavailable, never as a crash', async () => {
    const status = await probeWorkingTree(temporaryDirectory('mc-git-nogit-'), {
      executable: 'mc-git-that-is-not-installed',
    });

    expect(status.unavailableReason).toBe('git_unavailable');
    expect(status.isGitWorkingTree).toBe(false);
    expect(status.uncommittedFiles).toBeNull();
  });
});

describe('bounded invocation', () => {
  it('kills a child that will not exit and returns timed_out', async () => {
    const started = Date.now();

    // Not git: a process that is *guaranteed* to outlive the bound, which is the only honest
    // way to test the bound. `execFile` runs it with no shell, exactly as it runs git.
    const outcome = await runGit(['-e', 'setTimeout(() => {}, 60_000)'], tmpdir(), {
      executable: process.execPath,
      timeoutMs: 250,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('timed_out');
    // The bound is a bound, not a suggestion: this must not have waited out the 60 s child.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.skipIf(!gitAvailable)(
    'applies the same bound to a real repository probe',
    async () => {
      const directory = freshRepository();

      const status = await probeWorkingTree(directory, { timeoutMs: 1 });

      expect(status.isGitWorkingTree).toBe(false);
      expect(status.unavailableReason).toBe('timed_out');
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe('parseStatusPorcelainV2', () => {
  it('parses branch, oid and ahead/behind from the header block', () => {
    const parsed = parseStatusPorcelainV2(
      [
        '# branch.oid 5d41402abc4b2a76b9719d911017c592abcdef01',
        '# branch.head DEV',
        '# branch.upstream origin/DEV',
        '# branch.ab +2 -3',
        '',
      ].join('\n'),
    );

    expect(parsed.currentBranch).toBe('DEV');
    expect(parsed.headSha).toBe('5d41402abc4b2a76b9719d911017c592abcdef01');
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(3);
    expect(parsed.uncommittedFiles).toBe(0);
  });

  it('counts one entry per line across every entry kind', () => {
    const parsed = parseStatusPorcelainV2(
      [
        '# branch.oid (initial)',
        '# branch.head main',
        '1 .M N... 100644 100644 100644 aaa bbb README.md',
        '2 R. N... 100644 100644 100644 ccc ddd R100 new.ts\told.ts',
        'u UU N... 100644 100644 100644 100644 eee fff ggg conflict.ts',
        '? untracked.ts',
      ].join('\n'),
    );

    // A rename is one entry even though it names two paths — the `\t` keeps it on one line.
    expect(parsed.uncommittedFiles).toBe(4);
    // A repository with no commits has no HEAD; that is `(initial)`, not an error.
    expect(parsed.headSha).toBeNull();
    expect(parsed.currentBranch).toBe('main');
  });

  it('maps (detached) to detachedHead with no branch name', () => {
    const parsed = parseStatusPorcelainV2('# branch.oid abc\n# branch.head (detached)\n');

    expect(parsed.detachedHead).toBe(true);
    expect(parsed.currentBranch).toBeNull();
  });

  it('tolerates CRLF without gluing a carriage return to the branch name', () => {
    const parsed = parseStatusPorcelainV2('# branch.head main\r\n? file.ts\r\n');

    expect(parsed.currentBranch).toBe('main');
    expect(parsed.uncommittedFiles).toBe(1);
  });
});
