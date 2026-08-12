import { hostname } from 'node:os';
import process from 'node:process';
import { ApiError } from '../../http/errors.js';
import type {
  InterruptOutcome,
  LaunchOutcome,
  LaunchRequest,
  RuntimeDisposeReason,
  SessionRuntimePort,
} from '../runtime-port.js';
import { ManagedSessionController } from './controller.js';
import type {
  MessageSink,
  SessionCostStore,
  SessionDeltaSink,
  SessionStatePort,
  TurnRetryScheduler,
} from './ports.js';
import type { AgentRuntimePort } from './runtime-events.js';

/**
 * `ManagedRuntime` — the `SessionRuntimePort` implementation the Session domain has been calling
 * into a placeholder for (`createUnavailableRuntimePort`), now backed by real controllers.
 *
 * It is a registry of `ManagedSessionController`s and nothing else: launch constructs one and
 * waits for the runtime to confirm; `hasTurnInFlight`/`interrupt`/`dispose` forward to it. All
 * the behaviour is in the controller, all the process handling is in `AgentRuntimePort`, and the
 * concurrency slot that gates launches is the registry's (`sessions/manager.ts`) — this class
 * owns no policy, which is what makes a Phase 5 runtime adapter a constructor argument rather
 * than a rewrite (TDS 02 §11.4).
 */

export interface ManagedRuntimeOptions {
  readonly agent: AgentRuntimePort;
  readonly messages: MessageSink;
  readonly stateMachine: SessionStatePort;
  readonly cost: SessionCostStore;
  /** The WebSocket hub. Absent = no live relay; persistence and cost are unaffected. */
  readonly deltas?: SessionDeltaSink | undefined;
  readonly retries?: TurnRetryScheduler | undefined;
  readonly onError?: ((error: unknown, sessionId: string) => void) | undefined;
  /** PRD §4.1 session metadata. Defaults: this host, and `NODE_ENV`. */
  readonly machine?: string | null | undefined;
  readonly environment?: string | null | undefined;
  readonly interruptTimeoutMs?: number | undefined;
  readonly disposeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export class ManagedRuntime implements SessionRuntimePort {
  readonly #options: ManagedRuntimeOptions;
  readonly #machine: string | null;
  readonly #environment: string | null;
  readonly #controllers = new Map<string, ManagedSessionController>();

  constructor(options: ManagedRuntimeOptions) {
    this.#options = options;
    this.#machine = options.machine === undefined ? hostname() : options.machine;
    this.#environment =
      options.environment === undefined
        ? (process.env['NODE_ENV'] ?? 'development')
        : options.environment;
  }

  get activeSessionCount(): number {
    return this.#controllers.size;
  }

  controllerFor(sessionId: string): ManagedSessionController | null {
    return this.#controllers.get(sessionId) ?? null;
  }

  /**
   * Spawn or re-attach, and resolve only once the runtime has confirmed with its native session
   * id — F7's "system confirms spawn". A rejection here is what the registry turns into
   * `created -> failed` (or `paused -> failed`) plus `503 RUNTIME_UNAVAILABLE` (§6.3).
   */
  async launch(request: LaunchRequest): Promise<LaunchOutcome> {
    if (request.sessionType !== 'managed') {
      // Mission Control does not own an observed Session's process (WS1 §5.2). There is nothing
      // here to spawn, and pretending otherwise would create a second, unowned child.
      throw new ApiError(
        'OPERATION_NOT_SUPPORTED',
        'Only managed sessions are launched by the Backend',
        { sessionId: request.sessionId, sessionType: request.sessionType },
      );
    }

    // A relaunch of a Session that still holds a controller (a redelivered launch job, an
    // operator double-click): let the old one go first so two pumps never write one transcript.
    await this.dispose(request.sessionId, 'shutdown');

    const baseline = await this.#options.cost.read(request.sessionId);

    const handle = this.#options.agent.start({
      sessionId: request.sessionId,
      workingDirectory: request.workingDirectory,
      model: request.model,
      // F1.5: `resume` re-attaches the runtime-native conversation, for an in-place resume, a
      // resume-as-new Session, and a Clone alike.
      resume: request.resumeFromRuntimeSessionId,
      fork: request.fork,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    const controller = new ManagedSessionController({
      sessionId: request.sessionId,
      handle,
      messages: this.#options.messages,
      stateMachine: this.#options.stateMachine,
      cost: this.#options.cost,
      deltas: this.#options.deltas,
      baseline,
      onError: this.#options.onError,
      onRateLimited: (turn) => {
        void this.#options.retries?.schedule(turn).catch((error: unknown) => {
          this.#options.onError?.(error, turn.sessionId);
        });
      },
      onClosed: (sessionId) => {
        // Only if it is still *this* controller: a relaunch may already have replaced it.
        if (this.#controllers.get(sessionId) === controller) this.#controllers.delete(sessionId);
      },
      interruptTimeoutMs: this.#options.interruptTimeoutMs,
      disposeTimeoutMs: this.#options.disposeTimeoutMs,
      now: this.#options.now,
    });

    this.#controllers.set(request.sessionId, controller);

    try {
      const facts = await controller.ready();
      return {
        runtimeSessionId: facts.runtimeSessionId,
        runtimeVersion: facts.claudeVersion,
        model: facts.model ?? request.model,
        machine: this.#machine,
        environment: this.#environment,
      };
    } catch (error) {
      this.#controllers.delete(request.sessionId);
      await controller.dispose();
      throw asRuntimeUnavailable(error, request.sessionId);
    }
  }

  hasTurnInFlight(sessionId: string): boolean {
    return this.#controllers.get(sessionId)?.hasTurnInFlight === true;
  }

  async interrupt(sessionId: string): Promise<InterruptOutcome> {
    const controller = this.#controllers.get(sessionId);
    if (controller === undefined) {
      throw new ApiError('NO_TURN_IN_FLIGHT', 'No assistant turn is currently streaming', {
        sessionId,
      });
    }
    return controller.interrupt();
  }

  /**
   * Let the runtime go. The reason is informational here — cold pause, end, crash cleanup and
   * shutdown all do the same physical thing (TDS 02 §5.1) — and the concurrency slot is released
   * by the registry when the state change lands, not by this call.
   */
  async dispose(sessionId: string, _reason: RuntimeDisposeReason = 'shutdown'): Promise<void> {
    const controller = this.#controllers.get(sessionId);
    if (controller === undefined) return;
    this.#controllers.delete(sessionId);
    await controller.dispose();
  }

  /** Hand a prompt to a live session (§6.4). */
  async submit(input: {
    readonly sessionId: string;
    readonly content: string;
    readonly messageId: string | null;
    readonly attempt?: number;
  }): Promise<void> {
    const controller = this.#controllers.get(input.sessionId);
    if (controller === undefined || controller.closed) {
      throw new ApiError('RUNTIME_UNAVAILABLE', 'This session has no live runtime', {
        sessionId: input.sessionId,
      });
    }

    await controller.submit({
      content: input.content,
      messageId: input.messageId,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    });
  }

  /** Shutdown: let go of every child. They die with the process anyway (TDS 02 §4.4). */
  async disposeAll(): Promise<void> {
    const ids = [...this.#controllers.keys()];
    await Promise.all(ids.map(async (id) => this.dispose(id, 'shutdown')));
  }
}

function asRuntimeUnavailable(error: unknown, sessionId: string): ApiError {
  if (error instanceof ApiError) return error;
  const message =
    error instanceof Error ? error.message : 'The Claude Code runtime failed to start';
  return new ApiError('RUNTIME_UNAVAILABLE', message, { sessionId });
}
