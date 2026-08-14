/**
 * The AgentTeam aggregate: `agent_teams`, `agent_team_members`, `agent_team_assignments`
 * (PRD §5.7, F4.1, TDS 03 §6 — Phase 4).
 *
 * TDS 03 §6 reserved `agent_teams` as a two-column skeleton marked "DO NOT EXTEND before the
 * corresponding phase's design document exists", and reserved `agent_team_members` by name only.
 * Phase 4's second slice is that design, so both become real — and `agent_team_assignments`
 * joins them, because PRD §5.7's second sentence ("Teams can be assigned per project") is a
 * relationship and not a column.
 *
 * ## Three tables, and why not fewer
 *
 *   `agent_teams`              the team itself: a name, a scope, and nothing else
 *   `agent_team_members`       which Agents are on it
 *   `agent_team_assignments`   which Projects it works on
 *
 * Assignment is its own table rather than `projects.agent_team_id` for two reasons. It keeps a
 * Phase 4 concept out of a Phase 1 table that four other domains read; and — the load-bearing
 * one — the row is where the scope agreement is *checked*. A `project`-scoped team assigned to
 * some other project would be a roster of agents that project cannot use, and making that
 * unrepresentable requires the team's scope and the target project to sit in one row where a
 * CHECK can see them both (see `ck_agent_team_assignments_scope`).
 *
 * ## Cardinality: one team per project, many projects per team
 *
 * `ux_agent_team_assignments_project` is unique on `project_id` alone. A Project therefore has at
 * most one team, and a team may serve any number of Projects.
 *
 * The second half is what makes a team worth defining: PRD §5.7's example roster (Product Owner,
 * Architect, Developer, QA, Security) is the *same* roster on every project an operator runs, and
 * a model that forced it to be re-created per project would be duplication with no upside. The
 * first half is what makes the consumer read answerable: `GET /projects/{id}/available-agents`
 * has to say which agents are *the* team, and with two teams assigned the honest answer becomes a
 * union with no way to render "your team" — plus an immediate second question (which team's
 * roster is shown first?) that nothing in the PRD answers. It is also the reversible direction:
 * dropping a unique index later is a migration, un-shipping a many-to-many the UI already renders
 * is not.
 *
 * ## Deletion: teams are deleted, agents are archived, and the difference is real
 *
 * `agents` has no DELETE because three tables point at an agent as *history* — `sessions.agent_id`
 * is what "this conversation ran as the Architect" means, `audit_log_entries.actor_id` is
 * polymorphic so that audit outlives its actor, and `memory_items.agent_id` scopes a tier.
 * Erasing one rewrites the past.
 *
 * Nothing points at a team that way. A team never acts, so it is never an audit *actor*; no
 * Session records the team it was launched under; no memory is scoped to one. Its only referents
 * are its own membership and assignment rows, which are current state and mean nothing without
 * it. Archiving a team would therefore preserve a name that references nothing, and would raise a
 * question archive does not answer — is an archived team still the project's team? So
 * `DELETE /agent-teams/{id}` exists, there is no `archived_at`, and the blast radius is closed
 * from the other end instead: **the delete is refused while the team is assigned to any Project**
 * (`agent_team_assignments`' FK back to `agent_teams` is `NO ACTION`, so PostgreSQL refuses it
 * too, not just the route).
 */

import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { AGENT_SCOPES as AGENT_SCOPE_VOCABULARY, type AgentScope } from '../../entities/agent.js';
import {
  AGENT_TEAM_SCOPES as AGENT_TEAM_SCOPE_VOCABULARY,
  type AgentTeamScope,
  MAX_AGENT_TEAM_DESCRIPTION_LENGTH,
  MAX_AGENT_TEAM_NAME_LENGTH,
} from '../../entities/agent-team.js';
import { agents } from './agents.js';
import { createdAt, primaryKeyId, updatedAt, valueList } from './columns.js';
import { projects } from './projects.js';

/** Anchored to the shared vocabulary rather than re-typed, exactly as `agents.scope` is. */
const AGENT_TEAM_SCOPES = AGENT_TEAM_SCOPE_VOCABULARY satisfies readonly AgentTeamScope[];
const AGENT_SCOPES = AGENT_SCOPE_VOCABULARY satisfies readonly AgentScope[];

export const agentTeams = pgTable(
  'agent_teams',
  {
    id: primaryKeyId(),
    name: text('name').notNull(),
    description: text('description'),

    /** PRD §5.7 as two kinds — see `entities/agent-team.ts`. No `session`: a team outlives one. */
    scope: text('scope').notNull(),
    /** Set iff `scope = 'project'`. Cascades: a project's team has no meaning without it. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_agent_teams_scope', sql`${table.scope} IN (${valueList(AGENT_TEAM_SCOPES)})`),

    /**
     * Scope and target agree — the same invariant `ck_agents_scope_target` states for agents,
     * and stated the same way so the two read as one rule. `ELSE false` closes the vocabulary: a
     * scope outside `AGENT_TEAM_SCOPES` fails this constraint even if `ck_agent_teams_scope` were
     * dropped, which is what keeps `session` unrepresentable rather than merely unlisted.
     */
    check(
      'ck_agent_teams_scope_target',
      sql`CASE ${table.scope}
            WHEN 'global'  THEN ${table.projectId} IS NULL
            WHEN 'project' THEN ${table.projectId} IS NOT NULL
            ELSE false
          END`,
    ),

    check(
      'ck_agent_teams_name_length',
      sql`length(${table.name}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_TEAM_NAME_LENGTH))}`,
    ),
    check(
      'ck_agent_teams_description_length',
      sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_TEAM_DESCRIPTION_LENGTH))}`,
    ),

    /**
     * One team per name per target. Unconditional, unlike `ux_agents_*_name`, because a team has
     * no `archived_at` to make partial on — retirement is deletion (see the header), and a
     * deleted row frees its name by ceasing to exist.
     */
    uniqueIndex('ux_agent_teams_global_name').on(table.name).where(sql`${table.scope} = 'global'`),
    uniqueIndex('ux_agent_teams_project_name')
      .on(table.projectId, table.name)
      .where(sql`${table.scope} = 'project'`),

    /** The list route's two filters, and the FK index `project_id` needs anyway. */
    index('ix_agent_teams_scope_project').on(table.scope, table.projectId),

    /**
     * Referenceable keys, not uniqueness rules — the same construction (and the same reasoning)
     * as `ux_agents_id_scope` / `ux_agents_id_project`. `agent_team_members` and
     * `agent_team_assignments` both carry a copy of this team's scope and project, and these are
     * what let a composite FK pin those copies to the truth.
     */
    uniqueIndex('ux_agent_teams_id_scope').on(table.id, table.scope),
    uniqueIndex('ux_agent_teams_id_project').on(table.id, table.projectId),
  ],
);

/**
 * Who is on the team.
 *
 * ## The four denormalized columns, and why they are not redundancy
 *
 * `team_scope`, `team_project_id`, `agent_scope` and `agent_project_id` are copies of columns
 * that already exist one join away. They are here because the invariant this table has to keep is
 * a statement about *two other rows at once*:
 *
 *   > a `global` team holds only `global` agents; a `project` team holds `global` agents and the
 *   > agents of **its own** project — and never a `session` agent.
 *
 * A CHECK constraint sees one row. So the facts the rule needs are brought into that row, and
 * each copy is then pinned to its source by a composite FOREIGN KEY: `(agent_id, agent_scope)`
 * must exist in `agents (id, scope)`, `(team_id, team_project_id)` must exist in
 * `agent_teams (id, project_id)`, and so on. A hand-written INSERT claiming a project agent is
 * global does not fail a validation function — it fails `agent_team_members_agent_id_...`.
 *
 * Without this, a `global` team could hold project X's "ERP Architect" and then be assigned to
 * project Y, at which point project Y's roster would offer an agent `AgentBindingResolver`
 * refuses to bind. That is the same class of leak `ck_memory_items_tier_scope` exists to prevent
 * for memory tiers: a row that is visible where it must not be.
 *
 * ## The NULL trap, again
 *
 * A CHECK **passes when it evaluates to NULL**, which is how 0006 accepted a half-written
 * permission document (see `agents.ts` and migration 0007). `agent_project_id = team_project_id`
 * is NULL — not false — when either side is missing, so the comparison below is wrapped in
 * `coalesce(..., false)`. The missing-key case is tested explicitly rather than assumed.
 *
 * ## Deletion behaviour
 *
 * Both parents cascade. A membership is **current state, not history**: it says "the Architect is
 * on this team today", and once the agent or the team is gone the row asserts nothing. That is
 * the opposite of `sessions.agent_id`, which is a historical fact and therefore `RESTRICT`s. The
 * practical consequence is that deleting a Project — which cascades to its project-scoped agents
 * and to its project-scoped team — does not fail on a row whose entire meaning was those two.
 */
export const agentTeamMembers = pgTable(
  'agent_team_members',
  {
    id: primaryKeyId(),

    teamId: uuid('team_id').notNull(),
    /** Copy of `agent_teams.scope`, pinned by a composite FK. See the header. */
    teamScope: text('team_scope').notNull(),
    /** Copy of `agent_teams.project_id`; NULL iff the team is global. Pinned by a composite FK. */
    teamProjectId: uuid('team_project_id'),

    agentId: uuid('agent_id').notNull(),
    /** Copy of `agents.scope`, pinned by a composite FK. Never `session` — see the CHECK. */
    agentScope: text('agent_scope').notNull(),
    /** Copy of `agents.project_id`; NULL iff the agent is global. Pinned by a composite FK. */
    agentProjectId: uuid('agent_project_id'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'agent_team_members_team_scope_fk',
      columns: [table.teamId, table.teamScope],
      foreignColumns: [agentTeams.id, agentTeams.scope],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_team_members_team_project_fk',
      columns: [table.teamId, table.teamProjectId],
      foreignColumns: [agentTeams.id, agentTeams.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_team_members_agent_scope_fk',
      columns: [table.agentId, table.agentScope],
      foreignColumns: [agents.id, agents.scope],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_team_members_agent_project_fk',
      columns: [table.agentId, table.agentProjectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete('cascade'),

    check(
      'ck_agent_team_members_agent_scope_value',
      sql`${table.agentScope} IN (${valueList(AGENT_SCOPES)})`,
    ),

    /**
     * The team half of the copy is internally consistent: `team_project_id` is present exactly
     * when the team is project-scoped. Without this a project team's membership could record
     * `team_project_id` as NULL, and the agent rule below would then compare against nothing.
     */
    check(
      'ck_agent_team_members_team_scope',
      sql`CASE ${table.teamScope}
            WHEN 'global'  THEN ${table.teamProjectId} IS NULL
            WHEN 'project' THEN ${table.teamProjectId} IS NOT NULL
            ELSE false
          END`,
    ),

    /**
     * **The rule this table exists for.** A global agent fits any team; a project agent fits only
     * the team of its own project; a session agent fits nothing, which `ELSE false` says by
     * refusing every scope this CASE does not name.
     *
     * `coalesce(..., false)` on the comparison is not defensive noise: a CHECK passes on NULL, so
     * an unwrapped `agent_project_id = team_project_id` would *accept* the row where either side
     * is missing — precisely the case the constraint is here to catch.
     */
    check(
      'ck_agent_team_members_agent_scope',
      sql`CASE ${table.agentScope}
            WHEN 'global'  THEN ${table.agentProjectId} IS NULL
            WHEN 'project' THEN coalesce(${table.agentProjectId} = ${table.teamProjectId}, false)
            ELSE false
          END`,
    ),

    /** A seat is held once. Adding an agent twice is idempotent, not a second seat. */
    uniqueIndex('ux_agent_team_members_team_agent').on(table.teamId, table.agentId),
    /** "Which teams is this agent on" — and the index the agent-side FKs want anyway. */
    index('ix_agent_team_members_agent').on(table.agentId),
  ],
);

/**
 * Which Projects a team works on (PRD §5.7: "Teams can be assigned per project").
 *
 * `created_at` is the assignment moment; there is no separate `assigned_at`, because an
 * assignment row has exactly one lifecycle event and F4.2 already gives every table a
 * `created_at` for it.
 *
 * ## Why the FK back to `agent_teams` is `NO ACTION` rather than `RESTRICT`
 *
 * Both refuse to delete a team that is still assigned, which is what makes
 * `DELETE /agent-teams/{id}`'s `409` structural rather than a service-level habit. They differ in
 * *when* they check: `RESTRICT` fires immediately, `NO ACTION` at the end of the statement. That
 * matters for one real case — deleting a **Project** cascades to this row (`project_id`) and, for
 * a project-scoped team, to the team as well. Under `RESTRICT` the team's deletion could be
 * refused by an assignment row that the same statement is already deleting; under `NO ACTION` the
 * end-of-statement check sees a consistent world and the delete succeeds. Same guarantee, no
 * spurious failure.
 */
export const agentTeamAssignments = pgTable(
  'agent_team_assignments',
  {
    id: primaryKeyId(),

    teamId: uuid('team_id').notNull(),
    /** Copy of `agent_teams.scope`, pinned by a composite FK — same construction as members. */
    teamScope: text('team_scope').notNull(),
    /** Copy of `agent_teams.project_id`; NULL iff the team is global. Pinned by a composite FK. */
    teamProjectId: uuid('team_project_id'),

    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'agent_team_assignments_team_scope_fk',
      columns: [table.teamId, table.teamScope],
      foreignColumns: [agentTeams.id, agentTeams.scope],
    }),
    foreignKey({
      name: 'agent_team_assignments_team_project_fk',
      columns: [table.teamId, table.teamProjectId],
      foreignColumns: [agentTeams.id, agentTeams.projectId],
    }),

    /**
     * A global team may be assigned anywhere; a project team may be assigned to **its own**
     * project and nowhere else. Assigning project X's team to project Y would hand Y a roster
     * containing agents Y cannot bind — the same leak the membership rule prevents, arriving
     * from the other direction.
     *
     * `coalesce` for the NULL-passes-a-CHECK reason stated on `agent_team_members`.
     */
    check(
      'ck_agent_team_assignments_scope',
      sql`CASE ${table.teamScope}
            WHEN 'global'  THEN ${table.teamProjectId} IS NULL
            WHEN 'project' THEN coalesce(${table.teamProjectId} = ${table.projectId}, false)
            ELSE false
          END`,
    ),

    /** One team per Project — the cardinality decision, made structural. See the module header. */
    uniqueIndex('ux_agent_team_assignments_project').on(table.projectId),
    /** "Which projects does this team serve" — read on every team GET. */
    index('ix_agent_team_assignments_team').on(table.teamId),
  ],
);
