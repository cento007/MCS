/**
 * Reading PostgreSQL's own verdict on a failed write.
 *
 * ## The lesson this module exists to keep in one place
 *
 * **Drizzle 0.45 wraps every query failure in a `DrizzleQueryError` and puts the `pg` error on
 * `cause`.** A predicate that only inspects the top-level object answers `false` for every
 * violation — which turns a duplicate the caller was *ready for* into an unhandled error.
 *
 * That has now been paid for twice. The Backend hit it first (`isUniqueViolation` was
 * aspirational when written: every duplicate silently became a 500) and fixed it locally. The
 * Sync Worker then hit the identical bug in `schedule.ts`, whose `#trigger` explicitly catches
 * `23505` because "a manual trigger won the race" is an expected outcome — but the guard read
 * `error.code`, so it never matched, the tick threw, and every start of the worker left a failed
 * `obsidian.schedule` job behind. It was visible only as a red count on the Dashboard, three days
 * after the fact.
 *
 * Two packages learning the same thing separately is the argument for this living in `shared`
 * rather than in either of them. The chain is walked, bounded (a cyclic `cause` cannot spin this),
 * and every predicate here goes through the same walk rather than re-deriving it.
 */

/** PostgreSQL `unique_violation`. */
export const UNIQUE_VIOLATION = '23505';
/** PostgreSQL `check_violation`. */
export const CHECK_VIOLATION = '23514';

interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
}

/** The first link in the `cause` chain carrying `sqlstate`, or `null`. Depth-bounded. */
function pgErrorOf(error: unknown, sqlstate: string): PgErrorLike | null {
  for (let candidate = error, depth = 0; depth < 5; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return null;

    const pgError = candidate as PgErrorLike;
    if (pgError.code === sqlstate) return pgError;
    if (pgError.cause === undefined) return null;
    candidate = pgError.cause;
  }

  return null;
}

/**
 * Is this error PostgreSQL rejecting a duplicate against a unique index?
 *
 * Needed because a pre-check plus an insert is not atomic: two concurrent writers both pass the
 * check and one of them has to be handled rather than thrown. `constraint` narrows it to the index
 * the caller expects, so an unrelated collision is not silently treated as the one being guarded.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = pgErrorOf(error, UNIQUE_VIOLATION);
  if (pgError === null) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

/**
 * Is this error PostgreSQL rejecting a value against a `CHECK` constraint?
 *
 * `constraint` is effectively mandatory in practice even though it is optional in the signature:
 * a caller that translated *any* check violation would be claiming to know why a constraint it has
 * never heard of fired. Every caller names the one it understands and lets the rest fall through,
 * which is the honest answer for a violation nobody predicted.
 */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pgError = pgErrorOf(error, CHECK_VIOLATION);
  if (pgError === null) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

/** The partial unique index admitting one non-terminal `sync_runs` row per `kind`. */
export const SYNC_RUNS_ACTIVE_CONSTRAINT = 'ux_sync_runs_active';
