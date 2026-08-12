import {
  SEMI_TERMINAL_SESSION_STATES,
  type SessionState,
  TERMINAL_SESSION_STATE,
} from '@mc/shared';

/**
 * When observation is over — derived from F7 rather than re-typed, so a state added to the
 * machine cannot leave this list behind (F9.5 vocabulary discipline).
 *
 * `completed`, `failed` and `archived` are the states from which no further transcript line or
 * hook event can legitimately belong to the Session. Reaching one means "stop observing"
 * (TDS 02 §5.2): Mission Control detaches the tailer and ignores subsequent hook traffic for
 * that runtime id. It emphatically does **not** mean the operator's `claude` process stopped —
 * Mission Control does not own that process and never signals, kills or throttles it.
 */
export const OBSERVATION_CLOSED_STATES: readonly SessionState[] = Object.freeze([
  ...SEMI_TERMINAL_SESSION_STATES,
  TERMINAL_SESSION_STATE,
]);

export function isObservationClosed(state: string): boolean {
  return (OBSERVATION_CLOSED_STATES as readonly string[]).includes(state);
}
