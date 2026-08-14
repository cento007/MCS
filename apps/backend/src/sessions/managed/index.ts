import { type Db, QUEUE_NAMES, type Queue, type Unsubscribe } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../../events/index.js';
import type { SessionMessageDelta } from '../../ws/hub.js';
import type { MessageService } from '../messages.js';
import type { SessionStateMachine } from '../state-machine.js';
import type { SessionCostStore, SessionDeltaSink, TurnRetryScheduler } from './ports.js';
import { PromptService } from './prompts.js';
import { createTurnRetryScheduler, type PromptRetryJob } from './retry.js';
import { registerPromptRoutes } from './routes.js';
import { ManagedRuntime } from './runtime.js';
import type { AgentRuntimePort } from './runtime-events.js';
import { createSessionCostStore } from './store.js';

/**
 * `sessions/managed/` — the Claude Code wrapper for **managed** sessions (F1.5, TDS 02 §4–§5).
 *
 * Layout:
 *   runtime-events.ts       `RuntimeEvent` + `AgentRuntimePort` — our vocabulary, not the SDK's
 *   claude-agent-runtime.ts the ONLY module that imports `@anthropic-ai/claude-agent-sdk`
 *   normalize.ts            SDK message -> `RuntimeEvent` (pinned by contract tests, WS6 §5.3)
 *   content.ts              content blocks -> §6.6 vocabulary, rendered text, tool file paths
 *   controller.ts           `ManagedSessionController`: the pump (§4.2)
 *   runtime.ts              `ManagedRuntime`: `SessionRuntimePort` over a map of controllers
 *   cost.ts                 cost/usage accumulation (F1.5 canonical cost source)
 *   store.ts                the two DB writes this module owns — cost totals, prompt status flip
 *   prompts.ts / routes.ts  `POST /sessions/{id}/prompts` (§6.4) and the WS `prompt` frame
 *   retry.ts                rate-limit backoff as a delayed job (§4.3)
 *   recovery.ts             restart recovery (§4.4)
 *   ports.ts                the narrow seams that keep the unit tier database-free
 *
 * The module owes the rest of the Backend exactly two things: a `SessionRuntimePort` for the
 * Session domain, and a `PromptPort` for the WebSocket hub. Everything else is internal.
 */

// NOTE: `claude-agent-runtime.js` is deliberately NOT re-exported. It is the only module that
// imports the Agent SDK, and putting it in this barrel would load the SDK into every unit test
// that touches the Session domain. `main.ts` imports it by path, which is also the clearest
// possible statement of where the runtime enters the process graph.
export * from './content.js';
export * from './controller.js';
export * from './cost.js';
export * from './normalize.js';
export * from './ports.js';
export * from './prompts.js';
export * from './recovery.js';
export * from './retry.js';
export * from './routes.js';
export * from './runtime.js';
export * from './runtime-events.js';
export * from './store.js';

/**
 * A settable delta sink.
 *
 * The WebSocket hub is constructed *after* the Session domain in `app.ts` (the auth guard has to
 * be in place before the upgrade route exists), so the controllers cannot be handed the hub at
 * construction time. This one-line indirection is the alternative to reordering `app.ts`, which
 * would trade a mutable reference for a security-relevant ordering constraint.
 */
export interface DeltaRelay extends SessionDeltaSink {
  attach(sink: SessionDeltaSink): void;
}

export function createDeltaRelay(): DeltaRelay {
  let sink: SessionDeltaSink | null = null;
  return {
    attach(next: SessionDeltaSink): void {
      sink = next;
    },
    publishSessionDelta(delta: SessionMessageDelta): unknown {
      return sink?.publishSessionDelta(delta);
    },
  };
}

/**
 * A settable "a turn ended and this session is idle" listener — `createDeltaRelay`'s twin, for the
 * same ordering reason and with the same one-line cost.
 *
 * The consumer is the agent-workflow runner, which `app.ts` builds *after* the Session domain
 * because a workflow step **is** a Session. Handing the runtime its listener at construction time
 * would mean building the runner first, which is not possible; a late attach is the alternative to
 * inverting a dependency that points the right way.
 *
 * Exactly one listener, not a list. Two consumers of "this session is idle" would be two policies
 * about what idle means, and the second one to arrive would silently replace the first — which is
 * what this shape makes visible rather than convenient.
 */
export interface TurnRelay {
  attach(listener: (sessionId: string) => void): void;
  turnEnded(sessionId: string): void;
}

export function createTurnRelay(): TurnRelay {
  let listener: ((sessionId: string) => void) | null = null;
  return {
    attach(next: (sessionId: string) => void): void {
      listener = next;
    },
    turnEnded(sessionId: string): void {
      listener?.(sessionId);
    },
  };
}

export interface ManagedSessionsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: Queue;
  readonly messages: MessageService;
  readonly stateMachine: SessionStateMachine;
  readonly agent: AgentRuntimePort;
  readonly cost?: SessionCostStore | undefined;
  readonly retries?: TurnRetryScheduler | undefined;
  readonly onError?: ((error: unknown, sessionId: string) => void) | undefined;
  readonly spawnTimeoutMs?: number | undefined;
  readonly interruptTimeoutMs?: number | undefined;
  readonly disposeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ManagedSessions {
  readonly runtime: ManagedRuntime;
  readonly prompts: PromptService;
  readonly deltas: DeltaRelay;
  /** Attach the single "a turn ended, this session is idle" listener — see `createTurnRelay`. */
  readonly turns: TurnRelay;
  /** Subscribe the rate-limit retry consumer (§4.3). */
  start(): Promise<void>;
  /** Stop consuming and let every child go. */
  stop(): Promise<void>;
}

export function createManagedSessions(options: ManagedSessionsOptions): ManagedSessions {
  const deltas = createDeltaRelay();
  const turns = createTurnRelay();
  const cost = options.cost ?? createSessionCostStore(options.db);

  const retries =
    options.retries ??
    createTurnRetryScheduler({
      queue: options.queue,
      outbox: options.outbox,
      ...(options.onError === undefined
        ? {}
        : {
            onExhausted: (turn) => {
              options.onError?.(
                new Error(`rate-limit retries exhausted after ${turn.attempt} attempts`),
                turn.sessionId,
              );
            },
          }),
    });

  const runtime = new ManagedRuntime({
    agent: options.agent,
    messages: options.messages,
    stateMachine: options.stateMachine,
    cost,
    deltas,
    retries,
    onTurnEnded: (sessionId) => {
      turns.turnEnded(sessionId);
    },
    onError: options.onError,
    spawnTimeoutMs: options.spawnTimeoutMs,
    interruptTimeoutMs: options.interruptTimeoutMs,
    disposeTimeoutMs: options.disposeTimeoutMs,
    now: options.now,
  });

  const prompts = new PromptService({
    db: options.db,
    outbox: options.outbox,
    messages: options.messages,
    runtime,
    onError: options.onError,
  });

  let unsubscribe: Unsubscribe | null = null;

  return {
    runtime,
    prompts,
    deltas,
    turns,

    async start(): Promise<void> {
      unsubscribe ??= await options.queue.subscribeJobs<PromptRetryJob>(
        QUEUE_NAMES.SESSION_PROMPT_RETRY,
        async (job) => {
          await prompts.retry({
            sessionId: job.payload.sessionId,
            messageId: job.payload.messageId,
            content: job.payload.content,
            attempt: job.payload.attempt,
          });
        },
        { concurrency: 1 },
      );
    },

    async stop(): Promise<void> {
      const current = unsubscribe;
      unsubscribe = null;
      if (current !== null) await current();
      await runtime.disposeAll();
    },
  };
}

/** Register the managed-session routes on a Fastify instance. */
export function registerManagedRoutes(app: FastifyInstance, managed: ManagedSessions): void {
  registerPromptRoutes(app, { prompts: managed.prompts });
}
