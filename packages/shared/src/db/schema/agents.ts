/**
 * The Agent aggregate: `agents` (PRD §5, F4.1, TDS 03 §6 — Phase 4).
 *
 * TDS 03 §6 reserved this table as a two-column skeleton marked "DO NOT EXTEND before the
 * corresponding phase's design document exists". Phase 4 is that phase, so the skeleton becomes
 * real and the columns are PRD §5.3's structure: name, description, scope, runtime, permissions,
 * instructions. (`knowledge` and `memory` are the two §5.3 fields deliberately *not* here — see
 * the end of this header.)
 *
 * ## The scope invariant, and why it is a CHECK
 *
 * PRD §5.2 defines three kinds of agent, and each names a different target:
 *
 *   `global`   available everywhere        -> no target
 *   `project`  repository-specific         -> `project_id`
 *   `session`  temporary, one conversation -> `session_id`
 *
 * `ck_agents_scope_target` makes every other combination **unrepresentable**, the same way
 * `ck_memory_items_tier_scope` does for memory tiers. Without it a `project`-scoped agent with a
 * null `project_id` is storable, and it would be invisible to every project-scoped query and
 * offered by none — an agent that exists and can never be used, which is worse than one that was
 * never created because nothing reports it missing. `ELSE false` also closes the vocabulary: a
 * scope outside `AGENT_SCOPES` fails this constraint even if `ck_agents_scope` were dropped.
 *
 * ## Deletion: there is none
 *
 * There is no `DELETE /agents/{id}` and no delete path in `store.ts`; retirement is
 * `archived_at`. Three referents make erasure unsafe rather than merely unkind:
 * `sessions.agent_id` (which is what "this conversation ran as the Architect" *is*),
 * `audit_log_entries.actor_id`, which is polymorphic and deliberately not an FK so that audit
 * survives its actor, and `memory_items.agent_id`. `sessions.agent_id` is `ON DELETE RESTRICT`,
 * so the archive-only rule is structural and not merely a missing route.
 *
 * ## Two PRD §5.3 fields are absent on purpose
 *
 * `knowledge` and `memory`. Nothing reads either one in this slice: the `agent` memory tier has
 * no producer (`PRODUCIBLE_MEMORY_TIERS` still excludes it) and there is no knowledge-source
 * consumer. A column nothing reads is a field that lies to the operator who fills it in.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AGENT_RUNTIMES as AGENT_RUNTIME_VOCABULARY,
  AGENT_SCOPES as AGENT_SCOPE_VOCABULARY,
  type AgentPermissions,
  type AgentRuntime,
  type AgentScope,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_INSTRUCTIONS_LENGTH,
  MAX_AGENT_NAME_LENGTH,
} from '../../entities/agent.js';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';
import { projects } from './projects.js';
import { sessions } from './sessions.js';

/** Anchored to the shared vocabulary rather than re-typed, exactly as `sessions.state` is. */
const AGENT_SCOPES = AGENT_SCOPE_VOCABULARY satisfies readonly AgentScope[];
const AGENT_RUNTIMES = AGENT_RUNTIME_VOCABULARY satisfies readonly AgentRuntime[];

export const agents = pgTable(
  'agents',
  {
    id: primaryKeyId(),
    name: text('name').notNull(),
    description: text('description'),

    // --------------------------------------------------------------- scope ("where does it apply")

    scope: text('scope').notNull(),
    /** Set iff `scope = 'project'`. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Set iff `scope = 'session'`. `ON DELETE RESTRICT` rather than CASCADE: a session-scoped
     * agent is normally *also* bound to that Session through `sessions.agent_id`, and a cascade
     * from here would collide with that FK's own RESTRICT inside one statement. Refusing the
     * session delete outright is the comprehensible failure; nothing in the product deletes a
     * Session anyway (they are archived), so neither rule fires in practice.
     *
     * The `AnyPgColumn` annotation is required, not decorative: `sessions.agent_id` points back
     * here, and without it TypeScript cannot resolve the two tables' types through the cycle
     * (TS7022). `sessions.resumed_from_session_id` carries the same annotation for the same
     * reason.
     */
    sessionId: uuid('session_id').references((): AnyPgColumn => sessions.id, {
      onDelete: 'restrict',
    }),

    // ------------------------------------------------------------- behaviour ("what does it do")

    /** PRD §5.4. One value today — see `AGENT_RUNTIMES`. Copied onto `sessions.runtime` at bind. */
    runtime: text('runtime').notNull().default('claude_code'),
    /**
     * PRD §5.5, reduced to what a control surface can enforce (see `entities/agent.ts`).
     * Stored whole rather than split into columns: it is read and written as a unit and every
     * field of it is consumed by one function, `disallowedToolsFor`.
     */
    permissions: jsonb('permissions').$type<AgentPermissions>().notNull(),
    /**
     * The persona. Reaches the runtime as the Claude Agent SDK's `systemPrompt.append` — the
     * whole point of the entity, and the one field whose effect is observable in a transcript.
     */
    instructions: text('instructions'),

    // ----------------------------------------------------------------------------- lifecycle

    /** Retirement (F4.2's `archived_at` convention). Non-null hides it from launch and from lists. */
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_agents_scope', sql`${table.scope} IN (${valueList(AGENT_SCOPES)})`),
    check('ck_agents_runtime', sql`${table.runtime} IN (${valueList(AGENT_RUNTIMES)})`),

    /** Scope and target agree — the invariant this table exists to make unrepresentable. */
    check(
      'ck_agents_scope_target',
      sql`CASE ${table.scope}
            WHEN 'global'  THEN ${table.projectId} IS NULL AND ${table.sessionId} IS NULL
            WHEN 'project' THEN ${table.projectId} IS NOT NULL AND ${table.sessionId} IS NULL
            WHEN 'session' THEN ${table.sessionId} IS NOT NULL AND ${table.projectId} IS NULL
            ELSE false
          END`,
    ),

    check(
      'ck_agents_name_length',
      sql`length(${table.name}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_NAME_LENGTH))}`,
    ),
    check(
      'ck_agents_description_length',
      sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_DESCRIPTION_LENGTH))}`,
    ),
    check(
      'ck_agents_instructions_length',
      sql`${table.instructions} IS NULL OR length(${table.instructions}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_INSTRUCTIONS_LENGTH))}`,
    ),

    /**
     * The permission document has exactly the shape `disallowedToolsFor` reads. Enforced in the
     * database because that function has no `else` branch to fall into: a half-written object
     * would silently produce a *smaller* denial set, i.e. a more capable agent than the row says.
     *
     * **Every subexpression is `coalesce`d, and that is not defensive noise.** A CHECK passes
     * when it evaluates to NULL, and `jsonb_typeof(permissions #> '{repository,write}')` is
     * exactly NULL for the case this constraint exists to catch — the missing field. Written
     * without the coalesce it admitted `{"repository":{"read":true}}` silently, which is the
     * precise defect it was written to prevent.
     */
    check(
      'ck_agents_permissions_shape',
      sql`coalesce(jsonb_typeof(${table.permissions}), '') = 'object'
          AND coalesce(jsonb_typeof(${table.permissions} -> 'repository'), '') = 'object'
          AND coalesce(jsonb_typeof(${table.permissions} #> '{repository,read}'), '') = 'boolean'
          AND coalesce(jsonb_typeof(${table.permissions} #> '{repository,write}'), '') = 'boolean'
          AND coalesce(jsonb_typeof(${table.permissions} #> '{repository,shell}'), '') = 'boolean'`,
    ),
    /**
     * `shell` subsumes `read` and `write` (`isEnforceableAgentPermissions`). A row claiming
     * "may run any command, may not write files" describes a denial the runtime cannot deliver,
     * and storing it would let the API render a restriction that does not exist.
     *
     * Coalesced for the same NULL-passes-a-CHECK reason as the shape constraint above, so this
     * one holds on its own rather than only in the presence of its neighbour.
     */
    check(
      'ck_agents_permissions_shell_subsumes',
      sql`NOT (coalesce(${table.permissions} #> '{repository,shell}', 'false'::jsonb) = 'true'::jsonb
               AND (coalesce(${table.permissions} #> '{repository,read}', 'false'::jsonb) <> 'true'::jsonb
                    OR coalesce(${table.permissions} #> '{repository,write}', 'false'::jsonb) <> 'true'::jsonb))`,
    ),

    /**
     * One live agent per name per target. Partial on `archived_at IS NULL` so retiring an
     * "Architect" frees the name for its replacement — which is the whole reason archive is
     * usable as a substitute for delete.
     */
    uniqueIndex('ux_agents_global_name')
      .on(table.name)
      .where(sql`${table.scope} = 'global' AND ${table.archivedAt} IS NULL`),
    uniqueIndex('ux_agents_project_name')
      .on(table.projectId, table.name)
      .where(sql`${table.scope} = 'project' AND ${table.archivedAt} IS NULL`),
    uniqueIndex('ux_agents_session_name')
      .on(table.sessionId, table.name)
      .where(sql`${table.scope} = 'session' AND ${table.archivedAt} IS NULL`),

    /** The list route's two filters, and the FK indexes they double as. */
    index('ix_agents_scope_project').on(table.scope, table.projectId),
    index('ix_agents_session').on(table.sessionId),
  ],
);
