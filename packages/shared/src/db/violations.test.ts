import { describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  isCheckViolation,
  isUniqueViolation,
  SYNC_RUNS_ACTIVE_CONSTRAINT,
  UNIQUE_VIOLATION,
} from './violations.js';

/**
 * The shape these predicates exist for is the **wrapped** one.
 *
 * Drizzle 0.45 throws a `DrizzleQueryError` carrying the `pg` `DatabaseError` on `cause`, so a
 * check against the top-level object answers `false` for a violation that did occur. Both the
 * Backend and the Sync Worker shipped that bug independently — the worker's version rethrew a race
 * it explicitly meant to swallow, retaining a failed `obsidian.schedule` job on every start.
 *
 * So the first test here is the regression: an error whose `code` is reachable only through
 * `cause` must still be recognised.
 */

/** What `pg` raises, as far as these predicates care. */
function pgError(code: string, constraint: string): object {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
  });
}

/** What Drizzle hands the caller: the driver error, one level down on `cause`. */
function drizzleWrapped(code: string, constraint: string): Error {
  return new Error('Failed query', { cause: pgError(code, constraint) });
}

describe('unique violations are recognised through the wrapper Drizzle adds', () => {
  it('matches when the code is only reachable via cause — the bug both packages shipped', () => {
    const error = drizzleWrapped(UNIQUE_VIOLATION, SYNC_RUNS_ACTIVE_CONSTRAINT);

    // The naive check that was in `schedule.ts`, kept here to show what it answered.
    expect((error as { code?: string }).code).toBeUndefined();

    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, SYNC_RUNS_ACTIVE_CONSTRAINT)).toBe(true);
  });

  it('still matches an unwrapped driver error', () => {
    expect(isUniqueViolation(pgError(UNIQUE_VIOLATION, SYNC_RUNS_ACTIVE_CONSTRAINT))).toBe(true);
  });

  it('does not claim an unrelated index, so one guard cannot swallow another collision', () => {
    const error = drizzleWrapped(UNIQUE_VIOLATION, 'ux_sessions_runtime_session_id');

    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, SYNC_RUNS_ACTIVE_CONSTRAINT)).toBe(false);
  });

  it('does not confuse a check violation with a unique one', () => {
    const error = drizzleWrapped(CHECK_VIOLATION, 'ck_sync_runs_kind');

    expect(isUniqueViolation(error)).toBe(false);
    expect(isCheckViolation(error, 'ck_sync_runs_kind')).toBe(true);
  });

  it('walks more than one link, because the wrapper is not guaranteed to be the only one', () => {
    const nested = new Error('outer', {
      cause: new Error('middle', { cause: pgError(UNIQUE_VIOLATION, 'ux_anything') }),
    });

    expect(isUniqueViolation(nested)).toBe(true);
  });

  it('terminates on a cyclic cause rather than spinning', () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;

    expect(isUniqueViolation(a)).toBe(false);
  });

  it('answers false for the things that are not database errors at all', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(new Error('something else'))).toBe(false);
  });
});
