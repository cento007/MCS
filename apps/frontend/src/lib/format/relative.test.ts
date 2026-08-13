import { describe, expect, it } from 'vitest';
import { formatCountdown, formatRelativePast } from './relative.js';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('formatRelativePast', () => {
  it('renders the compact past-tense ladder', () => {
    expect(formatRelativePast(at(-30_000), NOW)).toBe('now');
    expect(formatRelativePast(at(-4 * 60_000), NOW)).toBe('4m');
    expect(formatRelativePast(at(-3 * 3_600_000), NOW)).toBe('3h');
    expect(formatRelativePast(at(-2 * 86_400_000), NOW)).toBe('2d');
  });

  it('renders an em dash for a missing or unparseable instant', () => {
    expect(formatRelativePast(null, NOW)).toBe('—');
    expect(formatRelativePast('not a date', NOW)).toBe('—');
  });
});

describe('formatCountdown', () => {
  it('counts down in the operator-scale units', () => {
    expect(formatCountdown(at(12 * 60_000), NOW)).toBe('in 12m');
    expect(formatCountdown(at(3 * 3_600_000), NOW)).toBe('in 3h');
    expect(formatCountdown(at(30_000), NOW)).toBe('in <1m');
  });

  it('reports an overdue run as due rather than clamping it into the future', () => {
    // TDS 04 §7.7: "the endpoint reports the schedule, not the queue" — a `nextRunAt` in the
    // past means the run is due or overdue and must not be dressed up as a future time.
    expect(formatCountdown(at(-5 * 60_000), NOW)).toBe('due now');
  });
});
