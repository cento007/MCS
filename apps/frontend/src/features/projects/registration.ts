import {
  ApiError,
  errorMessage,
  WORKING_TREE_UNAVAILABLE_REASONS,
  type WorkingTreeUnavailableReason,
} from '../../lib/api/index.js';

/**
 * Turning a repository-registration failure into something the operator can act on.
 *
 * `POST /repositories` verifies the path **before** writing a row, and the Backend deliberately
 * distinguishes the ways it can fail — path missing, not a directory, not a git working tree,
 * git unavailable — carrying the discriminator in `error.details.reason` (F5.4 `details`).
 * Collapsing that back into "Validation failed" at the last moment would throw away the only
 * part of the answer that tells the operator what to type next, so the mapping is a pure
 * function with a test per branch.
 */

export interface RegistrationProblem {
  /** One sentence naming what is wrong with the path — or the server's message when unmapped. */
  readonly message: string;
  /** What to do about it. `null` when the message is already the whole instruction. */
  readonly hint: string | null;
  /** Which form field to attach the message to, when the server named one. */
  readonly field: string | null;
  /** Set only for the duplicate-path conflict, so the UI can offer to open the existing row. */
  readonly existingRepositoryId: string | null;
}

function reasonOf(details: Record<string, unknown> | null): WorkingTreeUnavailableReason | null {
  const reason = details?.['reason'];
  return typeof reason === 'string' &&
    (WORKING_TREE_UNAVAILABLE_REASONS as readonly string[]).includes(reason)
    ? (reason as WorkingTreeUnavailableReason)
    : null;
}

function stringOf(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The four distinguishable path failures, plus the two git-side ones, each phrased as a
 * statement about *this machine* — the operator is typing a path that Mission Control resolves
 * on the server, which on a home-server install is frequently not the machine the browser is on.
 */
export function registrationProblem(error: unknown): RegistrationProblem {
  if (!(error instanceof ApiError)) {
    return { message: errorMessage(error), hint: null, field: null, existingRepositoryId: null };
  }

  const field = stringOf(error.details, 'field');

  if (error.code === 'CONFLICT') {
    return {
      message: 'That local path is already registered as a repository.',
      hint: 'Registering the same working tree twice would give one directory two identities.',
      field: field ?? 'localPath',
      existingRepositoryId: stringOf(error.details, 'repositoryId'),
    };
  }

  const reason = reasonOf(error.details);
  if (reason === null) {
    return {
      message: errorMessage(error),
      hint: null,
      field,
      existingRepositoryId: null,
    };
  }

  return {
    ...describeReason(reason),
    field: field ?? 'localPath',
    existingRepositoryId: null,
  };
}

function describeReason(reason: WorkingTreeUnavailableReason): {
  message: string;
  hint: string | null;
} {
  switch (reason) {
    case 'path_missing':
      return {
        message: 'That path does not exist on the Mission Control host.',
        hint: 'Paths are resolved on the server, not in this browser. Check the drive letter or mount point.',
      };
    case 'not_a_directory':
      return {
        message: 'That path is a file, not a directory.',
        hint: 'Point at the repository folder itself, not at a file inside it.',
      };
    case 'not_a_git_repository':
      return {
        message: 'That directory is not a git working tree.',
        hint: 'There is no .git entry and git does not recognise it. Run git init, or point at the repository root.',
      };
    case 'git_unavailable':
      return {
        message: 'That directory has no .git entry, and git could not be run to check it.',
        hint: 'Install git on the Mission Control host, or point directly at a repository root.',
      };
    case 'timed_out':
      return {
        message: 'git did not answer in time while checking that path.',
        hint: 'A network drive or a very large untracked tree can do this. Try again, or point at a local path.',
      };
    case 'git_failed':
      return {
        message: 'git could not read that path.',
        hint: 'The path exists but git refused it — check permissions on the Mission Control host.',
      };
  }
}

/** `DELETE /repositories/{id}` refuses while Sessions reference it (409). Say which, and why. */
export function removalProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return errorMessage(error);
  if (error.code !== 'CONFLICT') return errorMessage(error);

  const sessions = error.details?.['sessions'];
  const count = typeof sessions === 'number' ? sessions : null;

  return count === null
    ? 'Sessions still reference this repository, so removing it would detach their history.'
    : `${count} session${count === 1 ? '' : 's'} still reference this repository, so removing it would detach their history.`;
}
