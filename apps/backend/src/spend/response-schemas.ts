import {
  type Assert,
  booleanValue,
  type ExactShape,
  enumSchema,
  integerValue,
  nullableNumber,
  numberValue,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { SpendPeriodResource, SpendResource } from './index.js';
import type { DayStatus } from './status.js';

/**
 * The `GET /api/v1/spend` read model (TDS 04 §7.8).
 *
 * `dayStatus` is computed server-side on purpose: four surfaces state the same spend number, and
 * they must never disagree about when the bar turns amber.
 */

const spendPeriodSchema = objectSchema('SpendPeriod', {
  /** ISO 8601 UTC, inclusive. */
  periodStart: timestampValue,
  /** ISO 8601 UTC, exclusive. */
  periodEnd: timestampValue,
  totalCostUsd: numberValue,
  sessionCount: integerValue,
});
export type _SpendPeriodShape = Assert<ExactShape<SpendPeriodResource, typeof spendPeriodSchema>>;

const SPEND_DAY_STATUSES = ['no_budget', 'ok', 'alert', 'over'] as const;
export type _SpendDayStatusIsCovered = Assert<
  [Exclude<DayStatus, (typeof SPEND_DAY_STATUSES)[number]>] extends [never] ? true : false
>;

export const spendSchema = objectSchema('Spend', {
  /** The IANA zone actually used — `general.timezone`, or `UTC` when unset/unparseable. */
  timezone: stringValue,
  generatedAt: timestampValue,
  /** Current calendar day **in `timezone`**, never UTC-by-accident. */
  day: spendPeriodSchema,
  month: spendPeriodSchema,
  budget: objectSchema('SpendBudget', {
    dailyUsd: nullableNumber,
    perSessionUsd: nullableNumber,
    alertThresholdPercent: integerValue,
    /** `false` hides the top-bar chip; the numbers are still returned. */
    alertsEnabled: booleanValue,
  }),
  dayStatus: enumSchema(
    'SpendDayStatus',
    SPEND_DAY_STATUSES,
    'Computed server-side, deliberately: four surfaces state the same spend number and must never disagree about when the bar turns amber. The client rounds a percentage for display and derives nothing else.',
  ),
});
export type _SpendShape = Assert<ExactShape<SpendResource, typeof spendSchema>>;
