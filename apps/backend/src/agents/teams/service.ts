import type { AgentTeamScope, Db } from '@mc/shared';
import { recordAuditEntry } from '../../audit/index.js';
import type { Principal } from '../../auth/index.js';
import { isUniqueViolation } from '../../db/index.js';
import type { Outbox, OutboxTransaction } from '../../events/index.js';
import type { RequestContext } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import type { AgentRow } from '../store.js';
import { projectExists } from '../store.js';
import { type AgentTeamResource, serializeAgentTeam } from './serialize.js';
import {
  type AgentTeamRow,
  type AgentTeamUpdate,
  deleteAgentTeam,
  findAgentsByIds,
  findAgentTeamById,
  findConflictingAssignments,
  findExistingProjectIds,
  insertAgentTeam,
  listAgentTeams,
  listTeamAssignments,
  listTeamMembers,
  replaceTeamAssignments,
  replaceTeamMembers,
  touchAgentTeam,
  updateAgentTeam,
} from './store.js';
import {
  assertTeamScopeTarget,
  normalizeIdList,
  normalizeTeamDescription,
  normalizeTeamName,
} from './validation.js';

/**
 * The AgentTeam domain service — TDS 04 §13.2's reserved `/agent-teams` routes, now built.
 *
 * Five decisions this file makes, each of them deliberately:
 *
 * 1. **Scope is immutable**, exactly as an Agent's is. `PATCH` cannot change `scope` or
 *    `projectId`, because moving a project team to another project would retroactively invalidate
 *    every project-scoped member it holds — the roster would describe a team that could never
 *    have existed. Delete it and create the one you meant.
 * 2. **`agentIds` and `projectIds` are replace-the-set**, not add/remove. A `PATCH` carrying
 *    `agentIds` says "this is the roster"; omitting the field leaves the roster alone. That makes
 *    the write idempotent and makes "remove the QA agent" expressible without a second route.
 * 3. **A Project belongs to one team, and taking it is refused, not silent.** Adding a Project
 *    already assigned elsewhere answers `409 CONFLICT` naming the incumbent, rather than quietly
 *    transferring it — an operator moving a project between teams should perform two visible acts,
 *    because the consequence (a different roster is offered on that project) is invisible at the
 *    call site.
 * 4. **An archived Agent cannot be *added*; an Agent archived *while* on a team keeps its seat.**
 *    Adding one offers a member that cannot be launched, which is the `CONFLICT` the session
 *    binding path already gives. Keeping one is the reversible half: archive is undoable, so
 *    dropping the row would make un-archiving unable to restore the roster.
 * 5. **Events go through the outbox in the same transaction as the rows** (F6.3):
 *    `agent_team.created` / `agent_team.updated` / `agent_team.deleted`, plus the reserved
 *    `agent.assigned` for every (team, project) pair that gained agents. Nothing else in §15.4's
 *    Phase-4 list is produced — the three `agent.execution_*` names still have no producer.
 */

export interface CreateAgentTeamInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly scope: AgentTeamScope;
  readonly projectId?: string | null | undefined;
  readonly agentIds?: readonly string[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
}

export interface UpdateAgentTeamInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly agentIds?: readonly string[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
}

export interface ListAgentTeamsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly scope?: AgentTeamScope | undefined;
  readonly projectId?: string | undefined;
}

export interface AgentTeamServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
}

export class AgentTeamService {
  readonly #db: Db;
  readonly #outbox: Outbox;

  constructor(options: AgentTeamServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
  }

  /** `GET /api/v1/agent-teams` — cursor list; `?scope=`, `?projectId=`. */
  async list(input: ListAgentTeamsApiInput): Promise<AgentTeamResource[]> {
    const rows = await listAgentTeams(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });

    return this.#hydrate(rows);
  }

  /** `GET /api/v1/agent-teams/{id}`. */
  async get(id: string): Promise<AgentTeamResource> {
    const row = await this.#require(id);
    const [resource] = await this.#hydrate([row]);
    /* c8 ignore next */
    if (resource === undefined) throw new ApiError('NOT_FOUND', `No agent team with id ${id}`);
    return resource;
  }

  /** `POST /api/v1/agent-teams` -> `201`. */
  async create(
    principal: Principal,
    input: CreateAgentTeamInput,
    ctx: RequestContext,
  ): Promise<AgentTeamResource> {
    const name = normalizeTeamName(input.name);
    const description = normalizeTeamDescription(input.description);
    const projectId = input.projectId ?? null;

    assertTeamScopeTarget({ scope: input.scope, projectId });

    if (projectId !== null && !(await projectExists(this.#db, projectId))) {
      throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
        field: 'projectId',
      });
    }

    const agentIds = normalizeIdList(input.agentIds ?? []);
    const projectIds = normalizeIdList(input.projectIds ?? []);

    // The team row does not exist yet, so the membership rules are checked against the team this
    // request describes rather than against a stored one. Same predicate either way — see
    // `#resolveMembers`.
    const members = await this.#resolveMembers({ scope: input.scope, projectId }, agentIds);
    await this.#assertProjectsAssignable(projectIds, { scope: input.scope, projectId }, null);

    const created = await this.#outbox
      .run(async (tx) => {
        const team = await insertAgentTeam(tx.tx, {
          name,
          description,
          scope: input.scope,
          projectId,
        });

        await replaceTeamMembers(tx.tx, team, members);
        await replaceTeamAssignments(tx.tx, team, projectIds);

        await tx.emit(
          this.#outbox.event(
            'agent_team.created',
            {
              teamId: team.id,
              scope: team.scope,
              projectId,
              memberCount: members.length,
              projectCount: projectIds.length,
            },
            { correlationId: team.id },
          ),
        );

        await this.#emitAssigned(tx, team.id, projectIds, members);

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'agent_team.created',
          entityType: 'agent_teams',
          entityId: team.id,
          after: {
            name: team.name,
            scope: team.scope,
            projectId,
            agentIds: members.map((agent) => agent.id),
            projectIds: [...projectIds],
          },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return team;
      })
      .catch((error: unknown) => {
        throw asDuplicateName(error, name, input.scope);
      });

    return this.get(created.id);
  }

  /** `PATCH /api/v1/agent-teams/{id}` — name, description, roster, assignments. */
  async update(
    principal: Principal,
    id: string,
    input: UpdateAgentTeamInput,
    ctx: RequestContext,
  ): Promise<AgentTeamResource> {
    const existing = await this.#require(id);

    const fieldChanges: AgentTeamUpdate = {
      ...(input.name === undefined ? {} : { name: normalizeTeamName(input.name) }),
      ...('description' in input
        ? { description: normalizeTeamDescription(input.description) }
        : {}),
    };

    const agentIds = input.agentIds === undefined ? null : normalizeIdList(input.agentIds);
    const projectIds = input.projectIds === undefined ? null : normalizeIdList(input.projectIds);

    if (Object.keys(fieldChanges).length === 0 && agentIds === null && projectIds === null) {
      return this.get(id);
    }

    const members =
      agentIds === null
        ? null
        : await this.#resolveMembers(
            { scope: existing.scope as AgentTeamScope, projectId: existing.projectId },
            agentIds,
          );

    if (projectIds !== null) {
      await this.#assertProjectsAssignable(
        projectIds,
        { scope: existing.scope as AgentTeamScope, projectId: existing.projectId },
        id,
      );
    }

    const before = await this.#snapshot(existing);

    // Read outside the transaction, on purpose: when the roster is untouched but a project was
    // added, `agent.assigned` still has to name the members that project just gained, and that
    // is the *current* roster — which is exactly what a read taken before the write returns.
    const roster = members ?? (projectIds === null ? [] : await this.#members(id));

    const changedFields = [
      ...Object.keys(fieldChanges),
      ...(agentIds === null ? [] : ['agentIds']),
      ...(projectIds === null ? [] : ['projectIds']),
    ];

    await this.#outbox
      .run(async (tx) => {
        const updated =
          Object.keys(fieldChanges).length === 0
            ? // A roster or assignment change is still a change to the team: `updated_at` moves
              // so a client polling the team document sees it, and the audit `before`/`after`
              // pair below is about the same instant.
              await touchAgentTeam(tx.tx, id)
            : await updateAgentTeam(tx.tx, id, fieldChanges);
        /* c8 ignore next */
        if (updated === null) throw new ApiError('NOT_FOUND', `No agent team with id ${id}`);

        if (members !== null) await replaceTeamMembers(tx.tx, updated, members);
        if (projectIds !== null) await replaceTeamAssignments(tx.tx, updated, projectIds);

        await tx.emit(
          this.#outbox.event(
            'agent_team.updated',
            { teamId: id, changedFields },
            { correlationId: id },
          ),
        );

        // Only the pairs that are *new*. Re-sending an unchanged `projectIds` must not claim an
        // assignment happened — an event that fires when nothing changed is a lie a consumer
        // cannot distinguish from the real thing.
        const nextProjects = projectIds ?? before.projectIds;
        const gainedProjects = nextProjects.filter(
          (projectId) => !before.projectIds.includes(projectId),
        );
        const keptProjects = nextProjects.filter((projectId) =>
          before.projectIds.includes(projectId),
        );
        const gainedAgents =
          members === null ? [] : members.filter((agent) => !before.agentIds.includes(agent.id));

        // A project that is new to the team gains every member; a project it already had gains
        // only the members that are new.
        await this.#emitAssigned(tx, id, gainedProjects, roster);
        await this.#emitAssigned(tx, id, keptProjects, gainedAgents);

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'agent_team.updated',
          entityType: 'agent_teams',
          entityId: id,
          before: auditView(before, changedFields),
          after: auditView(
            {
              name: updated.name,
              description: updated.description,
              agentIds: (members ?? []).map((agent) => agent.id),
              projectIds: projectIds === null ? before.projectIds : [...projectIds],
            },
            changedFields,
          ),
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });
      })
      .catch((error: unknown) => {
        throw asDuplicateName(
          error,
          fieldChanges.name ?? existing.name,
          existing.scope as AgentTeamScope,
        );
      });

    return this.get(id);
  }

  /**
   * `DELETE /api/v1/agent-teams/{id}` -> `204`; `409 CONFLICT` while any Project is assigned.
   *
   * **A team is deleted, not archived, and the difference from an Agent is argued rather than
   * inherited.** An Agent is referenced as *history* — `sessions.agent_id` is what "this
   * conversation ran as the Architect" means — so erasing one rewrites the past, and archive is
   * the only safe retirement. Nothing references a team that way: it never acts, so it is never
   * an audit actor; no Session records one; no memory is scoped to one. Archiving would preserve
   * a name that points at nothing and would raise a question archive cannot answer — is an
   * archived team still its projects' team?
   *
   * What archive *did* buy — no invisible blast radius — is bought here instead by refusing while
   * the team is assigned. `agent_team_assignments`' FK back to `agent_teams` is `NO ACTION`, so
   * PostgreSQL refuses it too: the rule is structural and the `409` is only the message. The
   * roster itself cascades, because a membership means nothing without its team.
   */
  async remove(principal: Principal, id: string, ctx: RequestContext): Promise<void> {
    const existing = await this.#require(id);
    const before = await this.#snapshot(existing);

    if (before.projectIds.length > 0) {
      throw new ApiError(
        'CONFLICT',
        'This team is still assigned to projects; unassign it before deleting it',
        { projectIds: before.projectIds },
      );
    }

    await this.#outbox.run(async (tx) => {
      const deleted = await deleteAgentTeam(tx.tx, id);
      /* c8 ignore next */
      if (!deleted) throw new ApiError('NOT_FOUND', `No agent team with id ${id}`);

      await tx.emit(
        this.#outbox.event('agent_team.deleted', { teamId: id }, { correlationId: id }),
      );

      await recordAuditEntry(tx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'agent_team.deleted',
        entityType: 'agent_teams',
        entityId: id,
        // The whole roster, so the deletion is reconstructible from the audit trail. This is the
        // other half of the argument for allowing delete at all: nothing is lost that the audit
        // log does not keep.
        before: {
          name: existing.name,
          scope: existing.scope,
          projectId: existing.projectId,
          agentIds: before.agentIds,
        },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  async #require(id: string): Promise<AgentTeamRow> {
    const row = await findAgentTeamById(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No agent team with id ${id}`);
    return row;
  }

  /** Members + assignments for a page of teams, in two queries rather than two per row. */
  async #hydrate(rows: readonly AgentTeamRow[]): Promise<AgentTeamResource[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [members, assignments] = await Promise.all([
      listTeamMembers(this.#db, ids),
      listTeamAssignments(this.#db, ids),
    ]);
    return rows.map((row) => serializeAgentTeam(row, members, assignments));
  }

  async #members(teamId: string): Promise<AgentRow[]> {
    const views = await listTeamMembers(this.#db, [teamId]);
    return findAgentsByIds(
      this.#db,
      views.map((view) => view.agentId),
    );
  }

  async #snapshot(team: AgentTeamRow): Promise<{
    readonly name: string;
    readonly description: string | null;
    readonly agentIds: string[];
    readonly projectIds: string[];
  }> {
    const [members, assignments] = await Promise.all([
      listTeamMembers(this.#db, [team.id]),
      listTeamAssignments(this.#db, [team.id]),
    ]);
    return {
      name: team.name,
      description: team.description,
      agentIds: members.map((member) => member.agentId),
      projectIds: assignments.map((assignment) => assignment.projectId),
    };
  }

  /**
   * Turn `agentIds` into agent rows, refusing every one the team may not hold.
   *
   * The database refuses these combinations too (`ck_agent_team_members_agent_scope` and the
   * composite FKs), so this method's job — like `assertScopeTarget`'s — is *the error message*.
   * Without it an operator who adds another project's Architect to a global team gets a
   * constraint violation rendered as `DATABASE_SCHEMA_MISMATCH`, which names the wrong problem.
   *
   * The four refusals, and why each one is the code it is:
   *  - **unknown id** -> `VALIDATION_FAILED`. The request names something that does not exist.
   *  - **session-scoped** -> `VALIDATION_FAILED`. Not a state that can change: a session agent is
   *    permanently ineligible, because it belongs to one conversation.
   *  - **out of the team's scope** -> `VALIDATION_FAILED`, naming both projects. Also permanent —
   *    an agent's scope is immutable.
   *  - **archived** -> `CONFLICT`. The id is good and the agent plainly exists; it has been
   *    retired, which is a *state* the operator can undo. Same distinction, and same code, that
   *    `AgentBindingResolver` draws when binding an archived agent to a Session.
   */
  async #resolveMembers(
    team: { readonly scope: AgentTeamScope; readonly projectId: string | null },
    agentIds: readonly string[],
  ): Promise<AgentRow[]> {
    if (agentIds.length === 0) return [];

    const rows = await findAgentsByIds(this.#db, agentIds);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return agentIds.map((agentId) => {
      const agent = byId.get(agentId);
      if (agent === undefined) {
        throw new ApiError('VALIDATION_FAILED', 'agentIds names an Agent that does not exist', {
          field: 'agentIds',
          agentId,
        });
      }

      if (agent.scope === 'session') {
        throw new ApiError(
          'VALIDATION_FAILED',
          'A session-scoped agent belongs to one conversation and cannot be a standing team member',
          { field: 'agentIds', agentId, scope: agent.scope },
        );
      }

      if (agent.scope === 'project' && agent.projectId !== team.projectId) {
        throw new ApiError(
          'VALIDATION_FAILED',
          team.scope === 'global'
            ? 'A global team may only hold global agents; this one is scoped to a project'
            : 'This agent is scoped to a different project than the team',
          {
            field: 'agentIds',
            agentId,
            scope: agent.scope,
            agentProjectId: agent.projectId,
            teamProjectId: team.projectId,
          },
        );
      }

      if (agent.archivedAt !== null) {
        throw new ApiError(
          'CONFLICT',
          'This agent is archived and cannot be added to a team; un-archive it first',
          { field: 'agentIds', agentId },
        );
      }

      return agent;
    });
  }

  /** Every Project named must exist, be assignable to this team, and be unclaimed. */
  async #assertProjectsAssignable(
    projectIds: readonly string[],
    team: { readonly scope: AgentTeamScope; readonly projectId: string | null },
    teamId: string | null,
  ): Promise<void> {
    if (projectIds.length === 0) return;

    const known = await findExistingProjectIds(this.#db, projectIds);
    for (const projectId of projectIds) {
      if (!known.has(projectId)) {
        throw new ApiError('VALIDATION_FAILED', 'projectIds names a Project that does not exist', {
          field: 'projectIds',
          projectId,
        });
      }
      // A project team's roster may contain that project's own agents, so assigning it anywhere
      // else would hand a second project a roster it cannot use. `ck_agent_team_assignments_scope`
      // refuses the row; this is the sentence that explains why.
      if (team.scope === 'project' && projectId !== team.projectId) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'A project-scoped team can only be assigned to its own project',
          { field: 'projectIds', projectId, teamProjectId: team.projectId },
        );
      }
    }

    const conflicts = await findConflictingAssignments(this.#db, projectIds, teamId);
    const conflict = conflicts[0];
    if (conflict !== undefined) {
      throw new ApiError(
        'CONFLICT',
        `Project is already assigned to the team "${conflict.team.name}"; unassign it there first`,
        { field: 'projectIds', projectId: conflict.projectId, teamId: conflict.team.id },
      );
    }
  }

  /**
   * `agent.assigned` — the reserved §15.4 name, produced for the first time.
   *
   * One event per **(team, project) pair**, carrying the agents that became available in that
   * project. Not one per agent: the fact a consumer acts on is "project P's available-agent set
   * changed", and five frames saying so five times would make a client invalidate the same query
   * five times. Nothing is emitted for an empty pair — an assignment of a team with no members
   * changes no availability, and `agent.assigned` with an empty list would be an event about
   * nothing.
   */
  async #emitAssigned(
    tx: OutboxTransaction,
    teamId: string,
    projectIds: readonly string[],
    agents: readonly AgentRow[],
  ): Promise<void> {
    if (agents.length === 0) return;
    const agentIds = agents.map((agent) => agent.id);

    for (const projectId of projectIds) {
      await tx.emit(
        this.#outbox.event(
          'agent.assigned',
          { teamId, projectId, agentIds },
          { correlationId: teamId },
        ),
      );
    }
  }
}

/**
 * `ux_agent_teams_*_name` is unconditional (a team has no archive to make it partial on), so this
 * fires against any other team of the same name in the same scope — a `CONFLICT` the operator can
 * act on, not a 500.
 */
function asDuplicateName(error: unknown, name: string, scope: AgentTeamScope): unknown {
  for (const index of ['ux_agent_teams_global_name', 'ux_agent_teams_project_name']) {
    if (isUniqueViolation(error, index)) {
      return new ApiError('CONFLICT', `A team named "${name}" already exists in this ${scope}`, {
        field: 'name',
        scope,
      });
    }
  }
  return error;
}

/** Only the fields this request touched, so the audit diff is a diff (TDS 03 §3.14). */
function auditView(
  snapshot: {
    readonly name: string;
    readonly description: string | null;
    readonly agentIds: readonly string[];
    readonly projectIds: readonly string[];
  },
  fields: readonly string[],
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  if (fields.includes('name')) view['name'] = snapshot.name;
  if (fields.includes('description')) view['description'] = snapshot.description;
  if (fields.includes('agentIds')) view['agentIds'] = [...snapshot.agentIds];
  if (fields.includes('projectIds')) view['projectIds'] = [...snapshot.projectIds];
  return view;
}
