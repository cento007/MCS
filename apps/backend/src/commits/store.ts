import { type Db, type DbTransaction, schema } from '@mc/shared';
import { and, asc, desc, eq, gt, lt, or, type SQL } from 'drizzle-orm';
import type { CommitCursor } from './cursors.js';

/**
 * Every **read** of `commits` the API serves (TDS 03 §3.7).
 *
 * Writes stay in `github/store.ts`: the sync is the only writer of this table in Phase 1, its
 * insert is idempotent by construction (`ON CONFLICT (repository_id, sha) DO NOTHING`), and
 * `commit.recorded` is emitted from exactly that returned set. Reading and writing from one
 * module would put an API list one careless import away from being able to write history.
 */

export type CommitRow = typeof schema.commits.$inferSelect;
export type DbLike = Db | DbTransaction;

export interface ListCommitsFilters {
  readonly limit: number;
  /** `desc` = newest `committedAt` first, the §5.2/§6.10.1 default. */
  readonly order: 'asc' | 'desc';
  /** `GET /repositories/{id}/commits` scopes to one Repository. */
  readonly repositoryId?: string;
  /** §5.2's `?sessionId=`, and the whole of §6.10.1's scope. */
  readonly sessionId?: string;
  /** §5.2's `?branch=`. `commits.branch` is nullable, so this can only ever match rows that set it. */
  readonly branch?: string;
  /** Decoded opaque cursor — the `(committedAt, id)` pair (`cursors.ts`). */
  readonly after?: CommitCursor;
}

/**
 * One page of commits, keyset-paginated on `(committed_at, id)`.
 *
 * The `desc` path rides `ix_commits_repository_committed_at` (`(repository_id, committed_at
 * DESC)`) when a repository is given; the session-scoped path rides `ix_commits_session_id` and
 * sorts a handful of rows, which §6.10.1 explicitly accepts rather than widening that index.
 */
export async function listCommits(db: DbLike, filters: ListCommitsFilters): Promise<CommitRow[]> {
  const conditions: SQL[] = [];

  if (filters.repositoryId !== undefined) {
    conditions.push(eq(schema.commits.repositoryId, filters.repositoryId));
  }
  if (filters.sessionId !== undefined) {
    conditions.push(eq(schema.commits.sessionId, filters.sessionId));
  }
  if (filters.branch !== undefined) {
    conditions.push(eq(schema.commits.branch, filters.branch));
  }

  const boundary = keysetBoundary(filters);
  if (boundary !== undefined) conditions.push(boundary);

  const ordering =
    filters.order === 'desc'
      ? [desc(schema.commits.committedAt), desc(schema.commits.id)]
      : [asc(schema.commits.committedAt), asc(schema.commits.id)];

  return db
    .select()
    .from(schema.commits)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(...ordering)
    .limit(filters.limit);
}

/**
 * "Strictly after the cursor row in the requested order", spelled out as the two-column
 * comparison PostgreSQL can use the index for.
 *
 * A row-value comparison (`(committed_at, id) < (…, …)`) would read better, but Drizzle has no
 * portable spelling for it and the expanded form is what the planner sees either way.
 */
function keysetBoundary(filters: ListCommitsFilters): SQL | undefined {
  if (filters.after === undefined) return undefined;
  const { committedAt, id } = filters.after;

  return filters.order === 'desc'
    ? or(
        lt(schema.commits.committedAt, committedAt),
        and(eq(schema.commits.committedAt, committedAt), lt(schema.commits.id, id)),
      )
    : or(
        gt(schema.commits.committedAt, committedAt),
        and(eq(schema.commits.committedAt, committedAt), gt(schema.commits.id, id)),
      );
}

export async function findCommitById(db: DbLike, id: string): Promise<CommitRow | null> {
  const rows = await db.select().from(schema.commits).where(eq(schema.commits.id, id)).limit(1);
  return rows[0] ?? null;
}
