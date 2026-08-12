import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import {
  assertGitWorkingTree,
  deriveRepositoryName,
  normalizeBranch,
  normalizeLocalPath,
  normalizeRepositoryName,
  registrationMessage,
  verifyGitWorkingTree,
} from './validation.js';

/**
 * Registration validation with **no database and no Fastify** (TDS 07 §1).
 *
 * The rule being protected: a `local_path` that does not exist, is not a directory, or is not
 * a git working tree must be refused at the boundary with an F5.4 error naming the field —
 * never stored and rediscovered at session launch.
 */

const temporaryPaths: string[] = [];

afterAll(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

/** The error the API would actually return, for the assertion to read. */
async function captureApiError(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError, but the call succeeded');
}

describe('normalizeLocalPath (F8.1 path rules)', () => {
  it('rejects a relative path instead of resolving it against the server cwd', async () => {
    const error = await captureApiError(
      Promise.resolve().then(() => normalizeLocalPath('some/relative/path')),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(400);
    expect(error.details).toMatchObject({ field: 'localPath' });
  });

  it('rejects an empty path', async () => {
    const error = await captureApiError(Promise.resolve().then(() => normalizeLocalPath('   ')));
    expect(error.details).toMatchObject({ field: 'localPath' });
  });

  it('normalises so one directory cannot become two rows', () => {
    const directory = temporaryDirectory('mc-path-');

    // Trailing separator and a `.` segment name the same directory; the unique index on
    // `local_path` only means anything if they normalise to one string.
    expect(normalizeLocalPath(`${directory}${sep}`)).toBe(resolve(directory));
    expect(normalizeLocalPath(join(directory, '.'))).toBe(resolve(directory));
    expect(normalizeLocalPath(`  ${directory}  `)).toBe(resolve(directory));
  });
});

describe('deriveRepositoryName', () => {
  it('uses the directory name — what the operator calls the repository', () => {
    expect(deriveRepositoryName(join('D:', sep, 'Repos', 'MCS'))).toBe('MCS');
  });

  it('falls back to the path when there is no basename', () => {
    // A drive root or `/` — no basename, and an empty name would violate the CHECK.
    expect(deriveRepositoryName(sep).length).toBeGreaterThan(0);
  });
});

describe('normalizeRepositoryName / normalizeBranch', () => {
  it('trims before enforcing the length CHECK', () => {
    expect(normalizeRepositoryName('  MCS  ')).toBe('MCS');
    expect(normalizeBranch('  DEV\n')).toBe('DEV');
  });

  it('rejects whitespace-only values on the field that caused them', async () => {
    const name = await captureApiError(
      Promise.resolve().then(() => normalizeRepositoryName('   ')),
    );
    const branch = await captureApiError(Promise.resolve().then(() => normalizeBranch('   ')));

    expect(name.details).toMatchObject({ field: 'name' });
    expect(branch.details).toMatchObject({ field: 'defaultBranch' });
  });

  it('rejects a name past the 200-character column bound', async () => {
    const error = await captureApiError(
      Promise.resolve().then(() => normalizeRepositoryName('x'.repeat(201))),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
  });
});

describe('verifyGitWorkingTree', () => {
  it('accepts a directory containing a .git entry without running git at all', async () => {
    const directory = temporaryDirectory('mc-verify-repo-');
    await mkdir(join(directory, '.git'));

    // An executable that does not exist: if this passes, nothing was spawned. Registration
    // must not require git on a machine where reading the repository later does not.
    const verification = await verifyGitWorkingTree(directory, {
      executable: 'mc-git-that-is-not-installed',
    });

    expect(verification.ok).toBe(true);
    expect(verification.reason).toBeNull();
  });

  it('accepts a .git *file* — a linked worktree or submodule is still a working tree', async () => {
    const directory = temporaryDirectory('mc-verify-worktree-');
    writeFileSync(join(directory, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');

    const verification = await verifyGitWorkingTree(directory, {
      executable: 'mc-git-that-is-not-installed',
    });

    expect(verification.ok).toBe(true);
  });

  it('rejects a path that does not exist', async () => {
    const missing = join(temporaryDirectory('mc-verify-missing-'), 'nowhere');

    const verification = await verifyGitWorkingTree(missing);

    expect(verification.ok).toBe(false);
    expect(verification.reason).toBe('path_missing');
  });

  it('rejects a file', async () => {
    const directory = temporaryDirectory('mc-verify-file-');
    const file = join(directory, 'repo.txt');
    writeFileSync(file, 'not a directory\n');

    const verification = await verifyGitWorkingTree(file);

    expect(verification.ok).toBe(false);
    expect(verification.reason).toBe('not_a_directory');
  });

  it('rejects an ordinary directory', async () => {
    const verification = await verifyGitWorkingTree(temporaryDirectory('mc-verify-plain-'));

    expect(verification.ok).toBe(false);
    // `not_a_git_repository` when git answered; `git_unavailable` on a machine with no git.
    // Either way it is refused — which is the property under test.
    expect(['not_a_git_repository', 'git_unavailable']).toContain(verification.reason);
  }, 30_000);
});

describe('assertGitWorkingTree', () => {
  it('raises VALIDATION_FAILED on localPath with an actionable reason', async () => {
    const missing = join(temporaryDirectory('mc-assert-'), 'nowhere');

    const error = await captureApiError(assertGitWorkingTree(missing));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(400);
    expect(error.details).toMatchObject({ field: 'localPath', reason: 'path_missing' });
    expect(error.message).toBe(registrationMessage('path_missing'));
  });

  it('says something specific for every reason it can report', () => {
    for (const reason of [
      'path_missing',
      'not_a_directory',
      'not_a_git_repository',
      'git_unavailable',
      'timed_out',
      'git_failed',
    ] as const) {
      const message = registrationMessage(reason);
      expect(message.length).toBeGreaterThan(10);
      // "Invalid input" is not an answer an operator can act on.
      expect(message).not.toMatch(/^invalid/i);
    }
  });
});
