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
 * How long to wait for the runtime to confirm spawn before timing out and failing the launch
 * (TDS 04 §6.3). A spawn that never responds is worse than one that errors: the operator cannot
 * tell "working" from "broken", and the frontend has no failure to render.
 *
 * 30 seconds is long enough for a cold-start Claude Code install on a slow disk, and short enough
 * that a hung request becomes an actionable 503 before an operator's patience runs out. The
 * interrupt and dispose timeouts (5s, 2s) are deliberately shorter: those operations are signaling
 * a running process, not waiting for one to appear.
 */
const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;

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
  /**
   * "A turn ended and this session is now idle" — forwarded from every controller this runtime
   * owns. See `ManagedSessionController`'s `onTurnEnded` for which endings qualify and why the
   * other two do not.
   */
  readonly onTurnEnded?: ((sessionId: string) => void) | undefined;
  readonly onError?: ((error: unknown, sessionId: string) => void) | undefined;
  /** PRD §4.1 session metadata. Defaults: this host, and `NODE_ENV`. */
  readonly machine?: string | null | undefined;
  readonly environment?: string | null | undefined;
  /** How long to wait for `session_started` before failing the spawn (§6.3). */
  readonly spawnTimeoutMs?: number | undefined;
  readonly interruptTimeoutMs?: number | undefined;
  readonly disposeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export class ManagedRuntime implements SessionRuntimePort {
  readonly #options: ManagedRuntimeOptions;
  readonly #machine: string | null;
  readonly #environment: string | null;
  readonly #spawnTimeoutMs: number;
  readonly #controllers = new Map<string, ManagedSessionController>();

  constructor(options: ManagedRuntimeOptions) {
    this.#options = options;
    this.#machine = options.machine === undefined ? hostname() : options.machine;
    this.#environment =
      options.environment === undefined
        ? (process.env['NODE_ENV'] ?? 'development')
        : options.environment;
    this.#spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
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
      // PRD §5.1's Agent, reduced to the two things a runtime can act on. A Session with no
      // Agent produces exactly the arguments this call made before Phase 4 — no prompt append,
      // an empty deny list — so binding nothing changes nothing.
      systemPromptAppend: request.agent?.systemPromptAppend ?? null,
      disallowedTools: request.agent?.disallowedTools ?? [],
      strictMcpConfig: request.agent?.strictMcpConfig ?? false,
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
      onTurnEnded: (sessionId) => {
        // Wrapped rather than passed straight through: the controller calls this from inside the
        // pump, and a listener that threw would end the stream for a live Session. Nothing this
        // notification does is worth a transcript.
        try {
          this.#options.onTurnEnded?.(sessionId);
        } catch (error) {
          this.#options.onError?.(error, sessionId);
        }
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
      // Bound the spawn: a runtime that never confirms is worse than one that errors (§6.3).
      // A timeout here means "Claude Code is unreachable, not authenticated, or so slow that
      // waiting longer is operationally useless". The session transitions to `failed` and the
      // API returns 503, which is what the contract says a spawn failure does.
      const facts = await withTimeout(
        controller.ready(),
        this.#spawnTimeoutMs,
        new SpawnTimeoutError(
          'The runtime did not confirm spawn within the timeout',
          request.sessionId,
        ),
      );
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

class SpawnTimeoutError extends Error {
  readonly sessionId: string;

  constructor(message: string, sessionId: string) {
    super(message);
    this.name = 'SpawnTimeoutError';
    this.sessionId = sessionId;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T | Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          if (fallback instanceof Error) {
            reject(fallback);
          } else {
            resolve(fallback);
          }
        }, ms);
        // Never the reason a process stays alive (F8.1).
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
