import {
  assertTransition,
  type EventPayload,
  type EventType,
  InvalidStateTransitionError,
  type SessionState,
  type SessionType,
  schema,
  type TransitionTrigger,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { Outbox, OutboxTransaction } from '../events/index.js';
import { ApiError } from '../http/errors.js';
import { insertSessionEvent, lockSessionById, type SessionRow } from './repository.js';

/**
 * **The only code path in this system that mutates `sessions.state`** (TDS 02 §2).
 *
 * Managed controllers, observed ingest, restart recovery and API handlers all come through
 * here. One transition is one transaction (TDS 03 §5):
 *
 *   `UPDATE sessions SET state = …, <lifecycle timestamp> = …` +
 *   `INSERT session_events` +
 *   outbox enqueue of `session.state_changed` **and** the specific lifecycle event (F7)
 *
 * Crash before commit = nothing happened. Crash after commit = the events are durably queued
 * (at-least-once, F6.3).
 *
 * Two distinct rejections, and conflating them was the thing WS1 §5.2 and WS2 §1.3 argued
 * about until `OPERATION_NOT_SUPPORTED` was pinned:
 *
 *   - `INVALID_STATE_TRANSITION` — the F7 table has no such edge.
 *   - `OPERATION_NOT_SUPPORTED` — the edge exists but the *session type* cannot take it.
 *     Mission Control does not own an observed Session's process and never signals, kills or
 *     throttles it, so `pause`/`resume`/user-`start` are meaningless there (WS1 §5.2).
 */

/** The sub-action that asked for the transition. Reported in `details.action` (§6.3). */
export type SessionAction = 'start' | 'pause' | 'resume' | 'end' | 'archive' | 'system';

/**
 * Actions an observed Session cannot take (WS1 §5.2):
 *   - `start`  — `created -> running` is system-only (attach confirmed), never a user action;
 *   - `pause`/`resume` — Mission Control cannot gate an external CLI.
 * `end` *is* supported and means "stop observing"; `archive` is identical to managed.
 */
const OBSERVED_UNSUPPORTED_ACTIONS: readonly SessionAction[] = ['start', 'pause', 'resume'];

/** Runtime facts captured at spawn/attach, written with the `created -> running` transition. */
export interface RuntimeFacts {
  readonly runtimeSessionId?: string | null;
  readonly runtimeVersion?: string | null;
  readonly model?: string | null;
  readonly machine?: string | null;
  readonly environment?: string | null;
  readonly transcriptPath?: string | null;
}

export interface TransitionRequest {
  readonly sessionId: string;
  readonly to: SessionState;
  readonly trigger: TransitionTrigger;
  readonly action: SessionAction;
  /**
   * `sessions.failure_reason`, repeated in the `session_events` payload for the timeline
   * (TDS 03 §3.9). Recommended vocabulary: `spawn_error`, `process_crash`, `backend_restart`,
   * `resume_target_lost`, `ingest_failure`.
   */
  readonly reason?: string | null;
  readonly correlationId?: string | null;
  readonly runtime?: RuntimeFacts;
  /** Injectable clock; also the `occurredAt` of both envelopes and the timeline row. */
  readonly at?: Date;
}

export interface TransitionResult {
  readonly session: SessionRow;
  readonly from: SessionState;
  readonly to: SessionState;
}

export interface SessionStateMachineOptions {
  readonly outbox: Outbox;
  readonly now?: () => Date;
}

export class SessionStateMachine {
  readonly #outbox: Outbox;
  readonly #now: () => Date;

  constructor(options: SessionStateMachineOptions) {
    this.#outbox = options.outbox;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Apply one F7 transition.
   *
   * @param ctx an already-open outbox transaction to join. The launch consumer and the
   *   observed ingest path both do more work in the same transaction; passing their context
   *   keeps it one atomic unit instead of two that can tear.
   */
  async transition(request: TransitionRequest, ctx?: OutboxTransaction): Promise<TransitionResult> {
    return this.#outbox.join(ctx, async (outboxTx) => {
      const at = request.at ?? this.#now();

      // FOR UPDATE: this is what serializes two concurrent lifecycle actions on one Session.
      // Without it both could read `running` and both write a transition out of it.
      const session = await lockSessionById(outboxTx.tx, request.sessionId);
      if (session === null) {
        throw new ApiError('NOT_FOUND', `No session with id ${request.sessionId}`);
      }

      const from = session.state as SessionState;
      assertApplicable(session.sessionType as SessionType, request.action, from, request.to);

      try {
        assertTransition(from, request.to);
      } catch (error) {
        if (error instanceof InvalidStateTransitionError) {
          throw new ApiError('INVALID_STATE_TRANSITION', error.message, {
            from,
            to: request.to,
            action: request.action,
          });
        }
        /* c8 ignore next */
        throw error;
      }

      const correlationId = request.correlationId ?? session.id;

      // ---- the one and only write to `sessions.state` -------------------------------
      const updated = await outboxTx.tx
        .update(schema.sessions)
        .set({
          state: request.to,
          ...lifecycleTimestamps(session, request.to, at),
          ...(request.to === 'failed' ? { failureReason: request.reason ?? null } : {}),
          ...runtimeColumns(request.runtime),
          updatedAt: at,
        })
        .where(eq(schema.sessions.id, session.id))
        .returning();

      const row = updated[0];
      /* c8 ignore next */
      if (row === undefined) throw new ApiError('INTERNAL', 'Session update returned no row');

      // ---- the timeline row (F7 "recorded with timestamp + trigger", TDS 03 §3.10) ----
      await insertSessionEvent(outboxTx.tx, {
        sessionId: session.id,
        type: 'session.state_changed',
        trigger: request.trigger,
        fromState: from,
        toState: request.to,
        payload: {
          sessionId: session.id,
          fromState: from,
          toState: request.to,
          trigger: request.trigger,
          ...(request.reason === undefined || request.reason === null
            ? {}
            : { reason: request.reason }),
        },
        correlationId,
        occurredAt: at,
      });

      // ---- both envelopes, same correlationId (TDS 04 §15.2 note) --------------------
      await outboxTx.emit(
        this.#outbox.event(
          'session.state_changed',
          {
            sessionId: session.id,
            fromState: from,
            toState: request.to,
            trigger: request.trigger,
          },
          { correlationId, occurredAt: at },
        ),
      );

      const specific = specificEventFor(from, request.to, request.trigger, request.reason ?? null, {
        sessionId: session.id,
      });
      await outboxTx.emit(
        this.#outbox.event(specific.type, specific.payload, { correlationId, occurredAt: at }),
      );

      return { session: row, from, to: request.to };
    });
  }
}

/**
 * `OPERATION_NOT_SUPPORTED` (409) — the F7 edge is legal but this session type cannot take it
 * (TDS 04 §1.3, WS1 §5.2). Checked *before* the transition table so an observed Session's
 * `pause` reports "unsupported" rather than an edge legality that is beside the point.
 */
function assertApplicable(
  sessionType: SessionType,
  action: SessionAction,
  from: SessionState,
  to: SessionState,
): void {
  if (sessionType !== 'observed') return;
  if (!OBSERVED_UNSUPPORTED_ACTIONS.includes(action)) return;

  throw new ApiError(
    'OPERATION_NOT_SUPPORTED',
    `Action '${action}' is not applicable to an observed session`,
    { from, to, action, sessionType },
  );
}

/**
 * Lifecycle moments get dedicated columns (F4.2). `completed_at` is set on `completed` **and**
 * `failed` (TDS 03 §3.9); `started_at` is written once, so an in-place `paused -> running`
 * resume does not rewrite the Session's start time.
 */
function lifecycleTimestamps(
  session: SessionRow,
  to: SessionState,
  at: Date,
): { startedAt?: Date; completedAt?: Date; archivedAt?: Date } {
  switch (to) {
    case 'running':
      return session.startedAt === null ? { startedAt: at } : {};
    case 'completed':
    case 'failed':
      return { completedAt: at };
    case 'archived':
      return { archivedAt: at };
    default:
      return {};
  }
}

function runtimeColumns(runtime: RuntimeFacts | undefined): Record<string, string | null> {
  if (runtime === undefined) return {};
  return {
    ...(runtime.runtimeSessionId === undefined
      ? {}
      : { runtimeSessionId: runtime.runtimeSessionId }),
    ...(runtime.runtimeVersion === undefined ? {} : { runtimeVersion: runtime.runtimeVersion }),
    ...(runtime.model === undefined ? {} : { model: runtime.model }),
    ...(runtime.machine === undefined ? {} : { machine: runtime.machine }),
    ...(runtime.environment === undefined ? {} : { environment: runtime.environment }),
    ...(runtime.transcriptPath === undefined ? {} : { transcriptPath: runtime.transcriptPath }),
  };
}

/**
 * The specific lifecycle event that accompanies every `session.state_changed` (F7 rule,
 * catalog TDS 04 §15.2 rows 3–8). Payloads carry entity IDs and small scalar discriminators
 * only — never entities (F6.1).
 */
function specificEventFor(
  from: SessionState,
  to: SessionState,
  trigger: TransitionTrigger,
  reason: string | null,
  base: { sessionId: string },
): { type: EventType; payload: EventPayload } {
  switch (to) {
    case 'running':
      return from === 'paused'
        ? // §15.2 row 5: null for the in-place `paused -> running` resume; a resume-as-new is
          // a different Session and emits its own `session.created`.
          { type: 'session.resumed', payload: { ...base, resumedFromSessionId: null } }
        : { type: 'session.started', payload: base };
    case 'paused':
      return { type: 'session.paused', payload: base };
    case 'completed':
      return { type: 'session.completed', payload: { ...base, trigger } };
    case 'failed':
      return { type: 'session.failed', payload: { ...base, reason } };
    case 'archived':
      return { type: 'session.archived', payload: { ...base, trigger } };
    /* c8 ignore next 4 — `created` is unreachable: F7 has no edge back into it */
    default:
      throw new ApiError('INTERNAL', `No lifecycle event defined for state ${to}`);
  }
}
