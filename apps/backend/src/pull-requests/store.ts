import { type Db, type DbTransaction, schema } from '@mc/shared';
import { and, desc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { PullRequestCursor } from './cursors.js';

/**
 * Every **read** of `pull_requests` the API serves (TDS 03 §3.8).
 *
 * Writes stay in `github/store.ts` (`upsertPullRequest`) — §5.3 is explicit that
 * `pull-requests` is **read-only in Phase 1**: assisted-mode PR actions are deferred to Phase 2
 * (sanctioned deviation D8), so this module has no insert, no update and no delete to offer.
 */

export type PullRequestRow = typeof schema.pullRequests.$inferSelect;
export type DbLike = Db | DbTransaction;

export interface ListPullRequestsFilters {
  readonly limit: number;
  /** §5.3's `?repositoryId=`, and the whole scope of the nested route. */
  readonly repositoryId?: string;
  /** §5.3's `?state=` — GitHub truth (arbitration A3): `open`/`merged`/`closed`/`draft`. */
  readonly state?: string;
  /** Decoded opaque cursor — the `(openedAt, id)` pair (`cursors.ts`). */
  readonly after?: PullRequestCursor;
}

/**
 * One page of pull requests, newest-opened first, keyset-paginated on `(opened_at, id)`.
 *
 * `ix_pull_requests_repository_state` covers the `(repositoryId, state)` filter — the
 * "OPEN PRs" column of the Repositories table (TDS 06 §5.3.2) is exactly that lookup. The sort
 * is a small in-memory one on top: TDS 03 §3.8 adds no `opened_at` index, this table holds
 * tens of rows per repository in V1, and widening the index would tax the sync's upsert path
 * for no measurable read gain (the same trade §6.10.1 records for Session commits).
 */
export async function listPullRequests(
  db: DbLike,
  filters: ListPullRequestsFilters,
): Promise<PullRequestRow[]> {
  const conditions: SQL[] = [];

  if (filters.repositoryId !== undefined) {
    conditions.push(eq(schema.pullRequests.repositoryId, filters.repositoryId));
  }
  if (filters.state !== undefined) {
    conditions.push(eq(schema.pullRequests.state, filters.state));
  }

  const boundary = keysetBoundary(filters.after);
  if (boundary !== undefined) conditions.push(boundary);

  return (
    db
      .select()
      .from(schema.pullRequests)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      // NULLS LAST is the half of this that the cursor has to agree with: a PR GitHub gave no
      // `created_at` sorts after every dated one, in both the ORDER BY and the predicate below.
      .orderBy(sql`${schema.pullRequests.openedAt} DESC NULLS LAST`, desc(schema.pullRequests.id))
      .limit(filters.limit)
  );
}

/** "Strictly after the cursor row" under `opened_at DESC NULLS LAST, id DESC`. */
function keysetBoundary(after: PullRequestCursor | undefined): SQL | undefined {
  if (after === undefined) return undefined;

  // The cursor row itself has no `opened_at`, so everything before it is already gone: only
  // later undated rows remain.
  if (after.openedAt === null) {
    return and(isNull(schema.pullRequests.openedAt), lt(schema.pullRequests.id, after.id));
  }

  return or(
    lt(schema.pullRequests.openedAt, after.openedAt),
    and(eq(schema.pullRequests.openedAt, after.openedAt), lt(schema.pullRequests.id, after.id)),
    // Undated rows sort after every dated one, so they are always still ahead.
    isNull(schema.pullRequests.openedAt),
  );
}

export async function findPullRequestById(db: DbLike, id: string): Promise<PullRequestRow | null> {
  const rows = await db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
}
