import type { Db, Queue } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus, Outbox } from '../../events/index.js';
import type {
  WorkflowHandoffPort,
  WorkflowNotifierPort,
  WorkflowPromptPort,
  WorkflowSessionPort,
} from './ports.js';
import { registerAgentWorkflowRoutes } from './routes.js';
import { AgentWorkflowRunService } from './runs.js';
import { AgentWorkflowService } from './service.js';

/**
 * `agents/workflows/` — PRD §5.6, built and runnable (Phase 4, slice 3).
 *
 * Layout:
 *   validation.ts  field rules and the two semantic ones a JSON Schema cannot state — pure
 *   handoff.ts     what step N+1 receives from step N, and how a gap is *named* — pure
 *   estimate.ts    what a run will cost, from measured history and never from a model — pure
 *   store.ts       every read and write of the four tables; there is no delete
 *   serialize.ts   rows -> the two resources
 *   service.ts     the definition: CRUD, archive, and the cost estimate
 *   runs.ts        the run: create/stop/resume, the event-driven advance, the job consumer
 *   ports.ts       the three seams into the Session domain — deliberately four verbs wide
 *   routes.ts      `/api/v1/agent-workflows/*` and `/api/v1/agent-workflow-runs/*`
 *
 * **Registered from `app.ts`, not from `agents/index.ts`**, and for the same reason
 * `sessions/export/` is: the hand-off is built from `SessionExportService`, which is constructed
 * after the memory layer, and the runner needs the `SessionService` and the managed
 * `PromptService` that `registerSessions` produces. `registerAgents` runs *before* the Session
 * domain because the binding resolver has to exist first; a workflow needs the opposite order, so
 * it is wired where both halves exist.
 *
 * What is **not** here, and is not an oversight:
 *   - **Autonomous triggering and scheduled runs.** PRD §15 puts autonomous review flows in
 *     Phase 5. A run is started by an operator, through a route, with an audit row naming them.
 *   - **A second runtime.** A step is a Session. There is no code here that spawns anything.
 *   - **`POST /agents/{id}/executions`.** Declined — see TDS 04 §13.2.1 and the note in
 *     `agents/index.ts`: a Session bound to an Agent already *is* an execution, and this slice
 *     produces the three reserved `agent.execution_*` events from that Session's own lifecycle
 *     rather than from a parallel one.
 */

export * from './estimate.js';
export * from './handoff.js';
export * from './ports.js';
export * from './runs.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';
export * from './validation.js';

export interface RegisterAgentWorkflowsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly bus: EventBus;
  readonly queue: Queue;
  readonly sessions: WorkflowSessionPort;
  /** `null` on a Backend with no managed runtime — `POST /agent-workflow-runs` then 503s. */
  readonly prompts: WorkflowPromptPort | null;
  readonly handoff: WorkflowHandoffPort;
  /**
   * The Notification producer, for "this step is waiting for you". Optional because an app built
   * without an outbox/queue has none; a run then advances exactly as before and says nothing.
   */
  readonly notifier?: WorkflowNotifierPort | null | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
  readonly onTimezoneRejected?: ((timezone: string, error: unknown) => void) | undefined;
}

export interface AgentWorkflowModule {
  readonly workflows: AgentWorkflowService;
  readonly runs: AgentWorkflowRunService;
}

export function registerAgentWorkflows(
  app: FastifyInstance,
  options: RegisterAgentWorkflowsOptions,
): AgentWorkflowModule {
  const workflows = new AgentWorkflowService({
    db: options.db,
    outbox: options.outbox,
    ...(options.onTimezoneRejected === undefined
      ? {}
      : { onTimezoneRejected: options.onTimezoneRejected }),
  });

  const runs = new AgentWorkflowRunService({
    db: options.db,
    outbox: options.outbox,
    bus: options.bus,
    queue: options.queue,
    workflows,
    sessions: options.sessions,
    prompts: options.prompts,
    handoff: options.handoff,
    ...(options.notifier === undefined ? {} : { notifier: options.notifier }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  registerAgentWorkflowRoutes(app, { workflows, runs });

  // The bus subscriptions and the job consumer are released with the server, so a test that
  // closes its app leaks neither a listener nor a pg-boss worker.
  app.addHook('onClose', async () => {
    await runs.shutdown();
  });

  return { workflows, runs };
}
