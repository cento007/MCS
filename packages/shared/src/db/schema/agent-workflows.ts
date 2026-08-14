/**
 * The AgentWorkflow aggregate: `agent_workflows`, `agent_workflow_steps`,
 * `agent_workflow_runs`, `agent_workflow_run_steps` (PRD §5.6, F4.1 — Phase 4, slice 3).
 *
 * ## Four tables, and the line that divides them
 *
 *   `agent_workflows`           the chain: a name, a scope, and nothing else
 *   `agent_workflow_steps`      the order: which Agent, at which position, told what
 *   `agent_workflow_runs`       one execution of the chain against one Project
 *   `agent_workflow_run_steps`  one attempt at one step — and the Session it *is*
 *
 * The top two are a **definition** an operator edits; the bottom two are **history** that must
 * never change afterwards. That is why the run snapshots `step_count` instead of counting the
 * definition's rows at read time: editing a workflow tomorrow must not retroactively change what
 * yesterday's run did, and a run whose progress is "3 of 4" has to keep saying so after a fifth
 * step is added.
 *
 * ## A step is a Session
 *
 * `agent_workflow_run_steps.session_id` is the whole execution model. There is no second runtime,
 * no second state machine, no second transcript and no second cost column — every one of those is
 * the Session's, and F7 remains the only lifecycle in the product (see
 * `entities/agent-workflow.ts` for the full argument). What this table adds is the *coordinates*
 * a Session cannot carry: which run, which position in the chain, which attempt, and how complete
 * the hand-off into it was.
 *
 * ## The cross-table scope rule, again, and again with composite FKs
 *
 * A `global` workflow holds only `global` agents; a `project` workflow holds `global` agents and
 * **its own** project's; a `session` agent can never be a step. This is the same invariant
 * `agent_team_members` keeps, enforced the same way and for the same reason: **a CHECK sees one
 * row**, so the facts the rule needs are copied into the row and each copy is pinned to its source
 * by a composite FOREIGN KEY. An INSERT claiming a project agent is global does not fail a
 * validation function — it fails `agent_workflow_steps_agent_scope_fk`.
 *
 * Every comparison is wrapped in `coalesce(..., false)`, because **a CHECK passes when it
 * evaluates to NULL** — the defect that shipped in migration `0006` and needed `0007` to correct.
 * The missing-key cases are tested by constraint name rather than assumed.
 *
 * ## What is different from a team, and deliberately
 *
 * A team is a **set**; a workflow is a **sequence**. So `agent_workflow_steps` carries an
 * `ordinal` (which `agent_team_members` refused, on the grounds that "order belongs to the
 * workflow" — this is that workflow), and there is **no** unique index on
 * `(workflow_id, agent_id)`: `Developer → QA → Developer` is a legitimate chain, and a constraint
 * forbidding it would be a rule nobody asked for.
 *
 * ## The spend bounds, made structural
 *
 * This is the most dangerous feature in the product: one operator action launches Sessions that
 * write code and spend money with no human between the steps. PRD §15 puts *autonomous* review
 * flows in Phase 5, so a Phase 4 run is operator-initiated, bounded and stoppable — and two of
 * those three bounds are database constraints rather than code:
 *
 *   1. `ck_agent_workflow_steps_ordinal` — at most `MAX_AGENT_WORKFLOW_STEPS` steps exist, so an
 *      eleventh is unrepresentable.
 *   2. `ck_agent_workflow_runs_sessions_launched` — a run may never record more launched Sessions
 *      than its own `max_sessions`, so a runner bug that loops fails an UPDATE instead of
 *      spending an operator's money.
 *   3. `ux_agent_workflow_runs_active` — one `running` run per Project. Two chains racing in one
 *      working tree is a merge conflict with a bill attached.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { AGENT_SCOPES as AGENT_SCOPE_VOCABULARY, type AgentScope } from '../../entities/agent.js';
import {
  AGENT_WORKFLOW_HANDOFF_STATES as AGENT_WORKFLOW_HANDOFF_STATE_VOCABULARY,
  AGENT_WORKFLOW_RUN_STATES as AGENT_WORKFLOW_RUN_STATE_VOCABULARY,
  AGENT_WORKFLOW_RUN_STEP_STATES as AGENT_WORKFLOW_RUN_STEP_STATE_VOCABULARY,
  AGENT_WORKFLOW_SCOPES as AGENT_WORKFLOW_SCOPE_VOCABULARY,
  type AgentWorkflowHandoffState,
  type AgentWorkflowRunState,
  type AgentWorkflowRunStepState,
  type AgentWorkflowScope,
  MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_AGENT_WORKFLOW_NAME_LENGTH,
  MAX_AGENT_WORKFLOW_PROMPT_BYTES,
  MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH,
  MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  MAX_AGENT_WORKFLOW_STEPS,
} from '../../entities/agent-workflow.js';
import { agents } from './agents.js';
import { users } from './auth.js';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';
import { projects, repositories } from './projects.js';
import { sessions } from './sessions.js';

/** Anchored to the shared vocabulary rather than re-typed, exactly as `agents.scope` is. */
const AGENT_WORKFLOW_SCOPES =
  AGENT_WORKFLOW_SCOPE_VOCABULARY satisfies readonly AgentWorkflowScope[];
const AGENT_SCOPES = AGENT_SCOPE_VOCABULARY satisfies readonly AgentScope[];
const RUN_STATES = AGENT_WORKFLOW_RUN_STATE_VOCABULARY satisfies readonly AgentWorkflowRunState[];
const RUN_STEP_STATES =
  AGENT_WORKFLOW_RUN_STEP_STATE_VOCABULARY satisfies readonly AgentWorkflowRunStepState[];
const HANDOFF_STATES =
  AGENT_WORKFLOW_HANDOFF_STATE_VOCABULARY satisfies readonly AgentWorkflowHandoffState[];

export const agentWorkflows = pgTable(
  'agent_workflows',
  {
    id: primaryKeyId(),
    name: text('name').notNull(),
    description: text('description'),

    /** PRD §5.6 as two kinds — see `entities/agent-workflow.ts`. No `session`. */
    scope: text('scope').notNull(),
    /** Set iff `scope = 'project'`. Cascades: a project's workflow has no meaning without it. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),

    /**
     * Retirement, and it is `archived_at` rather than a DELETE route — the Agent rule, not the
     * team rule, and the difference is which side is history.
     *
     * `agent_workflow_runs.workflow_id` records *which chain this run executed*, exactly as
     * `sessions.agent_id` records which persona a conversation ran as. Deleting the workflow
     * would rewrite that, so the FK is `RESTRICT` and there is no delete path. Archiving answers
     * the question a team's archive could not ("is an archived team still the project's team?"):
     * an archived workflow simply cannot be started, and every run it already produced is
     * untouched.
     */
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_agent_workflows_scope', sql`${table.scope} IN (${valueList(AGENT_WORKFLOW_SCOPES)})`),

    /**
     * Scope and target agree — the same invariant `ck_agents_scope_target` and
     * `ck_agent_teams_scope_target` state, said the same way so the three read as one rule.
     * `ELSE false` closes the vocabulary: a scope outside `AGENT_WORKFLOW_SCOPES` fails this
     * constraint even if `ck_agent_workflows_scope` were dropped.
     */
    check(
      'ck_agent_workflows_scope_target',
      sql`CASE ${table.scope}
            WHEN 'global'  THEN ${table.projectId} IS NULL
            WHEN 'project' THEN ${table.projectId} IS NOT NULL
            ELSE false
          END`,
    ),

    check(
      'ck_agent_workflows_name_length',
      sql`length(${table.name}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_NAME_LENGTH))}`,
    ),
    check(
      'ck_agent_workflows_description_length',
      sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH))}`,
    ),

    /**
     * One live workflow per name per target. Partial on `archived_at IS NULL` — the same shape as
     * `ux_agents_*_name`, and for the same reason: retiring a "Review chain" must free the name
     * for its replacement, which is what makes archive usable in place of delete.
     */
    uniqueIndex('ux_agent_workflows_global_name')
      .on(table.name)
      .where(sql`${table.scope} = 'global' AND ${table.archivedAt} IS NULL`),
    uniqueIndex('ux_agent_workflows_project_name')
      .on(table.projectId, table.name)
      .where(sql`${table.scope} = 'project' AND ${table.archivedAt} IS NULL`),

    /** The list route's two filters, and the FK index `project_id` needs anyway. */
    index('ix_agent_workflows_scope_project').on(table.scope, table.projectId),

    /**
     * Referenceable keys, not uniqueness rules — the same construction and reasoning as
     * `ux_agents_id_scope` / `ux_agent_teams_id_scope`. `agent_workflow_steps` carries a copy of
     * this workflow's scope and project, and these are what let a composite FK pin those copies
     * to the truth. Split into two indexes rather than one over `(id, scope, project_id)` because
     * a composite FK is skipped entirely when any referencing column is NULL (MATCH SIMPLE), and
     * `project_id` is NULL for every global workflow.
     */
    uniqueIndex('ux_agent_workflows_id_scope').on(table.id, table.scope),
    uniqueIndex('ux_agent_workflows_id_project').on(table.id, table.projectId),
  ],
);

/**
 * The chain itself: which Agent runs at which position, and what it is standing-ordered to do.
 *
 * `instructions` is the *step's* task ("review the previous step's diff for missing tests"), not
 * the agent's persona — that is `agents.instructions`, which becomes the runtime's system prompt.
 * Both reach the runtime, by different routes and at different times, and neither duplicates the
 * other: the persona says who is working, the step says what this position in the chain is for,
 * and the run's `task` says what the operator actually wants done.
 *
 * The four denormalized columns and their composite FKs are `agent_team_members`' construction
 * verbatim; the module header says why a CHECK cannot do this job on its own.
 */
export const agentWorkflowSteps = pgTable(
  'agent_workflow_steps',
  {
    id: primaryKeyId(),

    workflowId: uuid('workflow_id').notNull(),
    /** Copy of `agent_workflows.scope`, pinned by a composite FK. */
    workflowScope: text('workflow_scope').notNull(),
    /** Copy of `agent_workflows.project_id`; NULL iff global. Pinned by a composite FK. */
    workflowProjectId: uuid('workflow_project_id'),

    /** 0-based position in the chain. Bounded by `ck_agent_workflow_steps_ordinal`. */
    ordinal: integer('ordinal').notNull(),

    agentId: uuid('agent_id').notNull(),
    /** Copy of `agents.scope`, pinned by a composite FK. Never `session` — see the CHECK. */
    agentScope: text('agent_scope').notNull(),
    /** Copy of `agents.project_id`; NULL iff the agent is global. Pinned by a composite FK. */
    agentProjectId: uuid('agent_project_id'),

    /** This step's standing task. NULL means "the persona and the run's task are the brief". */
    instructions: text('instructions'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'agent_workflow_steps_workflow_scope_fk',
      columns: [table.workflowId, table.workflowScope],
      foreignColumns: [agentWorkflows.id, agentWorkflows.scope],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_workflow_steps_workflow_project_fk',
      columns: [table.workflowId, table.workflowProjectId],
      foreignColumns: [agentWorkflows.id, agentWorkflows.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_workflow_steps_agent_scope_fk',
      columns: [table.agentId, table.agentScope],
      foreignColumns: [agents.id, agents.scope],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_workflow_steps_agent_project_fk',
      columns: [table.agentId, table.agentProjectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete('cascade'),

    check(
      'ck_agent_workflow_steps_agent_scope_value',
      sql`${table.agentScope} IN (${valueList(AGENT_SCOPES)})`,
    ),

    /**
     * The workflow half of the copy is internally consistent: `workflow_project_id` is present
     * exactly when the workflow is project-scoped. Without it a project workflow's step could
     * record NULL and the agent rule below would then compare against nothing.
     */
    check(
      'ck_agent_workflow_steps_workflow_scope',
      sql`CASE ${table.workflowScope}
            WHEN 'global'  THEN ${table.workflowProjectId} IS NULL
            WHEN 'project' THEN ${table.workflowProjectId} IS NOT NULL
            ELSE false
          END`,
    ),

    /**
     * **The rule this table exists for.** A global agent fits any chain; a project agent fits only
     * its own project's chain; a session agent fits nothing, which `ELSE false` says by refusing
     * every scope this CASE does not name.
     *
     * `coalesce(..., false)` is load-bearing: a CHECK passes on NULL, so an unwrapped
     * `agent_project_id = workflow_project_id` would *accept* the row where either side is
     * missing — precisely the case this constraint catches.
     */
    check(
      'ck_agent_workflow_steps_agent_scope',
      sql`CASE ${table.agentScope}
            WHEN 'global'  THEN ${table.agentProjectId} IS NULL
            WHEN 'project' THEN coalesce(${table.agentProjectId} = ${table.workflowProjectId}, false)
            ELSE false
          END`,
    ),

    /** Spend bound 1, made structural: an eleventh step is unrepresentable. */
    check(
      'ck_agent_workflow_steps_ordinal',
      sql`${table.ordinal} BETWEEN 0 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_STEPS - 1))}`,
    ),
    check(
      'ck_agent_workflow_steps_instructions_length',
      sql`${table.instructions} IS NULL OR length(${table.instructions}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH))}`,
    ),

    /**
     * One step per position. **There is deliberately no unique index on `(workflow_id, agent_id)`
     * ** — `Developer → QA → Developer` is a legitimate chain, and a team's "a seat is held once"
     * rule does not transfer to a sequence.
     */
    uniqueIndex('ux_agent_workflow_steps_ordinal').on(table.workflowId, table.ordinal),
    /** "Which chains use this agent" — and the index the agent-side FKs want anyway. */
    index('ix_agent_workflow_steps_agent').on(table.agentId),
  ],
);

/**
 * One execution of one chain against one Project.
 *
 * A run is **operator-initiated** (PRD §15 keeps autonomous triggering in Phase 5), carries the
 * Session-shaped facts every step needs — working directory, branch, model, repository — and
 * bounds its own spend with `max_sessions`.
 *
 * `working_dir`, `branch` and `model` are on the run rather than on the workflow because they are
 * facts about *this execution*: the same review chain runs against two checkouts of the same
 * project, and a definition that pinned a path would be a definition that could only ever run in
 * one place.
 */
export const agentWorkflowRuns = pgTable(
  'agent_workflow_runs',
  {
    id: primaryKeyId(),

    /** `RESTRICT`: a run records which chain it executed, and that is history. */
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => agentWorkflows.id, { onDelete: 'restrict' }),
    /** `RESTRICT`, exactly as `sessions.project_id` — for the same reason and to the same effect. */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    /** Who started it. `RESTRICT`, mirroring `sessions.user_id`. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** The operator's goal, verbatim. Reaches every step; never summarised, never rewritten. */
    task: text('task').notNull(),
    workingDir: text('working_dir').notNull(),
    branch: text('branch'),
    model: text('model'),

    state: text('state').notNull().default('running'),

    /**
     * The definition's step count **at the moment this run started**.
     *
     * Snapshotted rather than counted at read time: a workflow edited tomorrow must not change
     * what yesterday's run did, and "step 3 of 4" has to keep saying 4 after a fifth step is
     * added. It is also what the runner compares the current ordinal against to decide the chain
     * is finished, so a mid-run edit cannot extend a run that is already under way.
     */
    stepCount: integer('step_count').notNull(),
    /** Spend bound 2 — see `ck_agent_workflow_runs_sessions_launched`. */
    maxSessions: integer('max_sessions').notNull(),
    sessionsLaunched: integer('sessions_launched').notNull().default(0),

    /** Why the run halted, in the runner's own words. NULL unless `state = 'halted'`. */
    haltReason: text('halt_reason'),

    startedAt: timestamptz('started_at').notNull().defaultNow(),
    /** The terminal moment — `completed`, `stopped`. NULL while `running` or `halted`. */
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_agent_workflow_runs_state', sql`${table.state} IN (${valueList(RUN_STATES)})`),
    check(
      'ck_agent_workflow_runs_task_length',
      sql`length(${table.task}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH))}`,
    ),
    check(
      'ck_agent_workflow_runs_step_count',
      sql`${table.stepCount} BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_STEPS))}`,
    ),
    check(
      'ck_agent_workflow_runs_max_sessions',
      sql`${table.maxSessions} BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_RUN_SESSIONS))}`,
    ),

    /**
     * **Spend bound 2, made structural.** A run can never record more launched Sessions than the
     * budget it was created with, so a runner bug that loops fails this UPDATE instead of
     * spending an operator's money. The counter is incremented in the same transaction that
     * writes the attempt row, which is why the constraint is the guarantee and the service check
     * is only the error message.
     */
    check(
      'ck_agent_workflow_runs_sessions_launched',
      sql`${table.sessionsLaunched} >= 0 AND ${table.sessionsLaunched} <= ${table.maxSessions}`,
    ),

    /**
     * `halt_reason` is present exactly when the run is halted, and `completed_at` exactly when it
     * is over. Two facts a reader would otherwise have to infer, made unrepresentable when wrong.
     *
     * `coalesce` on nothing here — every arm compares a column to NULL, which is a two-valued
     * test — but `ELSE false` still closes the vocabulary the same way the scope CHECKs do.
     */
    check(
      'ck_agent_workflow_runs_state_fields',
      sql`CASE ${table.state}
            WHEN 'running'   THEN ${table.haltReason} IS NULL     AND ${table.completedAt} IS NULL
            WHEN 'halted'    THEN ${table.haltReason} IS NOT NULL AND ${table.completedAt} IS NULL
            WHEN 'completed' THEN ${table.haltReason} IS NULL     AND ${table.completedAt} IS NOT NULL
            WHEN 'stopped'   THEN ${table.completedAt} IS NOT NULL
            ELSE false
          END`,
    ),

    /**
     * **Spend bound 3: one `running` run per Project.**
     *
     * Two chains editing one working tree concurrently is a merge conflict with a bill attached,
     * and the operator would have no way to tell which run wrote what. Partial on `running` alone
     * rather than on "not terminal": a `halted` run is spending nothing and holding nothing, so
     * blocking a project on one would punish the operator for a failure they are already dealing
     * with. Resuming a halted run while another is running hits this index at exactly the moment
     * it becomes dangerous, and answers `409`.
     */
    uniqueIndex('ux_agent_workflow_runs_active')
      .on(table.projectId)
      .where(sql`${table.state} = 'running'`),

    /** The list route's filters. `started_at DESC` is the only order this resource is read in. */
    index('ix_agent_workflow_runs_workflow').on(table.workflowId),
    index('ix_agent_workflow_runs_project_started').on(table.projectId, table.startedAt),
  ],
);

/**
 * One attempt at one step — **and the Session it is**.
 *
 * A retry is a new row rather than an overwritten one. F7 states never move backward, so
 * re-running a failed step means a *new* Session; reusing the row would silently drop the failed
 * Session's id and leave the operator with a run that claims a step succeeded on the first try.
 * `(run_id, ordinal, attempt)` is unique; the run's current position is the highest of both.
 *
 * `prompt` is the exact text sent to the step, stored because the launch and the prompt are
 * **separate moments**: a launch can be deferred by the concurrency semaphore (TDS 04 §6.2.1), and
 * the prompt is submitted when `session.started` arrives, which may be minutes later or after a
 * Backend restart. It is not exposed on the API — the Session's own transcript carries it as a
 * `messages` row the moment it is submitted, and shipping 200 KB of hand-off twice would be a
 * second copy of one fact.
 */
export const agentWorkflowRunSteps = pgTable(
  'agent_workflow_run_steps',
  {
    id: primaryKeyId(),

    runId: uuid('run_id')
      .notNull()
      .references(() => agentWorkflowRuns.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** 0 for the first try at this position; incremented by each resume. */
    attempt: integer('attempt').notNull().default(0),

    /** `RESTRICT`, exactly as `sessions.agent_id`: "this step ran as the Architect" is history. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    /**
     * The Session this step **is**. NOT NULL: the attempt row is written in the same transaction
     * as the Session, so an attempt without a Session is not a state this table can reach.
     * `RESTRICT` because Sessions are archived, never deleted.
     */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),

    state: text('state').notNull().default('running'),

    /** See `AGENT_WORKFLOW_HANDOFF_STATES` — the honesty flag on the crux of the feature. */
    handoffState: text('handoff_state').notNull(),
    /** Why the hand-off was degraded, in the words the prompt itself also carries. */
    handoffReason: text('handoff_reason'),

    /** The exact prompt sent to this step. Not serialized — see the header. */
    prompt: text('prompt').notNull(),
    /** When it was actually submitted; NULL while the launch is still waiting for a slot. */
    promptSentAt: timestamptz('prompt_sent_at'),

    /**
     * When the operator was told this step is waiting for them, and **the dedupe anchor for that
     * notification** (`workflow_step_waiting`).
     *
     * A step's Session goes idle every time a turn ends, and after the first notification the
     * operator either acts or is deliberately ignoring it — so this column is claimed by a
     * conditional `UPDATE … WHERE waiting_notified_at IS NULL` before the Notification is
     * produced, exactly as `prompt_sent_at` is claimed before the prompt is sent. Two turns
     * ending in one attempt therefore produce one page, and a Backend that crashes inside the
     * window loses the page rather than sending a second one: a duplicate alert is not
     * recoverable, and a missing one is — the run view still shows the step waiting.
     *
     * On the attempt row rather than on the Session because the *attempt* is what waits: a resume
     * re-runs the position in a new Session with a new row, and that step genuinely is a new thing
     * to be told about.
     */
    waitingNotifiedAt: timestamptz('waiting_notified_at'),

    /** The Session's failure reason, copied at halt so the run explains itself without a join. */
    error: text('error'),

    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'ck_agent_workflow_run_steps_state',
      sql`${table.state} IN (${valueList(RUN_STEP_STATES)})`,
    ),
    check(
      'ck_agent_workflow_run_steps_ordinal',
      sql`${table.ordinal} BETWEEN 0 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_STEPS - 1))}`,
    ),
    check('ck_agent_workflow_run_steps_attempt', sql`${table.attempt} >= 0`),

    /**
     * The hand-off document is internally consistent, and `ELSE false` closes the vocabulary.
     *
     * `degraded` **requires** a reason: a degraded hand-off with no explanation is exactly the
     * "plausible-looking gap" this feature must never produce, and a row that could hold one
     * would eventually hold one. `none` and `full` forbid a reason, because a reason attached to
     * a complete hand-off is a sentence that will be rendered somewhere and mean nothing.
     */
    check(
      'ck_agent_workflow_run_steps_handoff',
      sql`CASE ${table.handoffState}
            WHEN 'none'     THEN ${table.handoffReason} IS NULL
            WHEN 'full'     THEN ${table.handoffReason} IS NULL
            WHEN 'degraded' THEN ${table.handoffReason} IS NOT NULL
            ELSE false
          END`,
    ),

    /**
     * The prompt fits what `POST /sessions/{id}/prompts` will accept (TDS 04 §6.4, 256 KiB).
     *
     * `octet_length`, not `length`: the route measures UTF-8 bytes, and a hand-off full of code
     * fences and non-ASCII would otherwise pass here and be refused there — stranding a run at
     * the exact moment it tried to speak.
     */
    check(
      'ck_agent_workflow_run_steps_prompt_bytes',
      sql`octet_length(${table.prompt}) BETWEEN 1 AND ${sql.raw(String(MAX_AGENT_WORKFLOW_PROMPT_BYTES))}`,
    ),

    check(
      'ck_agent_workflow_run_steps_handoff_state_value',
      sql`${table.handoffState} IN (${valueList(HANDOFF_STATES)})`,
    ),

    uniqueIndex('ux_agent_workflow_run_steps_attempt').on(
      table.runId,
      table.ordinal,
      table.attempt,
    ),

    /**
     * **One Session belongs to at most one attempt**, and this is what makes the event-driven
     * advance unambiguous: `session.completed` carries a `sessionId`, and the runner turns it into
     * "which run, which step" through exactly this index. Without it two runs could claim one
     * Session and the advance would be a coin toss.
     */
    uniqueIndex('ux_agent_workflow_run_steps_session').on(table.sessionId),
    index('ix_agent_workflow_run_steps_run').on(table.runId, table.ordinal),
  ],
);
