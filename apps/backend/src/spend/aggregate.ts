import { type Db, schema } from '@mc/shared';
import { sql } from 'drizzle-orm';
import { toCount, toUsd } from './status.js';

/**
 * The spend aggregate (TDS 04 §7.8), verbatim.
 *
 * **Bounds are computed in SQL, in the same statement as the aggregate**, so the boundary and
 * the sum cannot disagree. `date_trunc` runs on the *local wall-clock* timestamp and the result
 * is converted back to an instant, which is what makes DST transitions yield correct 23-hour
 * and 25-hour days: adding `interval '1 day'` to the local timestamp before converting is not
 * the same as adding 24 hours to the UTC instant, and only the former is right.
 *
 * **Attribution is `sessions.started_at`** — not `created_at` (a Session created at 23:55 and
 * started next morning spends its money the next day) and not `completed_at` (a long-running
 * Session would contribute nothing all day and then dump its whole cost into whichever day it
 * finished — the exact failure mode WC1 exists to close). Cost on the row is cumulative, so a
 * Session spanning midnight keeps its whole cost on its start day.
 *
 * Every F7 state counts, `failed` and `archived` included: a failed Session spent real money
 * and archiving is retention housekeeping, not an accounting event. Observed Sessions normally
 * have `total_cost_usd IS NULL` and contribute `0` — and `sessionCount` counts only Sessions
 * with a non-NULL cost, which is what makes WS5's "Observed sessions report no cost" footnote
 * true instead of an excuse for a mismatch.
 *
 * One scan answers both periods because the day range is contained in the month range. Served
 * by `ix_sessions_started_at (started_at DESC) INCLUDE (total_cost_usd) WHERE started_at IS
 * NOT NULL` (TDS 03 §3.9, created by `0001_custom_include_and_fillfactor.sql`).
 */

export interface SpendPeriodRow {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly totalCostUsd: number;
  readonly sessionCount: number;
}

export interface SpendAggregate {
  readonly day: SpendPeriodRow;
  readonly month: SpendPeriodRow;
}

interface AggregateSqlRow extends Record<string, unknown> {
  day_start: Date | string;
  day_end: Date | string;
  month_start: Date | string;
  month_end: Date | string;
  day_cost: string | number | null;
  day_sessions: string | number | null;
  month_cost: string | number | null;
  month_sessions: string | number | null;
}

/**
 * PostgreSQL's `invalid_parameter_value` — what `AT TIME ZONE 'Mars/Olympus'` raises. The
 * caller uses it to fall back to UTC instead of failing the request (§7.8: "an unset or
 * unparseable `general.timezone` falls back to `UTC` … the endpoint neither fails nor silently
 * adopts the host zone").
 */
export const INVALID_TIMEZONE_SQLSTATE = '22023';

export function isInvalidTimezoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === INVALID_TIMEZONE_SQLSTATE
  );
}

export interface SpendAggregateOptions {
  /**
   * The instant "today" is measured from. **The endpoint never passes this** — it leaves the
   * statement reading `now()`, exactly as §7.8 specifies, so there is no clock skew between
   * the bounds and the rows.
   *
   * It exists because the DST property this query is built for — a 23-hour day in March and a
   * 25-hour day in November — is otherwise only observable twice a year on two specific days.
   * A seam that lets a test stand on 2026-11-01 is the difference between asserting the
   * behaviour and asserting that the SQL was typed correctly.
   */
  readonly at?: Date;
}

/**
 * Read both periods for `timezone`.
 *
 * The zone is a bind parameter cast to `text`: `timezone(text, timestamptz)` and
 * `timezone(interval, timestamptz)` both exist, so an untyped parameter would be ambiguous.
 */
export async function readSpendAggregate(
  db: Db,
  timezone: string,
  options: SpendAggregateOptions = {},
): Promise<SpendAggregate> {
  const zone = sql`${timezone}::text`;
  const now = options.at === undefined ? sql`now()` : sql`${options.at}::timestamptz`;

  const result = await db.execute<AggregateSqlRow>(sql`
    WITH b AS (
      SELECT (date_trunc('day',   ${now} AT TIME ZONE ${zone}))                      AT TIME ZONE ${zone} AS day_start,
             (date_trunc('day',   ${now} AT TIME ZONE ${zone}) + interval '1 day')   AT TIME ZONE ${zone} AS day_end,
             (date_trunc('month', ${now} AT TIME ZONE ${zone}))                      AT TIME ZONE ${zone} AS month_start,
             (date_trunc('month', ${now} AT TIME ZONE ${zone}) + interval '1 month') AT TIME ZONE ${zone} AS month_end
    ),
    agg AS (
      SELECT coalesce(sum(s.total_cost_usd) FILTER (WHERE s.started_at >= b.day_start
                                                      AND s.started_at <  b.day_end), 0)   AS day_cost,
             count(*) FILTER (WHERE s.started_at >= b.day_start AND s.started_at < b.day_end
                                AND s.total_cost_usd IS NOT NULL)                          AS day_sessions,
             coalesce(sum(s.total_cost_usd), 0)                                            AS month_cost,
             count(*) FILTER (WHERE s.total_cost_usd IS NOT NULL)                          AS month_sessions
        FROM b LEFT JOIN ${schema.sessions} s
          ON s.started_at >= b.month_start AND s.started_at < b.month_end
    )
    SELECT b.day_start, b.day_end, b.month_start, b.month_end,
           agg.day_cost, agg.day_sessions, agg.month_cost, agg.month_sessions
      FROM b CROSS JOIN agg
  `);

  const row = result.rows[0];
  if (row === undefined) {
    // Structurally impossible — `b` is a one-row CTE and `agg` is an ungrouped aggregate.
    throw new Error('Spend aggregate returned no rows');
  }

  return {
    day: {
      periodStart: asDate(row.day_start),
      periodEnd: asDate(row.day_end),
      totalCostUsd: toUsd(row.day_cost),
      sessionCount: toCount(row.day_sessions),
    },
    month: {
      periodStart: asDate(row.month_start),
      periodEnd: asDate(row.month_end),
      totalCostUsd: toUsd(row.month_cost),
      sessionCount: toCount(row.month_sessions),
    },
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
