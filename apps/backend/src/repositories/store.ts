import { type Db, type DbTransaction, type EntityId, newId, schema } from '@mc/shared';
import { and, asc, count, desc, eq, gt, lt, sql } from 'drizzle-orm';

/**
 * All `repositories` access, in one module (TDS 03 §3.6).
 *
 * Named `store.ts` rather than `repository.ts` — the convention `sessions/` uses — because in
 * *this* module "Repository" is the domain entity (F4.1), so a file called `repository.ts`
 * would be ambiguous by construction.
 */

export type RepositoryRow = typeof schema.repositories.$inferSelect;
export type DbLike = Db | DbTransaction;

export interface ListRepositoriesFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  /** Opaque cursor's decoded ordering key — the UUIDv7 `id` (TDS 04 §1.2). */
  readonly afterId?: string;
  /** TDS 04 §5.1's `?projectId=`. Absent means "every Repository, assigned or not". */
  readonly projectId?: string;
}

export interface InsertRepositoryInput {
  readonly id?: EntityId;
  readonly projectId?: string | null;
  readonly name: string;
  readonly localPath: string;
  readonly defaultBranch?: string;
}

export interface UpdateRepositoryInput {
  readonly projectId?: string | null;
  readonly name?: string;
  readonly defaultBranch?: string;
}

export async function findRepositoryById(db: DbLike, id: string): Promise<RepositoryRow | null> {
  const rows = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findRepositoryByLocalPath(
  db: DbLike,
  localPath: string,
): Promise<RepositoryRow | null> {
  const rows = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.localPath, localPath))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRepositories(
  db: DbLike,
  filters: ListRepositoriesFilters,
): Promise<RepositoryRow[]> {
  const conditions = [];
  if (filters.projectId !== undefined) {
    conditions.push(eq(schema.repositories.projectId, filters.projectId));
  }
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.repositories.id, filters.afterId)
        : gt(schema.repositories.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.repositories)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(filters.order === 'desc' ? desc(schema.repositories.id) : asc(schema.repositories.id))
    .limit(filters.limit);
}

/**
 * Insert a Repository.
 *
 * `sync_status` is left at its `never` default and `last_synced_at` at NULL: Phase 1
 * registration touches no remote (TDS 04 §5.1's `/sync` is a separate job), and claiming `ok`
 * for a repository nothing has ever synced would make the badge a lie on day one.
 */
export async function insertRepository(
  db: DbLike,
  input: InsertRepositoryInput,
): Promise<RepositoryRow> {
  const rows = await db
    .insert(schema.repositories)
    .values({
      id: input.id ?? newId(),
      projectId: input.projectId ?? null,
      name: input.name,
      localPath: input.localPath,
      ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Repository insert returned no row');
  return row;
}

export async function updateRepository(
  db: DbLike,
  id: string,
  update: UpdateRepositoryInput,
): Promise<RepositoryRow | null> {
  const rows = await db
    .update(schema.repositories)
    .set({
      ...('projectId' in update ? { projectId: update.projectId ?? null } : {}),
      ...(update.name === undefined ? {} : { name: update.name }),
      ...(update.defaultBranch === undefined ? {} : { defaultBranch: update.defaultBranch }),
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, id))
    .returning();

  return rows[0] ?? null;
}

/**
 * The columns a GitHub sync owns (TDS 03 §3.6), written in one statement.
 *
 * Split from `UpdateRepositoryInput` on purpose: those fields are the operator's (`name`,
 * `projectId`), these are the poller's. Keeping them in separate inputs is what stops a sync
 * from being able to overwrite a name the operator chose, and stops `PATCH /repositories/{id}`
 * from being able to fake a successful sync.
 */
export interface UpdateRepositorySyncInput {
  readonly remoteUrl?: string | null;
  readonly visibility?: string;
  readonly defaultBranch?: string;
  readonly lastPolledSha?: string | null;
  /** Only ever set to the time of a **successful** sync (§3.6: "Last *successful* sync"). */
  readonly lastSyncedAt?: Date;
  readonly syncStatus?: 'ok' | 'failed' | 'never';
  readonly lastSyncError?: string | null;
}

export async function updateRepositorySync(
  db: DbLike,
  id: string,
  update: UpdateRepositorySyncInput,
): Promise<RepositoryRow | null> {
  const rows = await db
    .update(schema.repositories)
    .set({
      ...('remoteUrl' in update ? { remoteUrl: update.remoteUrl ?? null } : {}),
      ...(update.visibility === undefined ? {} : { visibility: update.visibility }),
      ...(update.defaultBranch === undefined ? {} : { defaultBranch: update.defaultBranch }),
      ...('lastPolledSha' in update ? { lastPolledSha: update.lastPolledSha ?? null } : {}),
      ...(update.lastSyncedAt === undefined ? {} : { lastSyncedAt: update.lastSyncedAt }),
      ...(update.syncStatus === undefined ? {} : { syncStatus: update.syncStatus }),
      ...('lastSyncError' in update ? { lastSyncError: update.lastSyncError ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, id))
    .returning();

  return rows[0] ?? null;
}

/**
 * Repositories the polling producer should consider this tick, oldest cursor first.
 *
 * `last_synced_at IS NULL FIRST` is the ordering that matters: a freshly discovered repository
 * has never been synced and would otherwise sit behind every repository that has, forever.
 * There is no index on `last_synced_at` and none is wanted — TDS 03 §3.6 states this table
 * holds tens of rows in V1 and the Repositories view already reads all of them.
 */
export async function listRepositoriesForPoll(
  db: DbLike,
  filters: { readonly limit: number },
): Promise<RepositoryRow[]> {
  return db
    .select()
    .from(schema.repositories)
    .orderBy(sql`${schema.repositories.lastSyncedAt} ASC NULLS FIRST`, asc(schema.repositories.id))
    .limit(filters.limit);
}

export async function deleteRepository(db: DbLike, id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.repositories)
    .where(eq(schema.repositories.id, id))
    .returning({ id: schema.repositories.id });
  return rows.length > 0;
}

/** How many Sessions still reference this Repository (`ON DELETE SET NULL`, TDS 03 §3.9). */
export async function countRepositorySessions(db: DbLike, id: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(schema.sessions)
    .where(eq(schema.sessions.repositoryId, id));
  return Number(rows[0]?.total ?? 0);
}

export async function projectExists(db: DbLike, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return rows.length > 0;
}
