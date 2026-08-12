import { type Db, type DbTransaction, type EntityId, newId, schema } from '@mc/shared';
import { and, asc, count, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';

/**
 * All `projects` (and the single default `workspaces` row) access, in one module
 * (TDS 03 §3.4–§3.5).
 *
 * **`status` and `archived_at` move together, and only here.** TDS 03 §3.5 gives `projects`
 * both a `status` CHECK (`active`|`archived`) and an `archived_at` timestamp, while TDS 04 §4
 * exposes only `archivedAt`. Two representations of one fact drift the moment two writers
 * exist, so there is exactly one: `updateProject()` below writes `status` only as a
 * consequence of writing `archived_at`, never on its own, and every read filters on
 * `archived_at` — the column the API actually serializes.
 */

export type ProjectRow = typeof schema.projects.$inferSelect;
export type WorkspaceRow = typeof schema.workspaces.$inferSelect;
export type DbLike = Db | DbTransaction;

/** V1 has one Workspace (F4.1); this is the name it is seeded with. */
export const DEFAULT_WORKSPACE_NAME = 'Default';

export interface ListProjectsFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  /** Opaque cursor's decoded ordering key — the UUIDv7 `id` (TDS 04 §1.2). */
  readonly afterId?: string;
  /** TDS 04 §4: `?archived=false` is the default view, not "everything". */
  readonly archived: boolean;
}

export interface InsertProjectInput {
  readonly id?: EntityId;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly workflowMode?: 'manual' | 'assisted' | null;
}

/** Everything a PATCH may change. `archivedAt` is applied through `setArchived` semantics. */
export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly workflowMode?: 'manual' | 'assisted' | null;
  readonly archivedAt?: Date | null;
}

export async function findProjectById(db: DbLike, id: string): Promise<ProjectRow | null> {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listProjects(
  db: DbLike,
  filters: ListProjectsFilters,
): Promise<ProjectRow[]> {
  const conditions = [
    filters.archived ? isNotNull(schema.projects.archivedAt) : isNull(schema.projects.archivedAt),
  ];

  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.projects.id, filters.afterId)
        : gt(schema.projects.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.projects)
    .where(and(...conditions))
    .orderBy(filters.order === 'desc' ? desc(schema.projects.id) : asc(schema.projects.id))
    .limit(filters.limit);
}

export async function insertProject(db: DbLike, input: InsertProjectInput): Promise<ProjectRow> {
  const rows = await db
    .insert(schema.projects)
    .values({
      id: input.id ?? newId(),
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      workflowMode: input.workflowMode ?? null,
      status: 'active',
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Project insert returned no row');
  return row;
}

export async function updateProject(
  db: DbLike,
  id: string,
  update: UpdateProjectInput,
): Promise<ProjectRow | null> {
  const rows = await db
    .update(schema.projects)
    .set({
      ...(update.name === undefined ? {} : { name: update.name }),
      ...('description' in update ? { description: update.description ?? null } : {}),
      ...('workflowMode' in update ? { workflowMode: update.workflowMode ?? null } : {}),
      // The single writer of the archived pair (see the module header).
      ...('archivedAt' in update
        ? {
            archivedAt: update.archivedAt ?? null,
            status:
              update.archivedAt === null || update.archivedAt === undefined ? 'active' : 'archived',
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.projects.id, id))
    .returning();

  return rows[0] ?? null;
}

export async function deleteProject(db: DbLike, id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.projects)
    .where(eq(schema.projects.id, id))
    .returning({ id: schema.projects.id });
  return rows.length > 0;
}

export interface ProjectDependents {
  readonly sessions: number;
  readonly repositories: number;
}

/**
 * What still points at this Project.
 *
 * `sessions.project_id` is `ON DELETE RESTRICT` and `repositories.project_id` is
 * `ON DELETE SET NULL` (TDS 03 §3.6/§3.9), so a raw DELETE would either raise a bare FK error
 * or silently unassign repositories. TDS 04 §4 asks for `CONFLICT` in both cases, which means
 * counting first.
 */
export async function countProjectDependents(db: DbLike, id: string): Promise<ProjectDependents> {
  const [sessionRows, repositoryRows] = await Promise.all([
    db.select({ total: count() }).from(schema.sessions).where(eq(schema.sessions.projectId, id)),
    db
      .select({ total: count() })
      .from(schema.repositories)
      .where(eq(schema.repositories.projectId, id)),
  ]);

  return {
    sessions: Number(sessionRows[0]?.total ?? 0),
    repositories: Number(repositoryRows[0]?.total ?? 0),
  };
}

/**
 * The single default Workspace (F4.1), created on first use.
 *
 * TDS 03 §8 calls this "application startup logic (idempotent upsert), not a migration" but
 * nothing seeds it today, and `POST /api/v1/projects` takes no `workspaceId` (TDS 04 §4) — so
 * the first Project has to be able to conjure the Workspace it belongs to. `workspaces` has no
 * natural unique key to `ON CONFLICT` against, so concurrency is handled the way
 * `auth/bootstrap.ts` handles the same problem: an advisory lock and a re-check inside it, so
 * two simultaneous first-Project requests cannot both observe an empty table.
 */
export async function ensureDefaultWorkspace(db: Db): Promise<string> {
  const existing = await firstWorkspaceId(db);
  if (existing !== null) return existing;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('mission-control:workspace-seed'))`);

    const recheck = await firstWorkspaceId(tx);
    if (recheck !== null) return recheck;

    const id = newId();
    await tx.insert(schema.workspaces).values({ id, name: DEFAULT_WORKSPACE_NAME });
    return id;
  });
}

async function firstWorkspaceId(db: DbLike): Promise<string | null> {
  const rows = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    // UUIDv7 is time-ordered (F4.2), so "lowest id" is "created first" — a stable answer to
    // "the default workspace" even if a later phase adds more.
    .orderBy(asc(schema.workspaces.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Is `name` already taken in this Workspace? Mirrors `ux_projects_workspace_name`. */
export async function findProjectByName(
  db: DbLike,
  workspaceId: string,
  name: string,
): Promise<ProjectRow | null> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.workspaceId, workspaceId),
        sql`lower(${schema.projects.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
