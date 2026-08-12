import { basename, isAbsolute, resolve } from 'node:path';
import { ApiError } from '../http/errors.js';
import {
  type GitOptions,
  hasDotGitEntry,
  inspectPath,
  probeWorkingTree,
  type WorkingTreeUnavailableReason,
} from './git.js';

/**
 * Registration validation — no database, so every rule below is unit-testable at the tier that
 * runs on every change (TDS 07 §1).
 *
 * The point of this file is stated in the task that produced it: a `local_path` that does not
 * exist, is not a directory, or is not a git working tree must fail with an actionable F5.4
 * error rather than being stored for later confusion. A Repository row is a *promise* that a
 * Session can be launched against that path; storing an unverifiable one moves the failure
 * from a form field to a session launch, which is the worst possible place for it.
 */

export const MAX_REPOSITORY_NAME_LENGTH = 200;
export const MAX_BRANCH_LENGTH = 255;

/** Trim, then enforce `ck_repositories_name_length` (TDS 03 §3.6). */
export function normalizeRepositoryName(name: string): string {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'name must not be empty', { field: 'name' });
  }
  if (trimmed.length > MAX_REPOSITORY_NAME_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `name must be at most ${MAX_REPOSITORY_NAME_LENGTH} characters`,
      { field: 'name' },
    );
  }

  return trimmed;
}

/**
 * F8.1 path rules: user-provided paths are stored as **absolute native paths**.
 *
 * `resolve` is applied for normalisation only (`D:\Repos\MCS\` and `D:\Repos\.\MCS` are the
 * same directory and must not become two rows against `ux_repositories_local_path`) — never to
 * turn a relative path into an absolute one against the *server's* cwd, which would silently
 * register a directory the operator never named. Relative input is rejected instead.
 */
export function normalizeLocalPath(localPath: string): string {
  const trimmed = localPath.trim();

  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'localPath must not be empty', {
      field: 'localPath',
    });
  }
  if (!isAbsolute(trimmed)) {
    throw new ApiError('VALIDATION_FAILED', 'localPath must be an absolute native path', {
      field: 'localPath',
    });
  }

  return resolve(trimmed);
}

/** The directory's own name, which is what an operator calls a repository. */
export function deriveRepositoryName(localPath: string): string {
  const derived = basename(localPath).trim();
  // A drive root or `/` has no basename; the path itself is the only honest fallback.
  return derived.length === 0
    ? localPath.slice(0, MAX_REPOSITORY_NAME_LENGTH)
    : derived.slice(0, MAX_REPOSITORY_NAME_LENGTH);
}

export function normalizeBranch(branch: string): string {
  const trimmed = branch.trim();

  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'defaultBranch must not be empty', {
      field: 'defaultBranch',
    });
  }
  if (trimmed.length > MAX_BRANCH_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `defaultBranch must be at most ${MAX_BRANCH_LENGTH} characters`,
      { field: 'defaultBranch' },
    );
  }

  return trimmed;
}

export interface WorkingTreeVerification {
  readonly ok: boolean;
  /** `null` iff `ok`. */
  readonly reason: WorkingTreeUnavailableReason | null;
  readonly detail: string | null;
}

/**
 * Is `localPath` a git working tree?
 *
 * Two checks, cheapest first, and the order is the design:
 *
 *  1. **A `.git` entry.** One `stat`, no subprocess, and it is true of every repository root —
 *     including the ones on a machine where git is not installed at all. Registration must not
 *     require a runtime dependency that reading the repository later does not.
 *  2. **`git status`.** Only reached when there is no `.git` entry, which is the case for a
 *     *subdirectory* of a repository (legitimate — `sessions.working_dir` may well be one) and
 *     for an ordinary directory (not legitimate). git is the only thing that can tell those
 *     apart, and it answers in one bounded call.
 */
export async function verifyGitWorkingTree(
  localPath: string,
  options: GitOptions = {},
): Promise<WorkingTreeVerification> {
  const kind = await inspectPath(localPath);
  if (kind !== 'directory') return { ok: false, reason: kind, detail: null };

  if (await hasDotGitEntry(localPath)) return { ok: true, reason: null, detail: null };

  const status = await probeWorkingTree(localPath, options);
  if (status.isGitWorkingTree) return { ok: true, reason: null, detail: null };

  return {
    ok: false,
    reason: status.unavailableReason ?? 'not_a_git_repository',
    detail: status.detail,
  };
}

/** `verifyGitWorkingTree`, as an F5.4 `VALIDATION_FAILED` on the `localPath` field. */
export async function assertGitWorkingTree(
  localPath: string,
  options: GitOptions = {},
): Promise<void> {
  const verification = await verifyGitWorkingTree(localPath, options);
  if (verification.ok) return;

  const reason = verification.reason ?? 'not_a_git_repository';
  throw new ApiError('VALIDATION_FAILED', registrationMessage(reason), {
    field: 'localPath',
    reason,
    ...(verification.detail === null ? {} : { detail: verification.detail }),
  });
}

/** One sentence the operator can act on, per failure. Never "invalid input". */
export function registrationMessage(reason: WorkingTreeUnavailableReason): string {
  switch (reason) {
    case 'path_missing':
      return 'localPath does not exist on this machine';
    case 'not_a_directory':
      return 'localPath is not a directory';
    case 'not_a_git_repository':
      return 'localPath is not a git working tree (no .git entry, and git does not recognise it)';
    case 'git_unavailable':
      return 'localPath has no .git entry and git could not be run to check it — install git, or point at the repository root';
    case 'timed_out':
      return 'git did not answer in time while checking localPath';
    case 'git_failed':
      return 'git could not read localPath';
  }
}
