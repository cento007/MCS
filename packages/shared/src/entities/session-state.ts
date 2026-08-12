/**
 * F7 — Session state machine (canonical).
 *
 * This module is the single source of truth for which Session state transitions are
 * legal. TDS 02 §2 makes `apps/backend/src/sessions/state-machine.ts` the ONLY code path
 * that mutates `sessions.state`; that module validates against the table below.
 *
 * Vocabulary is verbatim per F9.5: `paused`, never "suspended"; "Session", never "Run".
 */

/** The six canonical states, stored lowercase (F7). */
export const SESSION_STATES = [
  'created',
  'running',
  'paused',
  'completed',
  'failed',
  'archived',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** Who caused a transition. Recorded with every transition for the session timeline (F7). */
export type TransitionTrigger = 'user' | 'system';

/** F4.1 — a Session is either driven by Mission Control or merely observed (F1.5). */
export type SessionType = 'managed' | 'observed';

/** F4.1 — Message roles. */
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * Legal transitions, verbatim from the F7 table.
 *
 * `completed` and `failed` are semi-terminal (only -> `archived`); `archived` is terminal.
 * States never move backward: "Resume Session" on a completed/archived Session creates a
 * NEW Session record linked via `resumed_from_session_id` (F7) — it is not a transition.
 * `paused -> running` IS an in-place transition on the same row (TDS 03 §3.9).
 */
export const SESSION_STATE_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> =
  Object.freeze({
    created: Object.freeze(['running', 'failed'] as const),
    running: Object.freeze(['paused', 'completed', 'failed'] as const),
    paused: Object.freeze(['running', 'completed', 'failed'] as const),
    completed: Object.freeze(['archived'] as const),
    failed: Object.freeze(['archived'] as const),
    archived: Object.freeze([] as const),
  });

/** Semi-terminal: the Session is over, but it can still be archived (F7). */
export const SEMI_TERMINAL_SESSION_STATES: readonly SessionState[] = Object.freeze([
  'completed',
  'failed',
]);

/** Terminal: no transition out exists (F7). */
export const TERMINAL_SESSION_STATE: SessionState = 'archived';

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}

/** True when `from -> to` appears in the F7 transition table. */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Thrown for a transition the F7 table does not contain.
 * The API surfaces this as HTTP 409 with error code `INVALID_STATE_TRANSITION`
 * (F7; error registry TDS 04 §1.3).
 */
export class InvalidStateTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION' as const;
  readonly from: SessionState;
  readonly to: SessionState;

  constructor(from: SessionState, to: SessionState) {
    super(`Invalid session state transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Narrowing guard: throws `InvalidStateTransitionError` unless `from -> to` is legal. */
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
