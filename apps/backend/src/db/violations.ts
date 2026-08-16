import { isCheckViolation, isUniqueViolation } from '@mc/shared';
import { ApiError } from '../http/errors.js';

/**
 * Turning PostgreSQL's verdict on a failed write into an API answer.
 *
 * Two constraint classes reach the API and both used to be invisible:
 *
 *  - **`23505` unique_violation** — a pre-check plus an insert is not atomic, so the loser of a
 *    race has to become a `409 CONFLICT` rather than a `500 INTERNAL`.
 *  - **`23514` check_violation** — the database's definition of a column disagrees with the
 *    value this build writes into it. That is not the caller's fault at all, and the cure is one
 *    command, so it must not be reported as "an unexpected error occurred".
 *
 * **The predicates themselves now live in `@mc/shared`** (`db/violations.ts`) and are re-exported
 * here so every existing import keeps working. They moved because the Sync Worker independently
 * rediscovered the trap they exist to close — Drizzle wraps the `pg` error on `cause`, so a
 * top-level `error.code` check never matches — and a lesson two packages learn separately belongs
 * in neither of them. What stays here is the part that is genuinely the Backend's: the mapping
 * from a violation to an `ApiError`.
 */

export { isCheckViolation, isUniqueViolation };

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
