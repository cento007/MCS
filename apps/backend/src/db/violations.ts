import { ApiError } from '../http/errors.js';

/**
 * Reading PostgreSQL's own verdict on a failed write.
 *
 * Two constraint classes reach the API and both used to be invisible:
 *
 *  - **`23505` unique_violation** — a pre-check plus an insert is not atomic, so the loser of a
 *    race has to become a `409 CONFLICT` rather than a `500 INTERNAL`.
 *  - **`23514` check_violation** — the database's definition of a column disagrees with the
 *    value this build writes into it. That is not the caller's fault at all, and the cure is one
 *    command, so it must not be reported as "an unexpected error occurred".
 *
 * ## The lesson this module exists to keep in one place
 *
 * **Drizzle 0.45 wraps every query failure in a `DrizzleQueryError` and puts the `pg` error on
 * `cause`.** A predicate that only inspected the top-level object answered `false` for every
 * violation, which silently turned every duplicate into a 500 — the exact defect that made
 * `isUniqueViolation` aspirational when it was first written. Verified again for the check case
 * against a real database before this module was written: the thrown object is a
 * `DrizzleQueryError` whose `cause` is a `DatabaseError` carrying
 * `code: '23514'`, `constraint: 'ck_sync_runs_kind'`, `table: 'sync_runs'`.
 *
 * So the chain is walked, bounded (a cyclic `cause` cannot spin this), and every predicate here
 * goes through the same walk rather than re-learning it.
 */

/** PostgreSQL `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** PostgreSQL `check_violation`. */
const CHECK_VIOLATION = '23514';

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
 * Needed because a pre-check plus an insert is not atomic: two concurrent registrations of the
 * same `repositories.local_path` both pass the check and one of them has to become a `CONFLICT`
 * rather than an `INTERNAL`. `constraint` narrows it to the index the caller expects, so an
 * unrelated collision is not silently reported as the one the handler was guarding.
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
 * a handler that translated *any* check violation would be claiming to know why a constraint it
 * has never heard of fired. Every caller names the one it understands and lets the rest fall
 * through to `INTERNAL`, which is the honest answer for a violation nobody predicted.
 */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pgError = pgErrorOf(error, CHECK_VIOLATION);
  if (pgError === null) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

/** The `CHECK` that decides which discriminators `sync_runs` accepts (TDS 03 §4.5). */
export const SYNC_RUN_KIND_CONSTRAINT = 'ck_sync_runs_kind';

/**
 * The error for "PostgreSQL refused this `sync_runs.kind`".
 *
 * ## Why this is a 500 and not a 409
 *
 * A `409 CONFLICT` tells the caller *"the current state is in the way; change something and try
 * again"*, and on both routes that insert a run (`POST /memory-items/backfill`,
 * `POST /sync-runs`) a 409 already means one specific thing: **a run is already active**, decided
 * by `ux_sync_runs_active`. Reusing it here would make two situations with opposite remedies —
 * *wait for the run to finish* versus *migrate the database* — indistinguishable to any client
 * that branches on the status or the code. The request itself was perfectly valid; nothing the
 * caller can send makes this succeed. That is a server fault, so it is a 5xx.
 *
 * ## Why its own code rather than `INTERNAL`
 *
 * `INTERNAL` is defined as *"unhandled error; disclose nothing beyond the requestId"* (§1.3, and
 * the fall-through arm of the error handler behaves exactly that way). This condition is the
 * opposite: it is fully understood and one command fixes it. It is also the concrete reason the
 * code matters — the SPA maps `INTERNAL` to the fixed string *"Mission Control hit an unexpected
 * error."* and never shows the server's message, while an unrecognised code falls through to
 * `error.message` verbatim (`apps/frontend/src/lib/api/errors.ts`). Under `INTERNAL` the
 * actionable sentence below would be written and then thrown away by the only client that reads
 * it.
 *
 * `503 RUNTIME_UNAVAILABLE` was rejected too: 503 promises that waiting helps, and a database
 * that is behind on migrations does not heal on its own.
 *
 * ## Why the message stops short of asserting a missing migration
 *
 * It cannot be known from the error alone. What *is* known is stated: which value was rejected,
 * by which constraint, and that the value is a compile-time constant of this build rather than
 * anything the caller sent — so the disagreement is between the schema and the code, not between
 * the code and the request. A pending migration is named as the usual cause, with the command
 * that settles it either way.
 */
export function syncRunKindRejected(kind: string): ApiError {
  return new ApiError(
    'DATABASE_SCHEMA_MISMATCH',
    `The database rejected this run: sync_runs.kind = '${kind}' violates the CHECK constraint ` +
      `${SYNC_RUN_KIND_CONSTRAINT}. That value is a constant in this build, not something the ` +
      'request supplied, so the database schema is not the one this code expects. The usual ' +
      'cause is a pending migration — run `pnpm db:migrate` and try again.',
    { constraint: SYNC_RUN_KIND_CONSTRAINT, table: 'sync_runs', column: 'kind', value: kind },
  );
}
