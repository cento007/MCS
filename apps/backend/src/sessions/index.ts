import type { Db, Queue } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus, Outbox } from '../events/index.js';
import {
  type AgentRuntimePort,
  createManagedSessions,
  type ManagedSessions,
  registerManagedRoutes,
} from './managed/index.js';
import { ManagedSessionRegistry } from './manager.js';
import { MessageService } from './messages.js';
import { registerSessionRoutes } from './routes.js';
import { createUnavailableRuntimePort, type SessionRuntimePort } from './runtime-port.js';
import { SessionService } from './service.js';
import { SessionStateMachine } from './state-machine.js';

/**
 * `sessions/` — the Session domain and the F7 state machine owner (TDS 02 §2, §4–§6).
 *
 * The module rule that outranks everything else in this directory:
 *
 *   **`sessions/state-machine.ts` is the ONLY code path that mutates `sessions.state`.**
 *
 * Managed controllers, observed ingest, restart recovery and API handlers all call it. It
 * validates against `SESSION_STATE_TRANSITIONS` from `@mc/shared` (F7), records timestamp plus
 * trigger (`user` | `system`) on the session timeline, and emits `session.state_changed`
 * together with the specific lifecycle event through the transactional outbox helper in
 * `events/` (F6.3). Six writers, one state machine. The rule is enforced three ways:
 * `repository.ts`'s update type omits `state`, `state-machine.ts` owns the only `SET state`,
 * and `state-machine.guard.test.ts` fails the build if a fourth writer ever appears.
 *
 * Layout:
 *   state-machine.ts  F7 enforcement, timeline row, both event envelopes — one transaction
 *   repository.ts     every `sessions`/`session_events`/`messages` read and write but `state`
 *   serialize.ts      DB row -> API resource (TDS 03 §3.9 mapping table)
 *   service.ts        the §6 contract, one method per row
 *   routes.ts         `/api/v1/sessions/*`
 *   manager.ts        ManagedSessionRegistry: concurrency slots + durable `session.launch`
 *   semaphore.ts      the FIFO slot pool behind `maxConcurrentSessions`
 *   messages.ts       Message append + A13 title derivation, one transaction
 *   title.ts          the §6.11 derivation rule, pure
 *   files.ts          the §6.10.2 bounded read model
 *   cursors.ts        the two non-`id` ordering keys (message `ordinal`, commit `committedAt`)
 *   runtime-port.ts   `SessionRuntimePort` — the seam the Agent SDK wrapper fills (WS6 §5.1)
 *   managed/          the Agent SDK wrapper that fills it: controller, pump, prompts (§4–§5)
 *
 * Still owed: `observed/` (hook ingest + transcript tailer), `export.ts`, and the endpoints that
 * depend on them (§6.7 export/context-package, §6.8 hook events).
 */

export * from './cursors.js';
export * from './files.js';
export * from './managed/index.js';
export * from './manager.js';
export * from './messages.js';
export * from './repository.js';
export * from './runtime-port.js';
export * from './semaphore.js';
export * from './serialize.js';
export * from './service.js';
export * from './state-machine.js';
export * from './title.js';

export interface RegisterSessionsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly bus: EventBus;
  readonly queue: Queue;
  /**
   * A pre-built `SessionRuntimePort`. Wins over `agentRuntime`, and defaults to
   * `createUnavailableRuntimePort()` when neither is supplied — a Backend with no runtime says
   * so (503) rather than pretending a session started.
   */
  readonly runtime?: SessionRuntimePort;
  /**
   * The Claude Code runtime behind the managed wrapper (F1.5). Supplying it builds
   * `managed/`: controllers, the `POST /sessions/{id}/prompts` endpoint, and the `PromptPort`
   * the WebSocket hub needs. Tests pass the WS6 §5.2 mock; `main.ts` passes the Agent SDK.
   */
  readonly agentRuntime?: AgentRuntimePort;
  readonly maxConcurrentSessions: number;
  readonly spawnTimeoutMs?: number | undefined;
  readonly disposeTimeoutMs?: number | undefined;
  readonly onError?: (error: unknown, sessionId: string) => void;
}

export interface SessionModule {
  readonly stateMachine: SessionStateMachine;
  readonly registry: ManagedSessionRegistry;
  readonly sessions: SessionService;
  readonly messages: MessageService;
  readonly runtime: SessionRuntimePort;
  /** Present only when an `agentRuntime` was supplied. */
  readonly managed: ManagedSessions | null;
}

/** Build the Session domain and register its routes. */
export function registerSessions(
  app: FastifyInstance,
  options: RegisterSessionsOptions,
): SessionModule {
  const stateMachine = new SessionStateMachine({ outbox: options.outbox });
  const messages = new MessageService({ outbox: options.outbox });

  const managed =
    options.agentRuntime === undefined
      ? null
      : createManagedSessions({
          db: options.db,
          outbox: options.outbox,
          queue: options.queue,
          messages,
          stateMachine,
          agent: options.agentRuntime,
          ...(options.spawnTimeoutMs === undefined
            ? {}
            : { spawnTimeoutMs: options.spawnTimeoutMs }),
          ...(options.disposeTimeoutMs === undefined
            ? {}
            : { disposeTimeoutMs: options.disposeTimeoutMs }),
          ...(options.onError === undefined ? {} : { onError: options.onError }),
        });

  const runtime = options.runtime ?? managed?.runtime ?? createUnavailableRuntimePort();

  const registry = new ManagedSessionRegistry({
    db: options.db,
    outbox: options.outbox,
    queue: options.queue,
    bus: options.bus,
    stateMachine,
    runtime,
    maxConcurrentSessions: options.maxConcurrentSessions,
    ...(options.onError === undefined ? {} : { onLaunchError: options.onError }),
  });

  const sessions = new SessionService({
    db: options.db,
    outbox: options.outbox,
    stateMachine,
    registry,
    runtime,
    ...(options.onError === undefined ? {} : { onRuntimeError: options.onError }),
  });

  registerSessionRoutes(app, { sessions });

  if (managed !== null) {
    registerManagedRoutes(app, managed);
    // The retry consumer and every live child are released with the server, so a test that
    // closes its app leaks neither a subscription nor a `claude` process.
    app.addHook('onClose', async () => {
      await managed.stop();
    });
  }

  return {
    stateMachine,
    registry,
    sessions,
    messages,
    runtime,
    managed,
  };
}
