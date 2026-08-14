import {
  createJob,
  type Db,
  defaultAgentWorkflowRunSessions,
  type EventEnvelope,
  type EventType,
  type JobPayload,
  QUEUE_NAMES,
  type Queue,
  type Unsubscribe,
} from '@mc/shared';
import { recordAuditEntry } from '../../audit/index.js';
import { isUniqueViolation } from '../../db/index.js';
import type { EventBus, Outbox, OutboxTransaction } from '../../events/index.js';
import type { RequestContext } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { projectExists } from '../store.js';
import { buildHandoff, type PreviousStep } from './handoff.js';
import type {
  WorkflowActor,
  WorkflowHandoffPort,
  WorkflowPromptPort,
  WorkflowSessionPort,
} from './ports.js';
import { type AgentWorkflowRunResource, serializeRun } from './serialize.js';
import type { AgentWorkflowService } from './service.js';
import {
  type AgentWorkflowRow,
  type AgentWorkflowRunRow,
  type AgentWorkflowRunStepRow,
  claimRunSession,
  findLatestRunStep,
  findRunById,
  findRunStepById,
  findRunStepBySessionId,
  findUnpromptedRunSteps,
  insertRun,
  insertRunStep,
  listRunSteps,
  listRuns,
  listWorkflowSteps,
  lockRunById,
  updateRun,
  updateRunStep,
  type WorkflowStepView,
} from './store.js';
import { assertMaxSessions, normalizeRunTask } from './validation.js';

/**
 * **Running a workflow** — PRD §5.6's chain, executed.
 *
 * ## The four decisions this file is
 *
 * **1. A step is a Session, and the advance is event-driven.** Each step is a managed Session
 * bound to that step's Agent. The run learns a step is over from `session.completed` /
 * `session.failed` on the in-process post-commit bus — the same two events `memory/indexing.ts`
 * already subscribes to, consumed the same way: the listener does one cheap lookup and enqueues a
 * job to `agent_workflow.advance`, a queue with **exactly one consuming process** (arbitration
 * A16). The Backend is that process because the work is "generate a context package, create a
 * Session, launch it", and all three live here.
 *
 * There is no polling, no timer and no second lifecycle. F7 remains the only state machine that
 * decides when work is finished; this file only asks what to do next.
 *
 * **2. A managed Session does not complete itself, and the run does not pretend otherwise.** A
 * turn ending is not a session ending: `ManagedSessionController` explicitly keeps the Session
 * `running` after a `result` event, because Claude Code routinely ends a turn asking a question.
 * So a step finishes when the **operator ends it** (`POST /sessions/{id}/end`) or when it fails.
 * That is not a limitation worked around — it is the Phase 4 shape: PRD §15 puts autonomous
 * review flows in Phase 5, and auto-ending a step on turn completion would hand QA a Developer
 * step that stopped mid-question, which is exactly the plausible-looking gap this slice refuses to
 * produce. What the run automates is everything *between* steps: the context package, the Session,
 * the agent binding, the launch and the prompt.
 *
 * **3. Failure halts, and a halted run is not a dead row.** A failed step stops the chain with a
 * reason on the run. The operator fixes what broke and calls `POST /{id}/resume`, which re-runs
 * the failed step in a **new** Session (F7 states never move backward) as a new attempt, and the
 * chain continues. Nothing is lost: the failed attempt keeps its own row and its own Session.
 *
 * **4. Stop is a kill switch, and it stops the spend.** Stopping marks the run `stopped` **first**,
 * in its own transaction, and then closes the in-flight Session — so the `session.completed` that
 * results finds a run that is no longer `running` and advances nothing. Closing the Session is what
 * actually disposes the runtime; a "stopped" run whose Claude Code process was still writing to
 * the repository would be a lie with a bill attached.
 *
 * That last sentence used to be false in one case. A step whose Session was still `created` —
 * queued behind the concurrency semaphore — was **left alone**, because F7 has no
 * `created -> completed` edge and nothing could revoke a queued launch. The run read `stopped`
 * while its `session.launch` job was still live, so the next free slot spawned Claude Code for a
 * run nobody was watching. `SessionService.cancel` is the missing exit, and Stop now takes it.
 */

/** The `agent_workflow.advance` job payload. A job name, not an event (TDS 04 §15.2). */
export type AgentWorkflowAdvanceJob =
  /** A step's Session reached a terminal state. `outcome` is carried so the handler never races. */
  | {
      readonly kind: 'advance';
      readonly runId: string;
      readonly sessionId: string;
      readonly outcome: 'completed' | 'failed';
      readonly reason: string | null;
    }
  /** The operator resumed a halted run; work out where it was and carry on. */
  | { readonly kind: 'resume'; readonly runId: string }
  /** A step's Session reached `running`; submit the prompt that was built when it was created. */
  | { readonly kind: 'prompt'; readonly runStepId: string };

/** The three lifecycle events the runner listens for. Nothing else reaches it. */
export const RUN_TRIGGER_EVENTS: readonly EventType[] = Object.freeze([
  'session.started',
  'session.completed',
  'session.failed',
]);

export interface CreateRunInput {
  readonly workflowId: string;
  readonly projectId: string;
  readonly task: string;
  readonly workingDirectory: string;
  readonly repositoryId?: string | undefined;
  readonly branch?: string | undefined;
  readonly model?: string | undefined;
  readonly maxSessions?: number | undefined;
}

export interface ListRunsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly workflowId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly state?: 'running' | 'completed' | 'halted' | 'stopped' | undefined;
}

/**
 * What a Stop did to the Session that was in flight. Reported in the response `meta`.
 *
 * `cancelled` replaced `left_unstarted`, and the rename is the fix rather than a description of
 * it. `left_unstarted` was accurate about what the endpoint did — nothing — and that was the
 * defect: the Session stayed `created` with a live `session.launch` job behind it, so a "stopped"
 * run could still spawn a Claude Code process, take a `maxConcurrentSessions` slot and sit there
 * until someone ended it by hand.
 */
export type StoppedSessionOutcome = 'ended' | 'cancelled' | 'already_terminal';

export interface StopResult {
  readonly run: AgentWorkflowRunResource;
  readonly stoppedSession: {
    readonly sessionId: string;
    readonly outcome: StoppedSessionOutcome;
  } | null;
}

export interface AgentWorkflowRunServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly bus: EventBus;
  readonly queue: Queue;
  readonly workflows: AgentWorkflowService;
  readonly sessions: WorkflowSessionPort;
  /** `null` when this Backend has no managed runtime — a run is then refused up front. */
  readonly prompts: WorkflowPromptPort | null;
  readonly handoff: WorkflowHandoffPort;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

/** How many stranded prompts the startup sweep repairs in one pass. */
const PROMPT_SWEEP_LIMIT = 50;

export class AgentWorkflowRunService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #bus: EventBus;
  readonly #queue: Queue;
  readonly #workflows: AgentWorkflowService;
  readonly #sessions: WorkflowSessionPort;
  readonly #prompts: WorkflowPromptPort | null;
  readonly #handoff: WorkflowHandoffPort;
  readonly #now: () => Date;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  #unsubscribeJobs: Unsubscribe | null = null;
  #unsubscribeBus: (() => void)[] = [];

  constructor(options: AgentWorkflowRunServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#bus = options.bus;
    this.#queue = options.queue;
    this.#workflows = options.workflows;
    this.#sessions = options.sessions;
    this.#prompts = options.prompts;
    this.#handoff = options.handoff;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
  }

  // ------------------------------------------------------------------------------- lifecycle

  /** Subscribe the single job consumer and the three event triggers, then repair what is stuck. */
  async start(): Promise<void> {
    this.#unsubscribeJobs ??= await this.#queue.subscribeJobs<AgentWorkflowAdvanceJob & JobPayload>(
      QUEUE_NAMES.AGENT_WORKFLOW_ADVANCE,
      async (job) => {
        await this.handle(job.payload);
      },
      // Serial: two advances of one run can never overlap. The real guarantee is
      // `lockRunById` plus `ux_agent_workflow_run_steps_attempt`; this keeps the common case
      // cheap and the logs readable.
      { concurrency: 1 },
    );

    this.#unsubscribeBus = RUN_TRIGGER_EVENTS.map((type) =>
      this.#bus.on(type, (event) => {
        void this.#onEvent(event).catch((error: unknown) => {
          this.#onError?.(error, `workflow trigger for ${type}`);
        });
      }),
    );

    await this.sweepStrandedPrompts();
  }

  /**
   * Release the subscriptions.
   *
   * Named `shutdown` rather than `stop` because `stop` on this class is the operator's kill
   * switch, and one word meaning both "release the process's listeners" and "abort this run and
   * end its Claude Code session" is the kind of collision that gets called from the wrong place
   * exactly once.
   */
  async shutdown(): Promise<void> {
    for (const unsubscribe of this.#unsubscribeBus) unsubscribe();
    this.#unsubscribeBus = [];
    const unsubscribe = this.#unsubscribeJobs;
    this.#unsubscribeJobs = null;
    // Awaited, unlike `MemoryIndexService.stop`, because **this queue's consumer must provably be
    // gone before another one subscribes**. pg-boss is a competing-consumer substrate: two live
    // consumers of `agent_workflow.advance` steal each other's jobs, and the loser is a run that
    // silently never advances. It is also what makes the integration tier honest - each test case
    // builds its own app, and a leaked worker from the previous one would answer for it.
    if (unsubscribe !== null) await unsubscribe();
  }

  /**
   * Repair steps whose Session is live and was never told what to do.
   *
   * The prompt is submitted when `session.started` arrives on the **in-process** bus, which has no
   * durability guarantee (F6.3) — so a Backend that restarts between the launch and the start
   * leaves a running Claude Code session with an empty inbox and a run that will wait for it
   * forever. The predicate is deliberately *the transcript*, not `prompt_sent_at`: a crash between
   * marking and sending would set the column for a prompt that never arrived, and the transcript
   * is the only witness that cannot be wrong. Where the two disagree, the column is reset and the
   * job re-enqueued.
   *
   * Same job `reclaimAbandonedSyncRuns` does for memory runs, at the same moment, for the same
   * reason.
   */
  async sweepStrandedPrompts(): Promise<number> {
    const stranded = await findUnpromptedRunSteps(this.#db, PROMPT_SWEEP_LIMIT);
    for (const step of stranded) {
      await this.#outbox.run(async (tx) => {
        await updateRunStep(tx.tx, step.id, { promptSentAt: null });
      });
      await this.#enqueue({ kind: 'prompt', runStepId: step.id });
    }
    return stranded.length;
  }

  // -------------------------------------------------------------------------------- API reads

  async get(id: string): Promise<AgentWorkflowRunResource> {
    const [resource] = await this.#hydrate([await this.#require(id)]);
    /* c8 ignore next */
    if (resource === undefined) throw new ApiError('NOT_FOUND', `No workflow run with id ${id}`);
    return resource;
  }

  async list(input: ListRunsApiInput): Promise<AgentWorkflowRunResource[]> {
    const rows = await listRuns(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return this.#hydrate(rows);
  }

  // ------------------------------------------------------------------------------ API writes

  /**
   * `POST /api/v1/agent-workflow-runs` -> `201`.
   *
   * Everything that can be refused is refused **before** a Session exists, because every refusal
   * discovered at step 3 has already spent money on steps 1 and 2. In order: the Backend can run
   * managed Sessions at all; the workflow is live and in scope for this Project; every step's
   * Agent is live; the budget can pay for the chain; and no other run is already running here.
   */
  async create(
    actor: WorkflowActor,
    input: CreateRunInput,
    ctx: RequestContext,
  ): Promise<AgentWorkflowRunResource> {
    if (this.#prompts === null) {
      throw new ApiError(
        'RUNTIME_UNAVAILABLE',
        'This Backend has no managed Claude Code runtime, so a workflow run has nothing to launch',
      );
    }

    const workflow = await this.#workflows.require(input.workflowId);
    const task = normalizeRunTask(input.task);

    if (workflow.archivedAt !== null) {
      throw new ApiError('CONFLICT', 'This workflow is archived and cannot be run', {
        workflowId: workflow.id,
      });
    }
    if (!(await projectExists(this.#db, input.projectId))) {
      throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
        field: 'projectId',
      });
    }
    // A project-scoped chain contains that project's own agents, so running it anywhere else
    // would bind an Agent the session path refuses — the same leak `ck_agent_team_assignments_
    // scope` prevents for teams, arriving from the other direction.
    if (workflow.scope === 'project' && workflow.projectId !== input.projectId) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'A project-scoped workflow can only be run in its own project',
        { field: 'projectId', workflowProjectId: workflow.projectId },
      );
    }

    const steps = await listWorkflowSteps(this.#db, [workflow.id]);
    if (steps.length === 0) {
      throw new ApiError('CONFLICT', 'This workflow has no steps, so there is nothing to run', {
        workflowId: workflow.id,
      });
    }

    // Checked here, once, for the whole chain. Discovering at step 3 that step 4's agent was
    // retired last week means two Sessions of spend for a run that could never finish.
    const archived = steps.find((step) => step.agentArchivedAt !== null);
    if (archived !== undefined) {
      throw new ApiError(
        'CONFLICT',
        `Step ${String(archived.ordinal + 1)} names an archived agent ("${archived.agentName}"); ` +
          'un-archive it or edit the workflow before running it',
        { agentId: archived.agentId, ordinal: archived.ordinal },
      );
    }

    const maxSessions = input.maxSessions ?? defaultAgentWorkflowRunSessions(steps.length);
    assertMaxSessions(maxSessions, steps.length);

    const run = await this.#outbox
      .run(async (tx) => {
        const row = await insertRun(tx.tx, {
          workflowId: workflow.id,
          projectId: input.projectId,
          repositoryId: input.repositoryId ?? null,
          userId: actor.userId,
          task,
          workingDir: input.workingDirectory,
          branch: input.branch ?? null,
          model: input.model ?? null,
          stepCount: steps.length,
          maxSessions,
        });

        await tx.emit(
          this.#outbox.event(
            'agent_workflow.run.started',
            {
              runId: row.id,
              workflowId: workflow.id,
              projectId: row.projectId,
              stepCount: row.stepCount,
              maxSessions: row.maxSessions,
              resumed: false,
            },
            { correlationId: row.id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: actor.userId,
          action: 'agent_workflow.run.started',
          entityType: 'agent_workflow_runs',
          entityId: row.id,
          after: {
            workflowId: workflow.id,
            projectId: row.projectId,
            stepCount: row.stepCount,
            maxSessions: row.maxSessions,
            agentIds: steps.map((step) => step.agentId),
          },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return row;
      })
      .catch((error: unknown) => {
        throw asActiveRunConflict(error);
      });

    // Outside the transaction: this spawns a process. A failure here halts the run rather than
    // failing the request — the run row exists, the operator can see why, and `resume` is the
    // repair. Returning a 500 would leave a `running` run nobody asked about.
    await this.#launchStep(run, workflow, steps, 0, 0, null, ctx);

    return this.get(run.id);
  }

  /**
   * `POST /api/v1/agent-workflow-runs/{id}/stop` — the kill switch.
   *
   * Legal from `running` and from `halted`; a terminal run answers `409` naming its state. The
   * order of operations is the contract: **the run is marked `stopped` before the Session is
   * ended**, so the `session.completed` that ending produces reaches a run that is no longer
   * `running` and advances nothing. Both guards are independent — the attempt row is `stopped`
   * too — so a redelivered event cannot restart the chain either.
   */
  async stop(actor: WorkflowActor, id: string, ctx: RequestContext): Promise<StopResult> {
    const at = this.#now();

    const inFlight = await this.#outbox.run(async (tx) => {
      const run = await lockRunById(tx.tx, id);
      if (run === null) throw new ApiError('NOT_FOUND', `No workflow run with id ${id}`);
      if (run.state !== 'running' && run.state !== 'halted') {
        throw new ApiError('CONFLICT', `This run is already ${run.state}`, { state: run.state });
      }

      const latest = await findLatestRunStep(tx.tx, id);
      const running = latest !== null && latest.state === 'running' ? latest : null;

      if (running !== null) {
        await updateRunStep(tx.tx, running.id, { state: 'stopped', completedAt: at });
      }

      await updateRun(tx.tx, id, { state: 'stopped', haltReason: null, completedAt: at });

      await tx.emit(
        this.#outbox.event(
          'agent_workflow.run.stopped',
          {
            runId: id,
            workflowId: run.workflowId,
            projectId: run.projectId,
            stoppedAtOrdinal: running?.ordinal ?? null,
            sessionsLaunched: run.sessionsLaunched,
          },
          { correlationId: id },
        ),
      );

      await recordAuditEntry(tx.tx, {
        actorType: 'user',
        actorId: actor.userId,
        action: 'agent_workflow.run.stopped',
        entityType: 'agent_workflow_runs',
        entityId: id,
        before: { state: run.state },
        after: { state: 'stopped', sessionId: running?.sessionId ?? null },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });

      return running;
    });

    const stoppedSession = await this.#endInFlightSession(actor, inFlight, ctx);
    return { run: await this.get(id), stoppedSession };
  }

  /**
   * `POST /api/v1/agent-workflow-runs/{id}/resume` — a halted run is not a dead row.
   *
   * Legal from `halted` only. The run goes back to `running` and the advance job works out where
   * it was: a failed attempt is re-run as attempt N+1 in a new Session, and a run that halted
   * *between* steps simply launches the next one. That is one code path, not two, because
   * "what should happen next" is derivable from the attempt rows and deriving it is the only way
   * a redelivered job can be idempotent.
   *
   * `ux_agent_workflow_runs_active` is what refuses a resume into a Project that already has a
   * running chain — the constraint fires, and the `409` is only the message.
   */
  async resume(
    actor: WorkflowActor,
    id: string,
    ctx: RequestContext,
  ): Promise<AgentWorkflowRunResource> {
    await this.#outbox
      .run(async (tx) => {
        const run = await lockRunById(tx.tx, id);
        if (run === null) throw new ApiError('NOT_FOUND', `No workflow run with id ${id}`);
        if (run.state !== 'halted') {
          throw new ApiError(
            'CONFLICT',
            `Only a halted run can be resumed; this one is ${run.state}`,
            {
              state: run.state,
            },
          );
        }
        if (run.sessionsLaunched >= run.maxSessions) {
          throw new ApiError(
            'CONFLICT',
            `This run has used its whole session budget (${String(run.maxSessions)}); start a new run`,
            { maxSessions: run.maxSessions, sessionsLaunched: run.sessionsLaunched },
          );
        }

        await updateRun(tx.tx, id, { state: 'running', haltReason: null, completedAt: null });

        await tx.emit(
          this.#outbox.event(
            'agent_workflow.run.started',
            {
              runId: id,
              workflowId: run.workflowId,
              projectId: run.projectId,
              stepCount: run.stepCount,
              maxSessions: run.maxSessions,
              resumed: true,
            },
            { correlationId: id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: actor.userId,
          action: 'agent_workflow.run.resumed',
          entityType: 'agent_workflow_runs',
          entityId: id,
          before: { state: 'halted', haltReason: run.haltReason },
          after: { state: 'running' },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });
      })
      .catch((error: unknown) => {
        throw asActiveRunConflict(error);
      });

    await this.#enqueue({ kind: 'resume', runId: id });
    return this.get(id);
  }

  // -------------------------------------------------------------------------------- triggers

  async #onEvent(event: EventEnvelope): Promise<void> {
    const payload = event.payload as { sessionId?: unknown; reason?: unknown };
    if (typeof payload.sessionId !== 'string') return;

    // One cheap indexed read, and the overwhelmingly common answer is "not a workflow session".
    // Enqueueing first and filtering in the consumer would put a job on the queue for every
    // Session in the system.
    const step = await findRunStepBySessionId(this.#db, payload.sessionId);
    if (step === null) return;

    if (event.type === 'session.started') {
      await this.#enqueue({ kind: 'prompt', runStepId: step.id });
      return;
    }

    await this.#enqueue({
      kind: 'advance',
      runId: step.runId,
      sessionId: payload.sessionId,
      outcome: event.type === 'session.completed' ? 'completed' : 'failed',
      reason: typeof payload.reason === 'string' ? payload.reason : null,
    });
  }

  async #enqueue(job: AgentWorkflowAdvanceJob): Promise<void> {
    await this.#outbox.run(async (ctx) => {
      await this.#queue.enqueueJob<AgentWorkflowAdvanceJob & JobPayload>(
        ctx.tx,
        QUEUE_NAMES.AGENT_WORKFLOW_ADVANCE,
        createJob<AgentWorkflowAdvanceJob & JobPayload>(
          job as AgentWorkflowAdvanceJob & JobPayload,
        ),
      );
    });
  }

  // ------------------------------------------------------------------------------- consuming

  /**
   * Handle one job. **Never throws** — a thrown error becomes a dead pg-boss row nobody reads,
   * while every failure here has a better home: a launch that cannot happen halts the run, which
   * the operator can see and resume. Same contract as `MemoryIndexService.handle`.
   */
  async handle(job: AgentWorkflowAdvanceJob): Promise<void> {
    try {
      if (job.kind === 'prompt') {
        await this.#submitPrompt(job.runStepId);
        return;
      }
      await this.#progress(
        job.runId,
        job.kind === 'advance'
          ? { sessionId: job.sessionId, outcome: job.outcome, reason: job.reason }
          : null,
      );
    } catch (error) {
      this.#onError?.(error, `agent_workflow.advance job ${job.kind}`);
    }
  }

  /**
   * Record what just happened, then do whatever the run's own rows say comes next.
   *
   * Split in two on purpose. Phase 1 is a single transaction that records the outcome and decides;
   * phase 2 generates a context package and launches a Session, which reaches git, Ollama, Qdrant
   * and a child process and must never hold a database transaction open. The decision is derived
   * from the attempt rows rather than from the job, so a redelivered job — or a resume that
   * arrives after a crash — reaches the same conclusion instead of launching a second Session.
   */
  async #progress(
    runId: string,
    from: { sessionId: string; outcome: 'completed' | 'failed'; reason: string | null } | null,
  ): Promise<void> {
    const decision = await this.#decide(runId, from);
    if (decision === null) return;

    const { run, workflow, steps, ordinal, attempt, previousSessionId } = decision;
    await this.#launchStep(run, workflow, steps, ordinal, attempt, previousSessionId, {
      requestId: runId,
      ipAddress: null,
    });
  }

  async #decide(
    runId: string,
    from: { sessionId: string; outcome: 'completed' | 'failed'; reason: string | null } | null,
  ): Promise<{
    run: AgentWorkflowRunRow;
    workflow: AgentWorkflowRow;
    steps: readonly WorkflowStepView[];
    ordinal: number;
    attempt: number;
    previousSessionId: string | null;
  } | null> {
    const at = this.#now();

    const next = await this.#outbox.run(async (tx) => {
      // `FOR UPDATE`: two deliveries of one `session.completed` would otherwise both read
      // `running` and both decide to launch. Same serialization `lockSessionById` gives F7.
      const run = await lockRunById(tx.tx, runId);
      if (run === null || run.state !== 'running') return null;

      if (from !== null) {
        const step = await findRunStepBySessionId(tx.tx, from.sessionId);
        // A step already recorded is a redelivery; the state below is derived from the rows, so
        // recording it twice is the only thing that has to be prevented.
        if (step !== null && step.runId === runId && step.state === 'running') {
          await updateRunStep(tx.tx, step.id, {
            state: from.outcome === 'completed' ? 'completed' : 'failed',
            error: from.outcome === 'failed' ? (from.reason ?? 'the session failed') : null,
            completedAt: at,
          });

          await tx.emit(
            this.#outbox.event(
              from.outcome === 'completed' ? 'agent.execution_completed' : 'agent.execution_failed',
              {
                runId,
                workflowId: run.workflowId,
                projectId: run.projectId,
                stepOrdinal: step.ordinal,
                attempt: step.attempt,
                agentId: step.agentId,
                sessionId: step.sessionId,
                ...(from.outcome === 'failed' ? { reason: from.reason } : {}),
              },
              { correlationId: runId },
            ),
          );

          /**
           * **A failed step halts the run; it does not retry itself.**
           *
           * This is the safety decision, not a convenience. The attempt rows alone cannot tell
           * "this step failed just now" from "this step failed and the operator asked for another
           * go" — both leave a `failed` latest attempt — so a decision derived from state alone
           * would re-launch on failure, which is an autonomous retry loop spending an operator's
           * money without being asked. Retrying is `POST /{id}/resume`, and it arrives here with
           * `from === null`, which is precisely what distinguishes the two.
           */
          if (from.outcome === 'failed') {
            const reason = from.reason ?? 'the session failed';
            await updateRun(tx.tx, runId, { state: 'halted', haltReason: reason });
            await tx.emit(
              this.#outbox.event(
                'agent_workflow.run.halted',
                {
                  runId,
                  workflowId: run.workflowId,
                  projectId: run.projectId,
                  stepOrdinal: step.ordinal,
                  reason,
                  sessionsLaunched: run.sessionsLaunched,
                },
                { correlationId: runId },
              ),
            );
            return null;
          }
        }
      }

      const latest = await findLatestRunStep(tx.tx, runId);

      // Nothing has run yet — the create path's launch failed before its attempt row existed.
      if (latest === null) return { ordinal: 0, attempt: 0, previousSessionId: null };

      switch (latest.state) {
        case 'running':
          // Still in flight. A stale delivery, or a resume that arrived while the step is alive.
          return null;
        case 'stopped':
          /* c8 ignore next — a stopped attempt implies a stopped run, refused above */
          return null;
        case 'failed':
          // **Only reachable from a resume** (`from === null`), because a failure recorded above
          // halts the run and returns. Re-runs the failed position in a *new* Session: F7 states
          // never move backward, so the old one cannot be revived.
          return {
            ordinal: latest.ordinal,
            attempt: latest.attempt + 1,
            previousSessionId: await previousSessionFor(tx, runId, latest.ordinal),
          };
        default: {
          if (latest.ordinal + 1 >= run.stepCount) {
            await updateRun(tx.tx, runId, { state: 'completed', completedAt: at });
            await tx.emit(
              this.#outbox.event(
                'agent_workflow.run.completed',
                {
                  runId,
                  workflowId: run.workflowId,
                  projectId: run.projectId,
                  stepCount: run.stepCount,
                  sessionsLaunched: run.sessionsLaunched,
                },
                { correlationId: runId },
              ),
            );
            return null;
          }
          return {
            ordinal: latest.ordinal + 1,
            attempt: 0,
            previousSessionId: latest.sessionId,
          };
        }
      }
    });

    if (next === null) return null;

    const run = await findRunById(this.#db, runId);
    /* c8 ignore next */
    if (run === null) return null;

    const workflow = await this.#workflows.require(run.workflowId);
    const steps = await listWorkflowSteps(this.#db, [workflow.id]);

    return { run, workflow, steps, ...next };
  }

  // ------------------------------------------------------------------------------- launching

  /**
   * Create, record and launch one attempt at one step.
   *
   * The order is load-bearing:
   *
   *  1. **the hand-off is built first**, because it is the slow, failure-prone part and a failure
   *     must not leave a Session behind;
   *  2. **the Session is created**, bound to this step's Agent — which is where PRD §5.5's
   *     permissions become `disallowedTools`, unchanged from slice 1;
   *  3. **the attempt row and the budget claim commit together**, before the launch, so that the
   *     `session.started` the launch emits finds a row to match;
   *  4. **the launch happens last**, and its disposition is not acted on: the prompt is submitted
   *     when `session.started` arrives, which covers a launch that was deferred by the semaphore
   *     exactly as well as one that was not.
   *
   * Any failure halts the run with a reason. That is the whole difference between a chain an
   * operator can recover and a `running` row that will never move again.
   */
  async #launchStep(
    run: AgentWorkflowRunRow,
    workflow: AgentWorkflowRow,
    steps: readonly WorkflowStepView[],
    ordinal: number,
    attempt: number,
    previousSessionId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    const actor: WorkflowActor = { userId: run.userId };

    try {
      const step = steps.find((candidate) => candidate.ordinal === ordinal);
      if (step === undefined) {
        throw new ApiError('CONFLICT', `The workflow no longer has a step ${String(ordinal + 1)}`, {
          ordinal,
        });
      }
      if (step.agentArchivedAt !== null) {
        throw new ApiError(
          'CONFLICT',
          `Step ${String(ordinal + 1)} names an archived agent ("${step.agentName}")`,
          { ordinal, agentId: step.agentId },
        );
      }
      if (run.sessionsLaunched >= run.maxSessions) {
        throw new ApiError(
          'CONFLICT',
          `This run has used its whole session budget (${String(run.maxSessions)} sessions)`,
          { maxSessions: run.maxSessions },
        );
      }

      const previous = await this.#previousStep(previousSessionId, steps, ordinal);

      const handoff = buildHandoff({
        workflowName: workflow.name,
        stepOrdinal: ordinal,
        stepCount: run.stepCount,
        agentName: step.agentName,
        runTask: run.task,
        stepInstructions: step.instructions,
        previous,
      });

      const session = await this.#sessions.create(
        actor,
        {
          projectId: run.projectId,
          workingDirectory: run.workingDir,
          ...(run.repositoryId === null ? {} : { repositoryId: run.repositoryId }),
          ...(run.branch === null ? {} : { branch: run.branch }),
          ...(run.model === null ? {} : { model: run.model }),
          title: `${workflow.name} · step ${String(ordinal + 1)} · ${step.agentName}`,
          agentId: step.agentId,
        },
        ctx,
      );

      await this.#outbox.run(async (tx) => {
        // The claim and the attempt row are one transaction, so the budget can never be spent
        // without a row to show for it. `ck_agent_workflow_runs_sessions_launched` is what
        // actually stops it going over — this raises rather than writing an over-budget row.
        await claimRunSession(tx.tx, run.id);

        const row = await insertRunStep(tx.tx, {
          runId: run.id,
          ordinal,
          attempt,
          agentId: step.agentId,
          sessionId: session.id,
          handoffState: handoff.state,
          handoffReason: handoff.reason,
          prompt: handoff.prompt,
        });

        await tx.emit(
          this.#outbox.event(
            'agent.execution_started',
            {
              runId: run.id,
              workflowId: workflow.id,
              projectId: run.projectId,
              stepOrdinal: ordinal,
              attempt,
              agentId: step.agentId,
              sessionId: session.id,
              handoffState: handoff.state,
            },
            { correlationId: run.id },
          ),
        );

        return row;
      });

      // Last, and its disposition is deliberately ignored — see the header.
      await this.#sessions.start(actor, session.id, ctx);
    } catch (error) {
      await this.#halt(run.id, describeHaltReason(error));
      this.#onError?.(error, `agent workflow run ${run.id} step ${String(ordinal + 1)}`);
    }
  }

  /**
   * What the previous step left behind — the crux, and the one place invention would be fatal.
   *
   * A context package is generated from the previous Session (`ports.ts` says why that document
   * and not a new one). When it cannot be generated, the step is **told**: `PreviousStep` carries
   * `kind: 'unavailable'` with the reason, `buildHandoff` renders a warning the agent reads, and
   * the attempt row records `handoff_state = 'degraded'`. Silence was never an option here — a QA
   * step handed nothing produces a confident review of nothing.
   */
  async #previousStep(
    sessionId: string | null,
    steps: readonly WorkflowStepView[],
    ordinal: number,
  ): Promise<PreviousStep | null> {
    if (sessionId === null) return null;

    const previousAgentName =
      steps.find((step) => step.ordinal === ordinal - 1)?.agentName ?? 'the previous step';

    try {
      const document = await this.#handoff.contextPackage(sessionId);
      return {
        kind: 'package',
        agentName: previousAgentName,
        sessionId,
        content: document.content,
        gapReason: document.relatedContext.gapReason,
        gapDetail: document.relatedContext.gapDetail,
      };
    } catch (error) {
      this.#onError?.(error, `workflow handoff from session ${sessionId}`);
      return {
        kind: 'unavailable',
        agentName: previousAgentName,
        sessionId,
        reason: error instanceof ApiError ? error.code : 'handoff_failed',
        detail:
          error instanceof Error
            ? error.message
            : 'Mission Control could not assemble the previous step’s record.',
      };
    }
  }

  /**
   * Submit the prompt built when this attempt was created.
   *
   * Claimed by writing `prompt_sent_at` **before** sending, so two deliveries cannot both send;
   * reset on failure so the next delivery — or the startup sweep — can try again. The alternative
   * order (send, then mark) turns the same crash window into a *duplicated* hand-off, and a
   * duplicate is not recoverable while a loss is.
   */
  async #submitPrompt(runStepId: string): Promise<void> {
    const prompts = this.#prompts;
    /* c8 ignore next */
    if (prompts === null) return;

    const claimed = await this.#outbox.run(async (tx) => {
      const step = await findRunStepById(tx.tx, runStepId);
      if (step === null || step.state !== 'running' || step.promptSentAt !== null) return null;

      const run = await findRunById(tx.tx, step.runId);
      if (run === null || run.state !== 'running') return null;

      const session = await this.#sessions.get(step.sessionId).catch(() => null);
      if (session === null || session.state !== 'running') return null;

      await updateRunStep(tx.tx, step.id, { promptSentAt: this.#now() });
      return step;
    });

    if (claimed === null) return;

    try {
      await prompts.submit({ sessionId: claimed.sessionId, content: claimed.prompt });
    } catch (error) {
      await this.#outbox.run(async (tx) => {
        await updateRunStep(tx.tx, claimed.id, { promptSentAt: null });
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------------- internals

  /**
   * Move a `running` run to `halted` with a reason. Idempotent: a run already off `running` is
   * left exactly as it is.
   *
   * **It closes the in-flight attempt too**, and that is not tidiness. A halt reached through the
   * launch path — a spawn failure, an archived agent, an exhausted budget — happens *after* the
   * attempt row may already exist, and the advance job that the same failure's `session.failed`
   * enqueues will find the run already halted and do nothing. Without this the run would carry a
   * `running` attempt whose Session is `failed`: two rows disagreeing about the same fact, and the
   * operator's Resume would then decline because "the latest attempt is still in flight".
   */
  async #halt(runId: string, reason: string): Promise<void> {
    await this.#outbox.run(async (tx) => {
      const run = await lockRunById(tx.tx, runId);
      if (run === null || run.state !== 'running') return;

      const latest = await findLatestRunStep(tx.tx, runId);
      if (latest !== null && latest.state === 'running') {
        await updateRunStep(tx.tx, latest.id, {
          state: 'failed',
          error: reason,
          completedAt: this.#now(),
        });
      }

      await updateRun(tx.tx, runId, { state: 'halted', haltReason: reason });

      await tx.emit(
        this.#outbox.event(
          'agent_workflow.run.halted',
          {
            runId,
            workflowId: run.workflowId,
            projectId: run.projectId,
            reason,
            sessionsLaunched: run.sessionsLaunched,
          },
          { correlationId: runId },
        ),
      );
    });
  }

  /**
   * Close the Session a Stop interrupted — the part that actually stops the spend.
   *
   * Three outcomes, and conflating them would hide the one that matters:
   *
   *  - **`running`/`paused` -> `ended`.** The runtime is disposed; this is the money case.
   *  - **`created` -> `cancelled`.** The launch never happened, and until this existed that was
   *    the *dangerous* case rather than the harmless one: the Session sat in `created` behind a
   *    durable `session.launch` job, so a run the operator had stopped would still spawn Claude
   *    Code the moment a concurrency slot freed. Cancelling moves it to `failed(cancelled)`, and
   *    F7 has no way back into `running` from there — so the queued job becomes a no-op by the
   *    same rule that governs every other launch.
   *  - **anything terminal -> `already_terminal`.** Nothing to do; saying "ended" would claim an
   *    action this endpoint did not take.
   *
   * The loop runs at most twice, and only for the one interleaving that can defeat a single read:
   * the queued launch winning the race between the read and the cancel. The second pass sees
   * `running` and ends it. It is bounded rather than a retry loop because after `end` there is no
   * third state to chase.
   */
  async #endInFlightSession(
    actor: WorkflowActor,
    step: AgentWorkflowRunStepRow | null,
    ctx: RequestContext,
  ): Promise<StopResult['stoppedSession']> {
    if (step === null) return null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.#sessions.get(step.sessionId).catch(() => null);
      if (session === null) return null;

      if (
        session.state !== 'created' &&
        session.state !== 'running' &&
        session.state !== 'paused'
      ) {
        return { sessionId: step.sessionId, outcome: 'already_terminal' };
      }

      const outcome: StoppedSessionOutcome = session.state === 'created' ? 'cancelled' : 'ended';

      try {
        if (session.state === 'created') await this.#sessions.cancel(actor, step.sessionId, ctx);
        else await this.#sessions.end(actor, step.sessionId, ctx);
        return { sessionId: step.sessionId, outcome };
      } catch (error) {
        this.#onError?.(error, `stopping workflow session ${step.sessionId}`);
        // The state moved under us. One more read settles it; a second failure is reported as the
        // terminal state it almost certainly is rather than retried forever.
        if (attempt === 0) continue;
        return { sessionId: step.sessionId, outcome: 'already_terminal' };
      }
    }

    /* c8 ignore next 2 — the loop returns on every path; this satisfies the compiler. */
    return { sessionId: step.sessionId, outcome: 'already_terminal' };
  }

  async #require(id: string): Promise<AgentWorkflowRunRow> {
    const row = await findRunById(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No workflow run with id ${id}`);
    return row;
  }

  async #hydrate(rows: readonly AgentWorkflowRunRow[]): Promise<AgentWorkflowRunResource[]> {
    if (rows.length === 0) return [];
    const steps = await listRunSteps(
      this.#db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => serializeRun(row, steps));
  }
}

/**
 * The Session whose work step `ordinal` should receive, when `ordinal` is being **re-run**.
 *
 * A retry's hand-off comes from the step *before* it, not from its own failed attempt: the failed
 * Session is what went wrong, and handing it forward would brief the retry with the failure it is
 * meant to replace. `null` when the failed step was the first — the retry then starts from the
 * task, exactly as the original attempt did.
 */
async function previousSessionFor(
  tx: OutboxTransaction,
  runId: string,
  ordinal: number,
): Promise<string | null> {
  if (ordinal === 0) return null;
  const rows = await listRunSteps(tx.tx, [runId]);
  const previous = rows
    .filter((row) => row.ordinal === ordinal - 1 && row.state === 'completed')
    .at(-1);
  return previous?.sessionId ?? null;
}

/** `ux_agent_workflow_runs_active` — one `running` run per Project (schema header, bound 3). */
function asActiveRunConflict(error: unknown): unknown {
  if (isUniqueViolation(error, 'ux_agent_workflow_runs_active')) {
    return new ApiError(
      'CONFLICT',
      'This project already has a workflow run in progress; stop it before starting another',
    );
  }
  return error;
}

/** A short, operator-facing sentence for `agent_workflow_runs.halt_reason`. Never a stack. */
function describeHaltReason(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 500);
  /* c8 ignore next */
  return 'the step could not be launched';
}
