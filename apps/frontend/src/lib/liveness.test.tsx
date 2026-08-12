import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSocketStore } from '../stores/socket-store.js';
import { elapsedSeconds, formatElapsed, useDurationLabel, useLiveClock } from './liveness.js';

/**
 * The degraded-liveness rule (TDS 06 §3.3) — the behaviour the whole shell hangs on.
 *
 * > "**All client-side ticking durations FREEZE at their last known value.** A duration
 * > counter that keeps incrementing while the socket is dead is actively lying to the
 * > operator."
 *
 * This is asserted as a *component* behaviour, not just a formatter one, because the bug it
 * prevents is a timer that keeps running — and a timer is not visible in a pure function.
 */

const START = '2026-08-12T10:00:00.000Z';

function goLive(at: number): void {
  useSocketStore.getState().applySnapshot(
    {
      state: 'open',
      attempt: 0,
      connectionId: 'conn-1',
      lastConnectedAt: at,
      lastFrameAt: at,
      nextAttemptAt: null,
      authFailed: false,
      channels: [],
    },
    at,
  );
}

function dropConnection(at: number): void {
  useSocketStore.getState().applySnapshot(
    {
      state: 'backoff',
      attempt: 1,
      connectionId: null,
      lastConnectedAt: at - 1_000,
      lastFrameAt: at - 1_000,
      nextAttemptAt: at + 750,
      authFailed: false,
      channels: [],
    },
    at,
  );
}

function Duration({ startedAt, endedAt }: { startedAt: string; endedAt: string | null }) {
  return <output>{useDurationLabel(startedAt, endedAt)}</output>;
}

function ClockProbe() {
  const clock = useLiveClock(1_000);
  return <output>{`${clock.now}|${clock.frozen}`}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('elapsedSeconds (pure)', () => {
  it('marks a still-running duration frozen when the clock is frozen', () => {
    const clock = { now: Date.parse(START) + 125_000, frozen: true, frozenAt: Date.parse(START) };
    expect(elapsedSeconds(START, null, clock)).toEqual({ seconds: 125, frozen: true });
  });

  it('never marks a FINISHED duration frozen — it is server truth about the past', () => {
    // A completed Session's duration is not a claim about the present, so a `~` on it would
    // be noise rather than honesty.
    const clock = { now: Date.parse(START) + 999_000, frozen: true, frozenAt: Date.parse(START) };
    const end = new Date(Date.parse(START) + 60_000).toISOString();
    expect(elapsedSeconds(START, end, clock)).toEqual({ seconds: 60, frozen: false });
  });

  it('returns null for a Session that never started', () => {
    const clock = { now: Date.parse(START), frozen: false, frozenAt: null };
    expect(elapsedSeconds(null, null, clock).seconds).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('prefixes `~` only when frozen', () => {
    expect(formatElapsed({ seconds: 2530, frozen: false })).toBe('00:42:10');
    expect(formatElapsed({ seconds: 2530, frozen: true })).toBe('~00:42:10');
  });
});

describe('ticking durations freeze when the socket is not live', () => {
  it('ticks once a second while live', () => {
    act(() => goLive(Date.now()));
    render(<Duration startedAt={START} endedAt={null} />);
    expect(screen.getByRole('status').textContent).toBe('00:00:00');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('status').textContent).toBe('00:00:03');
  });

  it('freezes at the last known value and marks it `~` once the connection drops', () => {
    act(() => goLive(Date.now()));
    render(<Duration startedAt={START} endedAt={null} />);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('status').textContent).toBe('00:00:05');

    act(() => dropConnection(Date.now()));
    expect(screen.getByRole('status').textContent).toBe('~00:00:05');

    // The decisive assertion: real time keeps passing and the number does not move.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByRole('status').textContent).toBe('~00:00:05');
  });

  it('resumes from server truth when the connection returns', () => {
    act(() => goLive(Date.now()));
    render(<Duration startedAt={START} endedAt={null} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    act(() => dropConnection(Date.now()));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('status').textContent).toBe('~00:00:05');

    act(() => goLive(Date.now()));
    expect(screen.getByRole('status').textContent).toBe('00:01:05');
  });

  it('installs no interval at all while frozen', () => {
    // A dashboard left open on a dead connection should stop doing work, not spin a
    // second-resolution render loop over values that cannot change.
    act(() => dropConnection(Date.now()));
    render(<ClockProbe />);
    const before = screen.getByRole('status').textContent;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole('status').textContent).toBe(before);
    expect(before?.endsWith('|true')).toBe(true);
  });
});
