import { describe, expect, it } from 'vitest';
import type { CostBudget } from '../settings/claude-code.js';
import { deriveDayStatus, roundUsd, toCount, toUsd } from './status.js';

/**
 * The §7.8 status rule. It lives server-side so the Dashboard widget, the top-bar chip, the
 * Needs Attention row and the Settings spend line cannot disagree about when the bar turns
 * amber — which means this table is the single definition of that moment.
 */

function budget(overrides: Partial<CostBudget> = {}): CostBudget {
  return { dailyUsd: 10, perSessionUsd: null, alertThresholdPercent: 80, ...overrides };
}

describe('deriveDayStatus (§7.8)', () => {
  it('is no_budget when dailyUsd is null — a different statement from "alerts off"', () => {
    expect(deriveDayStatus(3.42, budget({ dailyUsd: null }))).toBe('no_budget');
    // …and it stays no_budget no matter how much was spent.
    expect(deriveDayStatus(9_999, budget({ dailyUsd: null }))).toBe('no_budget');
  });

  it('is ok below the alert threshold', () => {
    expect(deriveDayStatus(0, budget())).toBe('ok');
    expect(deriveDayStatus(7.999999, budget())).toBe('ok');
  });

  it('is alert AT the threshold (the boundary is inclusive)', () => {
    expect(deriveDayStatus(8, budget())).toBe('alert');
  });

  it('is alert up to and including the budget itself', () => {
    expect(deriveDayStatus(9.5, budget())).toBe('alert');
    expect(deriveDayStatus(10, budget())).toBe('alert');
  });

  it('is over only above the budget', () => {
    expect(deriveDayStatus(10.000001, budget())).toBe('over');
  });

  it('honours a non-default threshold', () => {
    expect(deriveDayStatus(5, budget({ alertThresholdPercent: 50 }))).toBe('alert');
    expect(deriveDayStatus(4.99, budget({ alertThresholdPercent: 50 }))).toBe('ok');
  });
});

describe('numeric coercion', () => {
  it('rounds to the stored numeric(12,6) scale rather than leaving float artifacts', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(0.0000004)).toBe(0);
    expect(roundUsd(1.2345675)).toBe(1.234568);
  });

  it('reads PostgreSQL numeric strings and bigint counts', () => {
    expect(toUsd('3.420000')).toBe(3.42);
    expect(toUsd(null)).toBe(0);
    expect(toUsd('not-a-number')).toBe(0);
    expect(toCount('12')).toBe(12);
    expect(toCount(null)).toBe(0);
  });
});
