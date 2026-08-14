import { type AgentTeamScope, type DbTransaction, type EntityId, newId, schema } from '@mc/shared';
import { and, asc, desc, eq, gt, inArray, lt, not } from 'drizzle-orm';
import type { AgentRow, DbLike } from '../store.js';

/**
 * Every `agent_teams`, `agent_team_members` and `agent_team_assignments` read and write, in one
 * module — the same containment `agents/store.ts` keeps for its table.
 *
 * **There is a delete here, and that is deliberate rather than an oversight of the agent rule.**
 * `agents/store.ts` has no delete function because three tables point at an agent as history. A
 * team is pointed at only by its own membership and assignment rows, so `deleteAgentTeam` exists;
 * what stops a *used* team from vanishing is `agent_team_assignments`' FK back to `agent_teams`
 * (`NO ACTION`), which makes PostgreSQL refuse the delete while any Project still names it. The
 * full argument is on the tables (`packages/shared/src/db/schema/agent-teams.ts`).
 *
 * The membership and assignment writers are **replace-the-set** operations, not add/remove pairs.
 * `PATCH /agent-teams/{id}` carries the whole roster and the whole project list, so the write
 * that serves it is "make the table say this", which is idempotent and cannot drift from the
 * request the way a diff applied to a stale baseline can.
 */

export type AgentTeamRow = typeof schema.agentTeams.$inferSelect;
export type AgentTeamMemberRow = typeof schema.agentTeamMembers.$inferSelect;
export type AgentTeamAssignmentRow = typeof schema.agentTeamAssignments.$inferSelect;

/** One member, joined to the agent it names — everything the resource shows, and nothing heavier. */
export interface TeamMemberView {
  readonly teamId: string;
  readonly agentId: string;
  readonly name: string;
  readonly scope: string;
  readonly projectId: string | null;
  readonly runtime: string;
  readonly archivedAt: Date | null;
  readonly addedAt: Date;
}

export interface TeamAssignmentView {
  readonly teamId: string;
  readonly projectId: string;
  readonly assignedAt: Date;
}

export interface InsertAgentTeamInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentTeamScope;
  readonly projectId: string | null;
}

/** Everything mutable. `scope` and `project_id` are not: see `service.ts`. */
export type AgentTeamUpdate = Partial<{
  name: string;
  description: string | null;
}>;

export interface ListAgentTeamsFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string;
  readonly scope?: AgentTeamScope;
  /** The team's **own** project (a `project`-scoped team), not a project it is assigned to. */
  readonly projectId?: string;
}

export async function listAgentTeams(
  db: DbLike,
  filters: ListAgentTeamsFilters,
): Promise<AgentTeamRow[]> {
  const conditions = [];
  if (filters.scope !== undefined) conditions.push(eq(schema.agentTeams.scope, filters.scope));
  if (filters.projectId !== undefined) {
    conditions.push(eq(schema.agentTeams.projectId, filters.projectId));
  }
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.agentTeams.id, filters.afterId)
        : gt(schema.agentTeams.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.agentTeams)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(filters.order === 'desc' ? desc(schema.agentTeams.id) : asc(schema.agentTeams.id))
    .limit(filters.limit);
}

export async function findAgentTeamById(db: DbLike, id: string): Promise<AgentTeamRow | null> {
  const rows = await db
    .select()
    .from(schema.agentTeams)
    .where(eq(schema.agentTeams.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The members of every named team, joined to `agents`.
 *
 * Ordered by agent name — the ordering decision, made once and here. A team is a set and carries
 * no ordinal (see `entities/agent-team.ts`), so the serializer must not be free to return members
 * in whatever order PostgreSQL happened to produce: an operator refreshing a team page and seeing
 * the roster shuffle would reasonably conclude something changed.
 */
export async function listTeamMembers(
  db: DbLike,
  teamIds: readonly string[],
): Promise<TeamMemberView[]> {
  if (teamIds.length === 0) return [];

  return db
    .select({
      teamId: schema.agentTeamMembers.teamId,
      agentId: schema.agents.id,
      name: schema.agents.name,
      scope: schema.agents.scope,
      projectId: schema.agents.projectId,
      runtime: schema.agents.runtime,
      archivedAt: schema.agents.archivedAt,
      addedAt: schema.agentTeamMembers.createdAt,
    })
    .from(schema.agentTeamMembers)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentTeamMembers.agentId))
    .where(inArray(schema.agentTeamMembers.teamId, [...teamIds]))
    .orderBy(asc(schema.agents.name), asc(schema.agents.id));
}

export async function listTeamAssignments(
  db: DbLike,
  teamIds: readonly string[],
): Promise<TeamAssignmentView[]> {
  if (teamIds.length === 0) return [];

  return db
    .select({
      teamId: schema.agentTeamAssignments.teamId,
      projectId: schema.agentTeamAssignments.projectId,
      assignedAt: schema.agentTeamAssignments.createdAt,
    })
    .from(schema.agentTeamAssignments)
    .where(inArray(schema.agentTeamAssignments.teamId, [...teamIds]))
    .orderBy(asc(schema.agentTeamAssignments.projectId));
}

/** The team a Project is assigned, with its name — the `409` message needs both. */
export async function findTeamAssignedToProject(
  db: DbLike,
  projectId: string,
): Promise<{ readonly team: AgentTeamRow; readonly assignedAt: Date } | null> {
  const rows = await db
    .select({ team: schema.agentTeams, assignedAt: schema.agentTeamAssignments.createdAt })
    .from(schema.agentTeamAssignments)
    .innerJoin(schema.agentTeams, eq(schema.agentTeams.id, schema.agentTeamAssignments.teamId))
    .where(eq(schema.agentTeamAssignments.projectId, projectId))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : { team: row.team, assignedAt: row.assignedAt };
}

/** Which of these Projects already belong to some *other* team. One query, not N. */
export async function findConflictingAssignments(
  db: DbLike,
  projectIds: readonly string[],
  exceptTeamId: string | null,
): Promise<{ readonly projectId: string; readonly team: AgentTeamRow }[]> {
  if (projectIds.length === 0) return [];

  const conditions = [inArray(schema.agentTeamAssignments.projectId, [...projectIds])];
  if (exceptTeamId !== null) {
    conditions.push(not(eq(schema.agentTeamAssignments.teamId, exceptTeamId)));
  }

  return db
    .select({ projectId: schema.agentTeamAssignments.projectId, team: schema.agentTeams })
    .from(schema.agentTeamAssignments)
    .innerJoin(schema.agentTeams, eq(schema.agentTeams.id, schema.agentTeamAssignments.teamId))
    .where(and(...conditions));
}

export async function insertAgentTeam(
  db: DbLike,
  input: InsertAgentTeamInput,
): Promise<AgentTeamRow> {
  const rows = await db
    .insert(schema.agentTeams)
    .values({
      id: input.id ?? newId(),
      name: input.name,
      description: input.description,
      scope: input.scope,
      projectId: input.projectId,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Agent team insert returned no row');
  return row;
}

export async function updateAgentTeam(
  tx: DbTransaction,
  id: string,
  changes: AgentTeamUpdate,
): Promise<AgentTeamRow | null> {
  const rows = await tx
    .update(schema.agentTeams)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(schema.agentTeams.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Touch `updated_at` without changing a field — a roster change is a change to the team. */
export async function touchAgentTeam(tx: DbTransaction, id: string): Promise<AgentTeamRow | null> {
  const rows = await tx
    .update(schema.agentTeams)
    .set({ updatedAt: new Date() })
    .where(eq(schema.agentTeams.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteAgentTeam(tx: DbTransaction, id: string): Promise<boolean> {
  const rows = await tx
    .delete(schema.agentTeams)
    .where(eq(schema.agentTeams.id, id))
    .returning({ id: schema.agentTeams.id });
  return rows.length === 1;
}

/**
 * Make the roster exactly `agents` — delete what is no longer named, insert what is new.
 *
 * The four denormalized columns are written here, from the rows the caller already loaded, and
 * nowhere else. They are not trusted afterwards: the composite FKs on the table reject any copy
 * that disagrees with its source, so a bug in this function fails the INSERT rather than
 * producing a membership that lies about the agent's scope.
 */
export async function replaceTeamMembers(
  tx: DbTransaction,
  team: AgentTeamRow,
  agents: readonly AgentRow[],
): Promise<void> {
  const keep = agents.map((agent) => agent.id);

  await tx
    .delete(schema.agentTeamMembers)
    .where(
      keep.length === 0
        ? eq(schema.agentTeamMembers.teamId, team.id)
        : and(
            eq(schema.agentTeamMembers.teamId, team.id),
            not(inArray(schema.agentTeamMembers.agentId, keep)),
          ),
    );

  if (agents.length === 0) return;

  await tx
    .insert(schema.agentTeamMembers)
    .values(
      agents.map((agent) => ({
        id: newId(),
        teamId: team.id,
        teamScope: team.scope,
        teamProjectId: team.projectId,
        agentId: agent.id,
        agentScope: agent.scope,
        agentProjectId: agent.projectId,
      })),
    )
    // Re-adding an agent that is already on the team must not be a conflict: the request said
    // "these are the members", and one of them already was. `addedAt` therefore records the
    // *first* time a seat was taken, which is the more useful fact of the two.
    .onConflictDoNothing({
      target: [schema.agentTeamMembers.teamId, schema.agentTeamMembers.agentId],
    });
}

/** Make the assigned-project set exactly `projectIds`. Same replace-the-set contract. */
export async function replaceTeamAssignments(
  tx: DbTransaction,
  team: AgentTeamRow,
  projectIds: readonly string[],
): Promise<void> {
  await tx
    .delete(schema.agentTeamAssignments)
    .where(
      projectIds.length === 0
        ? eq(schema.agentTeamAssignments.teamId, team.id)
        : and(
            eq(schema.agentTeamAssignments.teamId, team.id),
            not(inArray(schema.agentTeamAssignments.projectId, [...projectIds])),
          ),
    );

  if (projectIds.length === 0) return;

  await tx
    .insert(schema.agentTeamAssignments)
    .values(
      projectIds.map((projectId) => ({
        id: newId(),
        teamId: team.id,
        teamScope: team.scope,
        teamProjectId: team.projectId,
        projectId,
      })),
    )
    .onConflictDoNothing({ target: [schema.agentTeamAssignments.projectId] });
}

/** The agent rows behind an `agentIds` request, in one query. Order is the caller's business. */
export async function findAgentsByIds(db: DbLike, ids: readonly string[]): Promise<AgentRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.agents)
    .where(inArray(schema.agents.id, [...ids]));
}

/**
 * The Project a Session belongs to, or `null` when there is no such Session.
 *
 * Both answers are needed by `?sessionId=` on the availability read: an unknown id is a `400` that
 * names the field, and a Session in *another* Project is a question with no sensible answer — the
 * project-scoped agents would be judged against one project and the session-scoped ones against a
 * Session in a different one.
 */
export async function findSessionProjectId(db: DbLike, sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: schema.sessions.projectId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** Which of these Project ids exist. Used to turn an unknown id into a 400 that names it. */
export async function findExistingProjectIds(
  db: DbLike,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(inArray(schema.projects.id, [...ids]));
  return new Set(rows.map((row) => row.id));
}

/**
 * **Every** Agent, ordered by name — the candidate set the availability read decides over.
 *
 * This query used to *be* the availability rule: `archived_at IS NULL AND (scope = 'global' OR
 * (scope = 'project' AND project_id = $1))` was a third copy of what `agentBindingRefusal` and the
 * launch picker each stated in their own dialect. The rule now lives in one function
 * (`agents/binding.ts`), so this read's only job is to hand it every row it must decide about —
 * including the archived and out-of-project ones, because a picker that cannot name the agent an
 * operator can see on the Agents screen is a picker with an absence it cannot account for.
 *
 * Unpaginated, deliberately, and for the reason `availability.ts` gives: this serves a composite
 * document bounded by how many Agents one operator has defined. The frontend already reads the
 * whole table (`?limit=200&includeArchived=true`) to do this partition locally; the point of the
 * change is that it no longer has to.
 */
export async function listAgentsForBinding(db: DbLike): Promise<AgentRow[]> {
  return db.select().from(schema.agents).orderBy(asc(schema.agents.name), asc(schema.agents.id));
}
