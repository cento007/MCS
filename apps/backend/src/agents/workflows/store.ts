import {
  type AgentWorkflowHandoffState,
  type AgentWorkflowRunState,
  type AgentWorkflowRunStepState,
  type AgentWorkflowScope,
  type DbTransaction,
  type EntityId,
  newId,
  schema,
} from '@mc/shared';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { AgentRow, DbLike } from '../store.js';

/**
 * Every `agent_workflows`, `agent_workflow_steps`, `agent_workflow_runs` and
 * `agent_workflow_run_steps` read and write, in one module — the containment `agents/store.ts`
 * and `agents/teams/store.ts` both keep for their tables.
 *
 * **There is no delete for a workflow**, exactly as there is none for an agent, and for the same
 * reason: `agent_workflow_runs.workflow_id` is history. Retirement is `archived_at`, written by
 * `updateWorkflow`. A run *is* deletable in principle (nothing points at one but its own attempt
 * rows) and there is deliberately no function for it either — a run is the record of money spent.
 *
 * The step writer is a **replace-the-set** operation for the same reason the team roster's is:
 * `PATCH /agent-workflows/{id}` carries the whole chain, so the write that serves it is "make the
 * table say this". Unlike a roster, order is part of the value, so the replacement is positional.
 */

export type AgentWorkflowRow = typeof schema.agentWorkflows.$inferSelect;
export type AgentWorkflowStepRow = typeof schema.agentWorkflowSteps.$inferSelect;
export type AgentWorkflowRunRow = typeof schema.agentWorkflowRuns.$inferSelect;
export type AgentWorkflowRunStepRow = typeof schema.agentWorkflowRunSteps.$inferSelect;

/** One step, joined to the agent it names — everything the resource shows, nothing heavier. */
export interface WorkflowStepView {
  readonly workflowId: string;
  readonly ordinal: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentScope: string;
  readonly agentProjectId: string | null;
  readonly agentArchivedAt: Date | null;
  readonly instructions: string | null;
}

export interface InsertWorkflowInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentWorkflowScope;
  readonly projectId: string | null;
}

/** Everything mutable. `scope` and `project_id` are not: see `service.ts`. */
export type AgentWorkflowUpdate = Partial<{
  name: string;
  description: string | null;
  archivedAt: Date | null;
}>;

export interface ListWorkflowsFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string;
  readonly scope?: AgentWorkflowScope;
  readonly projectId?: string;
  readonly includeArchived?: boolean;
}

// ------------------------------------------------------------------------------- definitions

export async function listWorkflows(
  db: DbLike,
  filters: ListWorkflowsFilters,
): Promise<AgentWorkflowRow[]> {
  const conditions = [];
  if (filters.scope !== undefined) conditions.push(eq(schema.agentWorkflows.scope, filters.scope));
  if (filters.projectId !== undefined) {
    conditions.push(eq(schema.agentWorkflows.projectId, filters.projectId));
  }
  if (filters.includeArchived !== true) {
    conditions.push(isNull(schema.agentWorkflows.archivedAt));
  }
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.agentWorkflows.id, filters.afterId)
        : gt(schema.agentWorkflows.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.agentWorkflows)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(
      filters.order === 'desc' ? desc(schema.agentWorkflows.id) : asc(schema.agentWorkflows.id),
    )
    .limit(filters.limit);
}

export async function findWorkflowById(db: DbLike, id: string): Promise<AgentWorkflowRow | null> {
  const rows = await db
    .select()
    .from(schema.agentWorkflows)
    .where(eq(schema.agentWorkflows.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The steps of every named workflow, joined to `agents`, **ordered by ordinal**.
 *
 * The ordering is the value here, not a convenience: a team's members are returned by name
 * because a team is a set, and a chain returned in any other order than its own would be a
 * different chain.
 */
export async function listWorkflowSteps(
  db: DbLike,
  workflowIds: readonly string[],
): Promise<WorkflowStepView[]> {
  if (workflowIds.length === 0) return [];

  return db
    .select({
      workflowId: schema.agentWorkflowSteps.workflowId,
      ordinal: schema.agentWorkflowSteps.ordinal,
      agentId: schema.agents.id,
      agentName: schema.agents.name,
      agentScope: schema.agents.scope,
      agentProjectId: schema.agents.projectId,
      agentArchivedAt: schema.agents.archivedAt,
      instructions: schema.agentWorkflowSteps.instructions,
    })
    .from(schema.agentWorkflowSteps)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentWorkflowSteps.agentId))
    .where(inArray(schema.agentWorkflowSteps.workflowId, [...workflowIds]))
    .orderBy(asc(schema.agentWorkflowSteps.workflowId), asc(schema.agentWorkflowSteps.ordinal));
}

export async function insertWorkflow(
  db: DbLike,
  input: InsertWorkflowInput,
): Promise<AgentWorkflowRow> {
  const rows = await db
    .insert(schema.agentWorkflows)
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
  if (row === undefined) throw new Error('Agent workflow insert returned no row');
  return row;
}

export async function updateWorkflow(
  tx: DbTransaction,
  id: string,
  changes: AgentWorkflowUpdate,
): Promise<AgentWorkflowRow | null> {
  const rows = await tx
    .update(schema.agentWorkflows)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(schema.agentWorkflows.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Touch `updated_at` without changing a field — a chain change is a change to the workflow. */
export async function touchWorkflow(
  tx: DbTransaction,
  id: string,
): Promise<AgentWorkflowRow | null> {
  const rows = await tx
    .update(schema.agentWorkflows)
    .set({ updatedAt: new Date() })
    .where(eq(schema.agentWorkflows.id, id))
    .returning();
  return rows[0] ?? null;
}

export interface StepInput {
  readonly agent: AgentRow;
  readonly instructions: string | null;
}

/**
 * Make the chain exactly `steps` — delete everything, then insert positionally.
 *
 * Delete-then-insert rather than an upsert keyed on ordinal, because reordering a chain moves
 * every row: `Developer → QA` becoming `QA → Developer` is two updates that would transiently
 * violate `ux_agent_workflow_steps_ordinal` in whichever order they ran. Wiping first is one
 * statement, cannot collide with itself, and is inside the caller's transaction.
 *
 * The four denormalized columns are written here from the rows the caller already loaded, and
 * nowhere else. They are not trusted afterwards: the composite FKs reject any copy that disagrees
 * with its source, so a bug in this function fails the INSERT rather than producing a step that
 * lies about its agent's scope.
 */
export async function replaceWorkflowSteps(
  tx: DbTransaction,
  workflow: AgentWorkflowRow,
  steps: readonly StepInput[],
): Promise<void> {
  await tx
    .delete(schema.agentWorkflowSteps)
    .where(eq(schema.agentWorkflowSteps.workflowId, workflow.id));

  if (steps.length === 0) return;

  await tx.insert(schema.agentWorkflowSteps).values(
    steps.map((step, ordinal) => ({
      id: newId(),
      workflowId: workflow.id,
      workflowScope: workflow.scope,
      workflowProjectId: workflow.projectId,
      ordinal,
      agentId: step.agent.id,
      agentScope: step.agent.scope,
      agentProjectId: step.agent.projectId,
      instructions: step.instructions,
    })),
  );
}

// -------------------------------------------------------------------------------------- runs

export interface InsertRunInput {
  readonly id?: EntityId;
  readonly workflowId: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly userId: string;
  readonly task: string;
  readonly workingDir: string;
  readonly branch: string | null;
  readonly model: string | null;
  readonly stepCount: number;
  readonly maxSessions: number;
}

export async function insertRun(
  tx: DbTransaction,
  input: InsertRunInput,
): Promise<AgentWorkflowRunRow> {
  const rows = await tx
    .insert(schema.agentWorkflowRuns)
    .values({
      id: input.id ?? newId(),
      workflowId: input.workflowId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      task: input.task,
      workingDir: input.workingDir,
      branch: input.branch,
      model: input.model,
      state: 'running',
      stepCount: input.stepCount,
      maxSessions: input.maxSessions,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Agent workflow run insert returned no row');
  return row;
}

export type AgentWorkflowRunUpdate = Partial<{
  state: AgentWorkflowRunState;
  haltReason: string | null;
  completedAt: Date | null;
}>;

export async function updateRun(
  tx: DbTransaction,
  id: string,
  changes: AgentWorkflowRunUpdate,
): Promise<AgentWorkflowRunRow | null> {
  const rows = await tx
    .update(schema.agentWorkflowRuns)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(schema.agentWorkflowRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Claim one Session from the run's budget.
 *
 * `sessions_launched = sessions_launched + 1` computed **in the database**, not read-modify-write
 * in the service: two advances that somehow overlapped would otherwise both read `2` and both
 * write `3`, and the budget would leak one Session per race.
 * `ck_agent_workflow_runs_sessions_launched` is what actually stops the run from exceeding it —
 * this statement raises rather than returning a row that is over.
 */
export async function claimRunSession(
  tx: DbTransaction,
  id: string,
): Promise<AgentWorkflowRunRow | null> {
  const rows = await tx
    .update(schema.agentWorkflowRuns)
    .set({
      sessionsLaunched: sql`${schema.agentWorkflowRuns.sessionsLaunched} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.agentWorkflowRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function findRunById(db: DbLike, id: string): Promise<AgentWorkflowRunRow | null> {
  const rows = await db
    .select()
    .from(schema.agentWorkflowRuns)
    .where(eq(schema.agentWorkflowRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `SELECT … FOR UPDATE` on one run.
 *
 * The advance path reads a run, decides what to do and writes the decision; two deliveries of the
 * same `session.completed` (at-least-once, F6.3) would otherwise both read `running` and both
 * launch the next step. This is the same serialization `lockSessionById` gives the F7 state
 * machine, for the same reason.
 */
export async function lockRunById(
  tx: DbTransaction,
  id: string,
): Promise<AgentWorkflowRunRow | null> {
  const rows = await tx
    .select()
    .from(schema.agentWorkflowRuns)
    .where(eq(schema.agentWorkflowRuns.id, id))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export interface ListRunsFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string;
  readonly workflowId?: string;
  readonly projectId?: string;
  readonly state?: AgentWorkflowRunState;
}

export async function listRuns(
  db: DbLike,
  filters: ListRunsFilters,
): Promise<AgentWorkflowRunRow[]> {
  const conditions = [];
  if (filters.workflowId !== undefined) {
    conditions.push(eq(schema.agentWorkflowRuns.workflowId, filters.workflowId));
  }
  if (filters.projectId !== undefined) {
    conditions.push(eq(schema.agentWorkflowRuns.projectId, filters.projectId));
  }
  if (filters.state !== undefined)
    conditions.push(eq(schema.agentWorkflowRuns.state, filters.state));
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.agentWorkflowRuns.id, filters.afterId)
        : gt(schema.agentWorkflowRuns.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.agentWorkflowRuns)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(
      filters.order === 'desc'
        ? desc(schema.agentWorkflowRuns.id)
        : asc(schema.agentWorkflowRuns.id),
    )
    .limit(filters.limit);
}

/** Every non-terminal run of one workflow — what refuses an edit to a chain that is in flight. */
export async function findActiveRunsForWorkflow(
  db: DbLike,
  workflowId: string,
): Promise<AgentWorkflowRunRow[]> {
  return db
    .select()
    .from(schema.agentWorkflowRuns)
    .where(
      and(
        eq(schema.agentWorkflowRuns.workflowId, workflowId),
        inArray(schema.agentWorkflowRuns.state, ['running', 'halted']),
      ),
    )
    .orderBy(desc(schema.agentWorkflowRuns.startedAt))
    .limit(5);
}

// --------------------------------------------------------------------------------- attempts

export interface InsertRunStepInput {
  readonly id?: EntityId;
  readonly runId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly handoffState: AgentWorkflowHandoffState;
  readonly handoffReason: string | null;
  readonly prompt: string;
}

export async function insertRunStep(
  tx: DbTransaction,
  input: InsertRunStepInput,
): Promise<AgentWorkflowRunStepRow> {
  const rows = await tx
    .insert(schema.agentWorkflowRunSteps)
    .values({
      id: input.id ?? newId(),
      runId: input.runId,
      ordinal: input.ordinal,
      attempt: input.attempt,
      agentId: input.agentId,
      sessionId: input.sessionId,
      state: 'running',
      handoffState: input.handoffState,
      handoffReason: input.handoffReason,
      prompt: input.prompt,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Agent workflow run step insert returned no row');
  return row;
}

export type AgentWorkflowRunStepUpdate = Partial<{
  state: AgentWorkflowRunStepState;
  error: string | null;
  completedAt: Date | null;
  promptSentAt: Date | null;
}>;

export async function updateRunStep(
  tx: DbTransaction,
  id: string,
  changes: AgentWorkflowRunStepUpdate,
): Promise<AgentWorkflowRunStepRow | null> {
  const rows = await tx
    .update(schema.agentWorkflowRunSteps)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(schema.agentWorkflowRunSteps.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * The attempt a Session belongs to — **the whole of the event-driven advance's routing**.
 *
 * `session.completed` carries a `sessionId` and nothing else that matters here;
 * `ux_agent_workflow_run_steps_session` guarantees this returns at most one row, so "which run,
 * which step" is a lookup rather than a guess.
 */
export async function findRunStepBySessionId(
  db: DbLike,
  sessionId: string,
): Promise<AgentWorkflowRunStepRow | null> {
  const rows = await db
    .select()
    .from(schema.agentWorkflowRunSteps)
    .where(eq(schema.agentWorkflowRunSteps.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/** One attempt, whole — **including `prompt`**, which the API projection deliberately omits. */
export async function findRunStepById(
  db: DbLike,
  id: string,
): Promise<AgentWorkflowRunStepRow | null> {
  const rows = await db
    .select()
    .from(schema.agentWorkflowRunSteps)
    .where(eq(schema.agentWorkflowRunSteps.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** The furthest attempt of a run — the highest ordinal, and within it the highest attempt. */
export async function findLatestRunStep(
  db: DbLike,
  runId: string,
): Promise<AgentWorkflowRunStepRow | null> {
  const rows = await db
    .select()
    .from(schema.agentWorkflowRunSteps)
    .where(eq(schema.agentWorkflowRunSteps.runId, runId))
    .orderBy(desc(schema.agentWorkflowRunSteps.ordinal), desc(schema.agentWorkflowRunSteps.attempt))
    .limit(1);
  return rows[0] ?? null;
}

/** One attempt as the API shows it — every column **except** the prompt. See `RunStepView`. */
export interface RunStepView {
  readonly runId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly state: string;
  readonly handoffState: string;
  readonly handoffReason: string | null;
  /** `octet_length(prompt)`, computed in SQL — the fact, without shipping the document. */
  readonly promptBytes: number;
  readonly promptSentAt: Date | null;
  readonly error: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

/**
 * The attempts of every named run, for the API.
 *
 * **`prompt` is deliberately not selected.** A hand-off is up to 256 KiB, and a page of fifty runs
 * would otherwise read tens of megabytes to serve a progress list. Its *size* is the fact a client
 * needs (it is how "the hand-off was truncated" becomes visible), and `octet_length` answers that
 * in the database. The text itself is already on the Session as a `messages` row the moment it is
 * submitted, which is where a reader should see it in context.
 */
export async function listRunSteps(db: DbLike, runIds: readonly string[]): Promise<RunStepView[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select({
      runId: schema.agentWorkflowRunSteps.runId,
      ordinal: schema.agentWorkflowRunSteps.ordinal,
      attempt: schema.agentWorkflowRunSteps.attempt,
      agentId: schema.agentWorkflowRunSteps.agentId,
      sessionId: schema.agentWorkflowRunSteps.sessionId,
      state: schema.agentWorkflowRunSteps.state,
      handoffState: schema.agentWorkflowRunSteps.handoffState,
      handoffReason: schema.agentWorkflowRunSteps.handoffReason,
      promptBytes: sql<string>`octet_length(${schema.agentWorkflowRunSteps.prompt})`,
      promptSentAt: schema.agentWorkflowRunSteps.promptSentAt,
      error: schema.agentWorkflowRunSteps.error,
      startedAt: schema.agentWorkflowRunSteps.startedAt,
      completedAt: schema.agentWorkflowRunSteps.completedAt,
    })
    .from(schema.agentWorkflowRunSteps)
    .where(inArray(schema.agentWorkflowRunSteps.runId, [...runIds]))
    .orderBy(
      asc(schema.agentWorkflowRunSteps.runId),
      asc(schema.agentWorkflowRunSteps.ordinal),
      asc(schema.agentWorkflowRunSteps.attempt),
    );

  return rows.map((row) => ({ ...row, promptBytes: Number(row.promptBytes) }));
}

/**
 * Attempts whose prompt was never submitted, for Sessions that are `running` right now.
 *
 * The gap this closes is real and not hypothetical: the prompt is submitted when
 * `session.started` arrives on the **in-process** bus, which has no durability guarantee (F6.3),
 * so a Backend that restarts between the launch and the start leaves a live Claude Code session
 * that was never told what to do. Swept at startup, which is where `reclaimAbandonedSyncRuns`
 * does the equivalent job for memory runs.
 */
export async function findUnpromptedRunSteps(
  db: DbLike,
  limit: number,
): Promise<AgentWorkflowRunStepRow[]> {
  return db
    .select({ step: schema.agentWorkflowRunSteps })
    .from(schema.agentWorkflowRunSteps)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.agentWorkflowRunSteps.sessionId))
    .innerJoin(
      schema.agentWorkflowRuns,
      eq(schema.agentWorkflowRuns.id, schema.agentWorkflowRunSteps.runId),
    )
    .where(
      and(
        eq(schema.agentWorkflowRunSteps.state, 'running'),
        isNull(schema.agentWorkflowRunSteps.promptSentAt),
        eq(schema.sessions.state, 'running'),
        eq(schema.agentWorkflowRuns.state, 'running'),
      ),
    )
    .orderBy(asc(schema.agentWorkflowRunSteps.id))
    .limit(limit)
    .then((rows) => rows.map((row) => row.step));
}

// ------------------------------------------------------------------------------ cost history

/** What one agent's completed Sessions have actually cost. Measured, never modelled. */
export interface AgentCostHistory {
  readonly agentId: string;
  readonly sessionCount: number;
  readonly meanUsd: number;
  readonly maxUsd: number;
}

/**
 * Observed cost per agent, from `sessions.total_cost_usd`.
 *
 * **This is the only honest answer to "what will this run cost me".** Nothing in this product can
 * predict a model's spend, so the estimate is history: how much this agent's own Sessions have
 * cost before. Where there is no history there is `null` and the endpoint says so, rather than a
 * number assembled from an average of unrelated work — the same rule the context package follows
 * when it will not summarise.
 *
 * Sessions with a NULL cost (observed ones, and managed ones that never ran a turn) are excluded
 * rather than counted as zero, which is what `GET /spend` does for the identical reason.
 */
export async function readAgentCostHistory(
  db: DbLike,
  agentIds: readonly string[],
): Promise<AgentCostHistory[]> {
  if (agentIds.length === 0) return [];

  const rows = await db
    .select({
      agentId: schema.sessions.agentId,
      sessionCount: sql<string>`count(*)`,
      meanUsd: sql<string>`avg(${schema.sessions.totalCostUsd})`,
      maxUsd: sql<string>`max(${schema.sessions.totalCostUsd})`,
    })
    .from(schema.sessions)
    .where(
      and(
        inArray(schema.sessions.agentId, [...agentIds]),
        sql`${schema.sessions.totalCostUsd} IS NOT NULL`,
      ),
    )
    .groupBy(schema.sessions.agentId);

  return rows.flatMap((row) =>
    row.agentId === null
      ? []
      : [
          {
            agentId: row.agentId,
            sessionCount: Number(row.sessionCount),
            meanUsd: Number(row.meanUsd),
            maxUsd: Number(row.maxUsd),
          },
        ],
  );
}
