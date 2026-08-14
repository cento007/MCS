import {
  createJob,
  type Db,
  type EventEnvelope,
  QUEUE_NAMES,
  type Queue,
  type SessionState,
  type SessionType,
  type Unsubscribe,
} from '@mc/shared';
import type { EventBus, Outbox } from '../events/index.js';
import { ApiError } from '../http/errors.js';
import type { RuntimeAgentBinding, SessionAgentPort } from './agent-binding.js';
import { findSessionById, type SessionRow } from './repository.js';
import type { SessionRuntimePort } from './runtime-port.js';
import { Semaphore } from './semaphore.js';
import type { SessionStateMachine } from './state-machine.js';

/**
 * `ManagedSessionRegistry` — the concurrency slot pool and the durable launch queue
 * (TDS 02 §4.3, TDS 04 §6.2.1, arbitration A2).
 *
 * The rule this module exists to keep: **saturation is not an error.** `start` and `resume`
 * always succeed when the F7 transition is otherwise legal; the response says whether the
 * launch happened now (`meta.launch: 'started'`) or was deferred (`'queued'`). While queued the
 * Session stays in its pre-launch state — `created` for start, `paused` for in-place resume —
 * and **no `session.state_changed` is emitted**. There is no 409 for capacity and no
 * client-side retry loop.
 *
 * **A queued launch is revoked by moving the Session, never by chasing the job.** pg-boss jobs are
 * at-least-once and may already be in flight, so "delete the job" is a race with no winner. What a
 * caller does instead is `SessionService.cancel`, which takes the Session out of `created` — and
 * every launch path here already asks the same question the F7 state machine asks. The consumer
 * declines cheaply (no slot, no spawn); the state machine declines authoritatively.
 *
 * Slot accounting is bus-driven rather than call-driven: a slot is held from the moment it is
 * acquired until the Session leaves `running` by *any* path (pause, end, crash, restart
 * recovery), and the only thing that knows a Session left `running` is
 * `session.state_changed`. Cold pause therefore frees capacity for the next queued launch,
 * which is the operationally useful meaning of pause under a max-concurrent budget
 * (TDS 02 §5.1).
 *
 * The spawn itself is `SessionRuntimePort`'s (see `runtime-port.ts`); nothing here imports an
 * SDK.
 */

/**
 * The `session.launch` job payload — **a job name, not an event**: it carries no F6 envelope
 * and never appears in the event catalog (TDS 04 §15.2 note). Declared as a `type` rather than
 * an `interface` so it satisfies `JobPayload`'s index signature.
 */
export type SessionLaunchJob = {
  readonly sessionId: string;
  /**
   * The state the Session must still be in for this queued launch to be valid. A redelivered
   * or stale job whose Session has moved on is a no-op — this is the idempotency key of the
   * consumer, alongside the job id (F6.3).
   */
  readonly fromState: Extract<SessionState, 'created' | 'paused'>;
  readonly action: 'start' | 'resume';
  readonly requestedAt: string;
  readonly requestedBy: string;
};

export type LaunchDisposition = 'started' | 'queued';

export interface LaunchIntent {
  readonly session: SessionRow;
  readonly action: 'start' | 'resume';
  readonly requestedBy: string;
  readonly correlationId?: string | null;
}

export interface ManagedSessionRegistryOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: Queue;
  readonly bus: EventBus;
  readonly stateMachine: SessionStateMachine;
  readonly runtime: SessionRuntimePort;
  /** Resolves `sessions.agent_id` into what the runtime must do about it (PRD §5). */
  readonly agents: SessionAgentPort;
  /** `integrations.claudeCode.maxConcurrentSessions` (PRD §4.4.2). */
  readonly maxConcurrentSessions: number;
  readonly onLaunchError?: (error: unknown, sessionId: string) => void;
}

export class ManagedSessionRegistry {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #queue: Queue;
  readonly #bus: EventBus;
  readonly #stateMachine: SessionStateMachine;
  readonly #runtime: SessionRuntimePort;
  readonly #agents: SessionAgentPort;
  readonly #semaphore: Semaphore;
  readonly #onLaunchError: ((error: unknown, sessionId: string) => void) | undefined;

  /** Sessions currently holding a slot. The map makes `release` idempotent. */
  readonly #slots = new Set<string>();

  #unsubscribeBus: (() => void) | null = null;
  #unsubscribeJobs: Unsubscribe | null = null;
  /** Aborted by `stop()` to release a launch consumer parked on a slot. */
  #shutdown: AbortController | null = null;

  constructor(options: ManagedSessionRegistryOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#queue = options.queue;
    this.#bus = options.bus;
    this.#stateMachine = options.stateMachine;
    this.#runtime = options.runtime;
    this.#agents = options.agents;
    this.#semaphore = new Semaphore(options.maxConcurrentSessions);
    this.#onLaunchError = options.onLaunchError;
  }

  get slotsInUse(): number {
    return this.#semaphore.held;
  }

  get maxConcurrentSessions(): number {
    return this.#semaphore.limit;
  }

  /** Re-read on `setting.updated`. Shrinking defers new launches; it never kills a Session. */
  setMaxConcurrentSessions(limit: number): void {
    this.#semaphore.resize(limit);
  }

  /** Subscribe the slot-release listener and the durable launch consumer. */
  async start(): Promise<void> {
    this.#shutdown ??= new AbortController();

    this.#unsubscribeBus ??= this.#bus.on('session.state_changed', (event) => {
      this.#onStateChanged(event);
    });

    this.#unsubscribeJobs ??= await this.#queue.subscribeJobs<SessionLaunchJob>(
      QUEUE_NAMES.SESSION_LAUNCH,
      async (job) => {
        await this.#consumeLaunchJob(job.payload, job.signal);
      },
      // One at a time: this is what makes "serviced in enqueue order as slots free" true.
      { concurrency: 1 },
    );
  }

  /**
   * Stop consuming.
   *
   * The abort comes **first, and before awaiting the unsubscribe**, because a launch consumer
   * can legitimately be parked on `semaphore.acquire()` waiting for a slot that will never free
   * — the process is shutting down. pg-boss's `offWork` waits for the in-flight handler, so
   * without this the shutdown step would block forever on a job that is behaving exactly as
   * designed. The aborted handler throws, pg-boss fails the job, and it is redelivered on the
   * next boot, which is what "queued launches survive a restart" means (TDS 02 §4.4).
   */
  async stop(): Promise<void> {
    this.#shutdown?.abort();
    this.#shutdown = null;

    this.#unsubscribeBus?.();
    this.#unsubscribeBus = null;

    const unsubscribe = this.#unsubscribeJobs;
    this.#unsubscribeJobs = null;
    if (unsubscribe !== null) await unsubscribe();
  }

  /**
   * Launch now if a slot is free, otherwise enqueue a durable `session.launch` job.
   *
   * @returns `'started'` when the Session is `running`, `'queued'` when the launch was deferred
   *   and the Session is unchanged.
   */
  async launch(intent: LaunchIntent): Promise<LaunchDisposition> {
    const sessionId = intent.session.id;

    if (!this.#acquireFor(sessionId)) {
      await this.#enqueueLaunch(intent);
      return 'queued';
    }

    try {
      await this.#performLaunch(intent);
      return 'started';
    } catch (error) {
      this.#release(sessionId);
      throw error;
    }
  }

  /** Restart recovery and shutdown hand the runtime back; the slot follows the state change. */
  async dispose(
    sessionId: string,
    reason: 'paused' | 'ended' | 'failed' | 'shutdown',
  ): Promise<void> {
    await this.#runtime.dispose(sessionId, reason);
  }

  // -------------------------------------------------------------------------- internals

  #acquireFor(sessionId: string): boolean {
    if (this.#slots.has(sessionId)) return true;
    if (!this.#semaphore.tryAcquire()) return false;
    this.#slots.add(sessionId);
    return true;
  }

  #release(sessionId: string): void {
    if (!this.#slots.delete(sessionId)) return;
    this.#semaphore.release();
  }

  /** The job's own lease signal, or ours, whichever fires first. */
  #waitSignal(jobSignal: AbortSignal): AbortSignal {
    const shutdown = this.#shutdown;
    return shutdown === null ? jobSignal : AbortSignal.any([jobSignal, shutdown.signal]);
  }

  #onStateChanged(event: EventEnvelope): void {
    const payload = event.payload as { sessionId?: unknown; fromState?: unknown };
    if (typeof payload.sessionId !== 'string') return;
    if (payload.fromState !== 'running') return;
    this.#release(payload.sessionId);
  }

  /**
   * The durable job (TDS 02 §4.3: FIFO, survives Backend restarts). Enqueued in a transaction
   * because `QueuePort` has no non-transactional form — the same rule that keeps the F6 outbox
   * honest keeps this honest too, even though the Session row itself is unchanged here.
   */
  async #enqueueLaunch(intent: LaunchIntent): Promise<void> {
    const payload: SessionLaunchJob = {
      sessionId: intent.session.id,
      fromState: intent.session.state as Extract<SessionState, 'created' | 'paused'>,
      action: intent.action,
      requestedAt: new Date().toISOString(),
      requestedBy: intent.requestedBy,
    };

    await this.#outbox.run(async (outboxTx) => {
      await this.#queue.enqueueJob(outboxTx.tx, QUEUE_NAMES.SESSION_LAUNCH, createJob(payload));
    });
  }

  async #consumeLaunchJob(payload: SessionLaunchJob, signal: AbortSignal): Promise<void> {
    // Idempotent consumption (F6.3). A redelivered job whose Session has already launched,
    // been archived, **been cancelled**, or moved on in any way finds a state mismatch and does
    // nothing.
    //
    // This is also the whole of "a queued launch can be revoked", and it costs nothing: a Session
    // cancelled while queued (`SessionService.cancel`) is `failed`, `failed !== 'created'`, and
    // the job returns here — *before* a slot is acquired and before a process is spawned. What
    // makes that a guarantee rather than a check is that it is not the check: see
    // `#performLaunch`, where F7 refuses the transition under `FOR UPDATE` even if the whole race
    // falls the other way.
    const session = await findSessionById(this.#db, payload.sessionId);
    if (session === null) return;
    if (session.state !== payload.fromState) return;
    if (this.#slots.has(payload.sessionId)) return;

    // Waiting here is what makes the queue FIFO: the consumer runs one job at a time, so a
    // launch that cannot start yet holds its place instead of being retried out of order.
    // On abort — the process shutting down, or the job's lease expiring — this **throws**:
    // returning normally would mark the job complete and silently drop a launch the operator
    // asked for.
    await this.#semaphore.acquire(this.#waitSignal(signal));
    this.#slots.add(payload.sessionId);

    // Re-read under the slot: a competing path may have launched it while we waited.
    const current = await findSessionById(this.#db, payload.sessionId);
    if (current === null || current.state !== payload.fromState) {
      this.#release(payload.sessionId);
      return;
    }

    try {
      await this.#performLaunch({
        session: current,
        action: payload.action,
        requestedBy: payload.requestedBy,
      });
    } catch (error) {
      this.#release(payload.sessionId);
      // A spawn failure already moved the Session to `failed` and emitted `session.failed`
      // (§6.2.1: "that outcome arrives as an event, not as the HTTP response"). Retrying the
      // job would only re-fail a Session that is already failed, so the job is done.
      if (error instanceof ApiError && error.code === 'RUNTIME_UNAVAILABLE') {
        this.#onLaunchError?.(error, payload.sessionId);
        return;
      }
      // The Session left its pre-launch state between the re-read above and the transition —
      // in practice, a cancel that committed inside that window. F7 refused the launch, which is
      // the correct outcome and **not** a job failure: redelivering would re-spawn and be refused
      // again, forever. `#performLaunch` has already disposed the runtime it briefly held.
      if (error instanceof ApiError && error.code === 'INVALID_STATE_TRANSITION') {
        this.#onLaunchError?.(error, payload.sessionId);
        return;
      }
      throw error;
    }
  }

  /**
   * Ask the runtime to spawn/attach, then record F7's "system confirms spawn" as
   * `created -> running` (or the in-place `paused -> running`). A spawn failure transitions the
   * Session to `failed` with `session.failed` and re-raises `RUNTIME_UNAVAILABLE` (§6.3).
   *
   * **The transition is the gate, and that is deliberate.** It locks the row `FOR UPDATE` and
   * validates against F7, so a Session that was cancelled after the caller's last read cannot
   * reach `running` however the race falls — the guarantee is the state machine's, not this
   * method's ordering. The one thing this method owes such a race is cleanup: a process was
   * spawned a moment ago for a launch that is now refused, and it must not be left holding a
   * working tree. So the refusal disposes it before re-raising.
   */
  async #performLaunch(intent: LaunchIntent): Promise<void> {
    const session = intent.session;
    const resumeFrom = await this.#resumeTargetFor(session);
    const agent = await this.#agentBindingFor(session);

    let outcome: Awaited<ReturnType<SessionRuntimePort['launch']>>;
    try {
      outcome = await this.#runtime.launch({
        sessionId: session.id,
        sessionType: session.sessionType as SessionType,
        workingDirectory: session.workingDir ?? '',
        model: session.model,
        branch: session.branch,
        resumeFromRuntimeSessionId: resumeFrom,
        fork: session.lineageKind === 'cloned' && session.runtimeSessionId === null,
        agent,
      });
    } catch (error) {
      await this.#failLaunch(session, error);
      throw asRuntimeUnavailable(error, session.id);
    }

    try {
      await this.#stateMachine.transition({
        sessionId: session.id,
        to: 'running',
        // F7: the user asked, the *system* confirms the spawn. The row records the user action
        // that started it, which is what the timeline is for.
        trigger: 'user',
        action: intent.action,
        runtime: {
          runtimeSessionId: outcome.runtimeSessionId,
          ...(outcome.runtimeVersion === undefined
            ? {}
            : { runtimeVersion: outcome.runtimeVersion }),
          ...(outcome.model === undefined ? {} : { model: outcome.model }),
          ...(outcome.machine === undefined ? {} : { machine: outcome.machine }),
          ...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
          ...(outcome.transcriptPath === undefined
            ? {}
            : { transcriptPath: outcome.transcriptPath }),
        },
        ...(intent.correlationId === undefined ? {} : { correlationId: intent.correlationId }),
      });
    } catch (error) {
      // Refused (the Session was cancelled or moved on mid-launch), or the write failed. Either
      // way the runtime we just obtained belongs to nothing: no row records it, no controller
      // will ever prompt it, and only a manual `[End]` would clear it. Best-effort, because a
      // dispose that throws must not replace the refusal with a less informative error.
      try {
        await this.#runtime.dispose(session.id, 'failed');
      } catch (disposeError) {
        /* c8 ignore next */
        this.#onLaunchError?.(disposeError, session.id);
      }
      throw error;
    }
  }

  async #failLaunch(session: SessionRow, error: unknown): Promise<void> {
    // TDS 03 §3.9 failure-reason vocabulary. `resume_target_lost` is F7's "process lost while
    // paused", which WS1 §5.1 says physically means "resume target gone", detected here.
    const reason = session.state === 'paused' ? 'resume_target_lost' : 'spawn_error';

    try {
      await this.#stateMachine.transition({
        sessionId: session.id,
        to: 'failed',
        trigger: 'system',
        action: 'system',
        reason,
      });
    } catch (transitionError) {
      /* c8 ignore next 2 */
      this.#onLaunchError?.(transitionError, session.id);
    }
    this.#onLaunchError?.(error, session.id);
  }

  /**
   * Which runtime-native session the launch resumes from (F1.5).
   *
   * Its own `runtime_session_id` when it has one (in-place resume, or a Session that has run
   * before); otherwise the parent's, reached through the lineage FK — a resume-as-new or Clone
   * row starts with `runtime_session_id` NULL because the runtime issues a fresh native id for
   * the resumed/forked conversation (TDS 03 §3.9).
   */
  /**
   * The Agent binding for this launch, read fresh at spawn time (PRD §5.1).
   *
   * Fresh rather than cached: an operator may edit an agent's instructions or permissions between
   * two launches of the same Session, and the launch that happens after the edit must be the one
   * the edit describes. Within a launch it is fixed — the system prompt is set at spawn and the
   * runtime offers no way to change it mid-conversation.
   *
   * A **missing** row throws rather than degrading to "no agent": `sessions.agent_id` is
   * `ON DELETE RESTRICT`, so this cannot happen, and if it somehow did, launching an unrestricted
   * session in place of a restricted one is the one outcome that must never be silent.
   */
  async #agentBindingFor(session: SessionRow): Promise<RuntimeAgentBinding | null> {
    if (session.agentId === null) return null;

    const binding = await this.#agents.bindingFor(session.agentId);
    if (binding === null) {
      throw new ApiError(
        'RUNTIME_UNAVAILABLE',
        'This session is bound to an agent that no longer exists; refusing to launch it unrestricted',
        { sessionId: session.id, agentId: session.agentId },
      );
    }
    return binding;
  }

  async #resumeTargetFor(session: SessionRow): Promise<string | null> {
    if (session.runtimeSessionId !== null) return session.runtimeSessionId;
    if (session.resumedFromSessionId === null) return null;

    const parent = await findSessionById(this.#db, session.resumedFromSessionId);
    return parent?.runtimeSessionId ?? null;
  }
}

function asRuntimeUnavailable(error: unknown, sessionId: string): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : 'Runtime launch failed';
  return new ApiError('RUNTIME_UNAVAILABLE', message, { sessionId });
}
