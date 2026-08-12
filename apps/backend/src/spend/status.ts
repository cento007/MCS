import type { CostBudget } from '../settings/claude-code.js';

/**
 * The `dayStatus` rule (TDS 04 §7.8), computed server-side **so four surfaces cannot disagree
 * about when the bar turns amber**: the Dashboard Spend widget, the shell top-bar chip, the
 * Needs Attention budget row, and the current-spend line in Settings → Claude Code.
 *
 * This is exactly WS5 §5.2's progress rule (success / warning / danger). Only the percentage
 * — a display rounding — is computed client-side.
 */

export type DayStatus = 'no_budget' | 'ok' | 'alert' | 'over';

export function deriveDayStatus(dayTotalUsd: number, budget: CostBudget): DayStatus {
  if (budget.dailyUsd === null) return 'no_budget';
  if (dayTotalUsd > budget.dailyUsd) return 'over';

  const threshold = (budget.dailyUsd * budget.alertThresholdPercent) / 100;
  return dayTotalUsd >= threshold ? 'alert' : 'ok';
}

/**
 * `numeric(12,6)` is exact in PostgreSQL and lossy the moment it becomes a JS `number`
 * (TDS 03 §3.9 stores money as `numeric`, never float — F4.2). Six decimals is the stored
 * scale, so rounding there is a faithful round-trip rather than a fudge, and it keeps
 * `0.30000000000000004` out of a money field on the Dashboard.
 */
export function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Postgres returns `numeric` as a string and `count(*)` as a bigint string. */
export function toUsd(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? roundUsd(parsed) : 0;
}

export function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}
