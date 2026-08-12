import { describe, expect, it } from 'vitest';
import { nextIntervalRunAt } from './rules.js';

const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('nextIntervalRunAt (§7.7)', () => {
  it('is lastRunAt + interval when there is a prior run', () => {
    const next = nextIntervalRunAt({
      enabled: true,
      intervalMinutes: 15,
      lastRunAt: new Date('2026-08-12T11:50:00.000Z'),
      now: NOW,
    });

    expect(next?.toISOString()).toBe('2026-08-12T12:05:00.000Z');
  });

  it('is now + interval when nothing has run yet', () => {
    const next = nextIntervalRunAt({
      enabled: true,
      intervalMinutes: 30,
      lastRunAt: null,
      now: NOW,
    });

    expect(next?.toISOString()).toBe('2026-08-12T12:30:00.000Z');
  });

  it('does not clamp a due/overdue run into the future', () => {
    // §7.7: "a computed nextRunAt in the past means the run is due/overdue — the endpoint
    // reports the schedule, not the queue". Clamping would hide a stalled worker.
    const next = nextIntervalRunAt({
      enabled: true,
      intervalMinutes: 15,
      lastRunAt: new Date('2026-08-12T09:00:00.000Z'),
      now: NOW,
    });

    expect(next?.toISOString()).toBe('2026-08-12T09:15:00.000Z');
    expect(next?.getTime()).toBeLessThan(NOW.getTime());
  });

  it('is null when disabled', () => {
    expect(
      nextIntervalRunAt({ enabled: false, intervalMinutes: 15, lastRunAt: null, now: NOW }),
    ).toBeNull();
  });

  it('is null when the interval is 0 — "manual only", not "every instant"', () => {
    expect(
      nextIntervalRunAt({ enabled: true, intervalMinutes: 0, lastRunAt: null, now: NOW }),
    ).toBeNull();
  });
});
