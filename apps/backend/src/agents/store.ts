import {
  type AgentPermissions,
  type AgentScope,
  type Db,
  type DbTransaction,
  type EntityId,
  newId,
  schema,
} from '@mc/shared';
import { and, asc, desc, eq, gt, isNull, lt } from 'drizzle-orm';

/**
 * Every `agents` read and write, in one module.
 *
 * **There is no delete.** Not "there is no delete route" — there is no function here that could
 * be called by one. Retirement is `archived_at`, written by `updateAgent`. The reasoning is on
 * the table itself (`packages/shared/src/db/schema/agents.ts`); the reason it is enforced by
 * omission rather than by convention is that `sessions.agent_id`, `audit_log_entries.actor_id`
 * and `memory_items.agent_id` all point here, and two of those three are supposed to outlive
 * anything.
 */

export type AgentRow = typeof schema.agents.$inferSelect;

export type DbLike = Db | DbTransaction;

export interface InsertAgentInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly runtime: string;
  readonly permissions: AgentPermissions;
  readonly instructions: string | null;
}

/** Everything mutable. `scope`, `project_id` and `session_id` are not: see `service.ts`. */
export type AgentUpdate = Partial<{
  name: string;
  description: string | null;
  runtime: string;
  permissions: AgentPermissions;
  instructions: string | null;
  archivedAt: Date | null;
}>;

export interface ListAgentsFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string;
  readonly scope?: AgentScope;
  readonly projectId?: string;
  readonly sessionId?: string;
  /** Archived agents are excluded unless asked for — see `service.ts` for why that is the default. */
  readonly includeArchived?: boolean;
}

export async function listAgents(db: DbLike, filters: ListAgentsFilters): Promise<AgentRow[]> {
  const conditions = [];
  if (filters.scope !== undefined) conditions.push(eq(schema.agents.scope, filters.scope));
  if (filters.projectId !== undefined) {
    conditions.push(eq(schema.agents.projectId, filters.projectId));
  }
  if (filters.sessionId !== undefined) {
    conditions.push(eq(schema.agents.sessionId, filters.sessionId));
  }
  if (filters.includeArchived !== true) conditions.push(isNull(schema.agents.archivedAt));
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.agents.id, filters.afterId)
        : gt(schema.agents.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.agents)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(filters.order === 'desc' ? desc(schema.agents.id) : asc(schema.agents.id))
    .limit(filters.limit);
}

export async function findAgentById(db: DbLike, id: string): Promise<AgentRow | null> {
  const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertAgent(db: DbLike, input: InsertAgentInput): Promise<AgentRow> {
  const rows = await db
    .insert(schema.agents)
    .values({
      id: input.id ?? newId(),
      name: input.name,
      description: input.description,
      scope: input.scope,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runtime: input.runtime,
      permissions: input.permissions,
      instructions: input.instructions,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Agent insert returned no row');
  return row;
}

export async function updateAgent(
  tx: DbTransaction,
  id: string,
  changes: AgentUpdate,
): Promise<AgentRow | null> {
  const rows = await tx
    .update(schema.agents)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(schema.agents.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function projectExists(db: DbLike, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return rows.length === 1;
}

export async function sessionExists(db: DbLike, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return rows.length === 1;
}
