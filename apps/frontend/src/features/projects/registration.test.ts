import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/index.js';
import { registrationProblem, removalProblem } from './registration.js';

/**
 * Registration failures stay distinguishable (TDS 04 §1.3 `details`).
 *
 * `POST /repositories` verifies the path before writing a row and reports *which* check failed
 * in `error.details.reason`. Collapsing those back into one "Validation failed" would throw away
 * the only part of the answer that tells the operator what to change.
 */

function validationError(reason: string, field = 'localPath'): ApiError {
  return new ApiError({
    code: 'VALIDATION_FAILED',
    message: 'localPath is not usable',
    status: 400,
    details: { field, reason },
    requestId: 'req-1',
  });
}

describe('the four distinguishable path failures', () => {
  it('names a missing path, and says whose filesystem was checked', () => {
    const problem = registrationProblem(validationError('path_missing'));
    expect(problem.message).toBe('That path does not exist on the Mission Control host.');
    expect(problem.hint).toContain('resolved on the server');
    expect(problem.field).toBe('localPath');
  });

  it('distinguishes a file from a directory', () => {
    expect(registrationProblem(validationError('not_a_directory')).message).toBe(
      'That path is a file, not a directory.',
    );
  });

  it('distinguishes "not a git working tree" from "path missing"', () => {
    const problem = registrationProblem(validationError('not_a_git_repository'));
    expect(problem.message).toBe('That directory is not a git working tree.');
    expect(problem.message).not.toBe(registrationProblem(validationError('path_missing')).message);
    expect(problem.hint).toContain('git init');
  });

  it('distinguishes "git could not be run" from "not a repository"', () => {
    const problem = registrationProblem(validationError('git_unavailable'));
    expect(problem.message).toContain('git could not be run');
    expect(problem.hint).toContain('Install git');
  });

  it('maps the two git-side failures to their own instructions', () => {
    expect(registrationProblem(validationError('timed_out')).message).toContain(
      'did not answer in time',
    );
    expect(registrationProblem(validationError('git_failed')).hint).toContain('permissions');
  });
});

describe('the duplicate-path conflict', () => {
  it('explains the conflict and carries the existing repository id', () => {
    const problem = registrationProblem(
      new ApiError({
        code: 'CONFLICT',
        message: 'That local path is already registered as a repository',
        status: 409,
        details: { field: 'localPath', localPath: 'D:\\Repos\\MCS', repositoryId: 'repo-1' },
        requestId: 'req-2',
      }),
    );

    expect(problem.message).toContain('already registered');
    expect(problem.existingRepositoryId).toBe('repo-1');
  });
});

describe('unmapped failures', () => {
  it('falls back to the server’s own message rather than a generic string', () => {
    const problem = registrationProblem(
      new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'name must be at most 200 characters',
        status: 400,
        details: { field: 'name' },
        requestId: 'req-3',
      }),
    );

    expect(problem.message).toBe('name must be at most 200 characters');
    expect(problem.field).toBe('name');
  });

  it('handles a non-ApiError without throwing', () => {
    expect(registrationProblem(new Error('boom')).message).toBe('boom');
  });
});

describe('removal conflicts', () => {
  it('says how many sessions block the removal, and why that matters', () => {
    const message = removalProblem(
      new ApiError({
        code: 'CONFLICT',
        message: 'Repository is referenced by sessions',
        status: 409,
        details: { sessions: 3 },
      }),
    );

    expect(message).toContain('3 sessions');
    expect(message).toContain('detach their history');
  });

  it('degrades gracefully when the server sent no count', () => {
    const message = removalProblem(
      new ApiError({ code: 'CONFLICT', message: 'nope', status: 409, details: null }),
    );
    expect(message).toContain('detach their history');
  });
});
