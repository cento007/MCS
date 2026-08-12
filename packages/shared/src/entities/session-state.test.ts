import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidStateTransitionError,
  isSessionState,
  SESSION_STATE_TRANSITIONS,
  SESSION_STATES,
  type SessionState,
  TERMINAL_SESSION_STATE,
} from './session-state.js';

/**
 * The F7 table, restated here independently of the implementation so the test is a
 * contract check rather than a mirror of the code (TDS 07 §2.2: "every legal and
 * illegal transition").
 */
const LEGAL: ReadonlyArray<readonly [SessionState, SessionState]> = [
  ['created', 'running'],
  ['created', 'failed'],
  ['running', 'paused'],
  ['running', 'completed'],
  ['running', 'failed'],
  ['paused', 'running'],
  ['paused', 'completed'],
  ['paused', 'failed'],
  ['completed', 'archived'],
  ['failed', 'archived'],
];

const ALL_PAIRS: ReadonlyArray<readonly [SessionState, SessionState]> = SESSION_STATES.flatMap(
  (from) => SESSION_STATES.map((to) => [from, to] as const),
);

const isLegal = (from: SessionState, to: SessionState): boolean =>
  LEGAL.some(([f, t]) => f === from && t === to);

describe('F7 session state machine', () => {
  it('declares exactly the six canonical states', () => {
    expect([...SESSION_STATES]).toEqual([
      'created',
      'running',
      'paused',
      'completed',
      'failed',
      'archived',
    ]);
  });

  it('accepts every legal transition in the F7 table', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} -> ${to} should be legal`).toBe(true);
    }
  });

  it('rejects every transition absent from the F7 table, including self-transitions', () => {
    const illegal = ALL_PAIRS.filter(([from, to]) => !isLegal(from, to));
    // 36 ordered pairs total, 10 legal.
    expect(illegal).toHaveLength(26);
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} -> ${to} should be illegal`).toBe(false);
    }
  });

  it('never moves backward: no transition targets `created`', () => {
    for (const from of SESSION_STATES) {
      expect(SESSION_STATE_TRANSITIONS[from]).not.toContain('created');
    }
  });

  it('treats `archived` as terminal', () => {
    expect(SESSION_STATE_TRANSITIONS[TERMINAL_SESSION_STATE]).toHaveLength(0);
  });

  it('only allows `archived` out of the semi-terminal states', () => {
    expect([...SESSION_STATE_TRANSITIONS.completed]).toEqual(['archived']);
    expect([...SESSION_STATE_TRANSITIONS.failed]).toEqual(['archived']);
  });

  it('throws INVALID_STATE_TRANSITION for an illegal transition', () => {
    expect(() => assertTransition('archived', 'running')).toThrowError(InvalidStateTransitionError);
    try {
      assertTransition('completed', 'running');
      expect.unreachable('assertTransition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionError);
      const typed = error as InvalidStateTransitionError;
      expect(typed.code).toBe('INVALID_STATE_TRANSITION');
      expect(typed.from).toBe('completed');
      expect(typed.to).toBe('running');
    }
  });

  it('does not throw for a legal transition', () => {
    expect(() => assertTransition('paused', 'running')).not.toThrow();
  });

  it('guards unknown strings', () => {
    expect(isSessionState('running')).toBe(true);
    expect(isSessionState('suspended')).toBe(false);
    expect(isSessionState(undefined)).toBe(false);
  });
});
