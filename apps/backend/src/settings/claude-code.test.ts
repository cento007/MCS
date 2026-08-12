import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_THRESHOLD_PERCENT, parseCostBudget } from './claude-code.js';

/**
 * `integrations.claudeCode.costBudget` is one JSONB row read whole (§7.6 rule 1), so a single
 * corrupt field must not be able to erase the rest of the budget — that would silently turn a
 * budgeted instance into an unbudgeted one, which is the one failure mode a budget cannot have.
 */
describe('parseCostBudget (§7.2 / §7.8)', () => {
  it('reads a fully-specified budget', () => {
    expect(
      parseCostBudget({ dailyUsd: 10, perSessionUsd: 2.5, alertThresholdPercent: 70 }),
    ).toEqual({ dailyUsd: 10, perSessionUsd: 2.5, alertThresholdPercent: 70 });
  });

  it('defaults the threshold to 80 when absent or out of the 1–100 range', () => {
    expect(parseCostBudget({ dailyUsd: 10 }).alertThresholdPercent).toBe(
      DEFAULT_ALERT_THRESHOLD_PERCENT,
    );
    expect(parseCostBudget({ dailyUsd: 10, alertThresholdPercent: 0 }).alertThresholdPercent).toBe(
      DEFAULT_ALERT_THRESHOLD_PERCENT,
    );
    expect(
      parseCostBudget({ dailyUsd: 10, alertThresholdPercent: 101 }).alertThresholdPercent,
    ).toBe(DEFAULT_ALERT_THRESHOLD_PERCENT);
  });

  it('keeps a configured dailyUsd when a sibling field is corrupt', () => {
    expect(parseCostBudget({ dailyUsd: 10, alertThresholdPercent: 'eighty' })).toEqual({
      dailyUsd: 10,
      perSessionUsd: null,
      alertThresholdPercent: DEFAULT_ALERT_THRESHOLD_PERCENT,
    });
  });

  it('reads a missing or unusable row as "no budget configured"', () => {
    expect(parseCostBudget(undefined).dailyUsd).toBeNull();
    expect(parseCostBudget(null).dailyUsd).toBeNull();
    expect(parseCostBudget('10').dailyUsd).toBeNull();
    expect(parseCostBudget([10]).dailyUsd).toBeNull();
    expect(parseCostBudget({ dailyUsd: -1 }).dailyUsd).toBeNull();
  });

  it('keeps an explicit zero budget distinct from no budget', () => {
    expect(parseCostBudget({ dailyUsd: 0 }).dailyUsd).toBe(0);
    expect(parseCostBudget({ dailyUsd: null }).dailyUsd).toBeNull();
  });
});
