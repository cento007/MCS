import { type Db, type DbTransaction, type EntityId, newId, schema } from '@mc/shared';
import { and, asc, count, desc, eq, gt, lt } from 'drizzle-orm';

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
