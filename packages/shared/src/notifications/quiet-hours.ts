import { sql } from 'drizzle-orm';
import type { Db, DbTransaction } from '../db/index.js';
import type { QuietHoursSettings } from '../settings/types.js';
import type { QuietHoursWindow } from './policy.js';

/**
 * Quiet hours (PRD §4.4.3, `notifications.quietHours`) — **deferral, not suppression**.
 *
 * ## The decision, and why
 *
 * A notification raised inside the quiet window is still created, still queued, and still
 * delivered — at the moment the window ends. It is **not** dropped.
 *
 * PRD §9 calls three of the five notification types "Alerts": failed syncs, repository
 * problems, session errors. An alert that is silently discarded because it happened at 02:00
 * is the single worst failure mode a notification system can have: the operator learns nothing,
 * and learns it invisibly. Quiet hours exist so the phone does not buzz at night — that is a
 * statement about *timing*, not about *interest*. Deferring honours both readings; suppressing
 * honours only one, and picks the destructive one.
 *
 * It is also nearly free to implement honestly: pg-boss has native delayed delivery, exposed
 * through `QueueJob.startAfterSeconds`, so the deferral is one computed number on a durable
 * job rather than a timer that dies with the process. Suppression would need no mechanism at
 * all, which is precisely why it is tempting and why it throws information away.
 *
 * ## How the choice is visible in the record
 *
 * `telegram_status` has four values (TDS 03 §4.2) and none of them means "deferred", so the
 * deferral is recorded where it can be seen without widening a CHECK constraint:
 *
 *   - `telegram_status` stays `pending` — which is the truth: it *is* pending;
 *   - `payload.quietHours = { deferredUntil, start, end, timezone }` records when and why;
 *   - the delivery job carries `startAfter`, so the queue itself shows the delay.
 *
 * Nothing is dropped and nothing is silent.
 *
 * ## Why the window is computed in SQL
 *
 * `start`/`end` are wall-clock `HH:mm` in `general.timezone`. Deciding whether "now" is inside
 * the window needs the local clock; computing the instant the window *ends* needs the reverse
 * conversion (local wall clock → UTC instant), which is the direction that goes wrong across a
 * DST boundary. PostgreSQL's `AT TIME ZONE` does both correctly, and the spend aggregate
 * (TDS 04 §7.8) and the schedule read model (§7.7) already set that precedent — adding the
 * boundary to the local timestamp *before* converting back is what makes a 23-hour day work.
 * The wrap-around predicate itself is pure and unit-tested below.
 */

/** Minutes since local midnight for a validated `HH:mm`, or `null` if it is not one. */
export function minutesOfDay(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Is a local wall-clock time inside `[start, end)`?
 *
 * The window wraps midnight whenever `end <= start` — `23:00 → 07:30` is the default and the
 * common case, so wrap-around is the rule here rather than the exception. A zero-length window
 * (`start === end`) is **empty**, not "all day": an operator who set both ends to the same
 * minute did not ask to be silenced permanently.
 */
export function isWithinQuietHours(localMinutes: number, start: string, end: string): boolean {
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  if (from === null || to === null || from === to) return false;

  return from < to
    ? localMinutes >= from && localMinutes < to
    : localMinutes >= from || localMinutes < to;
}

export const QUIET_HOURS_INACTIVE: QuietHoursWindow = Object.freeze({
  active: false,
  resumeAt: null,
});

export interface ReadQuietHoursOptions {
  readonly timezone: string;
  readonly settings: QuietHoursSettings;
  /**
   * The instant to evaluate. Left out, the statement reads `now()` — so the local clock and
   * the boundary come from the same source and cannot skew. Tests pass it to stand on a
   * particular minute (and on a particular side of a DST transition).
   */
  readonly at?: Date;
}

interface QuietHoursSqlRow extends Record<string, unknown> {
  local_minutes: string | number;
  resume_at: Date | string;
}

/**
 * Evaluate the quiet-hours window for `timezone`.
 *
 * One statement: the local minute-of-day (which decides membership) and the instant of the
 * next `end` boundary (which decides the deferral) are read together, so a request that lands
 * on the boundary cannot see one of them from before it and the other from after.
 */
export async function readQuietHoursWindow(
  db: Db | DbTransaction,
  options: ReadQuietHoursOptions,
): Promise<QuietHoursWindow> {
  const { settings } = options;
  if (!settings.enabled) return QUIET_HOURS_INACTIVE;
  if (minutesOfDay(settings.start) === null || minutesOfDay(settings.end) === null) {
    return QUIET_HOURS_INACTIVE;
  }

  const zone = sql`${options.timezone}::text`;
  const now = options.at === undefined ? sql`now()` : sql`${options.at}::timestamptz`;
  const endInterval = sql`${settings.end}::interval`;

  const result = await db.execute<QuietHoursSqlRow>(sql`
    WITH l AS (
      SELECT ${now} AT TIME ZONE ${zone} AS local_now
    ),
    b AS (
      SELECT l.local_now,
             extract(hour FROM l.local_now) * 60 + extract(minute FROM l.local_now) AS local_minutes,
             date_trunc('day', l.local_now) + ${endInterval} AS end_today
        FROM l
    )
    SELECT b.local_minutes,
           (CASE WHEN b.end_today > b.local_now THEN b.end_today
                 ELSE b.end_today + interval '1 day' END) AT TIME ZONE ${zone} AS resume_at
      FROM b
  `);

  const row = result.rows[0];
  /* c8 ignore next — a one-row CTE cannot return zero rows */
  if (row === undefined) return QUIET_HOURS_INACTIVE;

  const localMinutes = Math.floor(Number(row.local_minutes));
  if (!isWithinQuietHours(localMinutes, settings.start, settings.end)) return QUIET_HOURS_INACTIVE;

  return { active: true, resumeAt: asDate(row.resume_at) };
}

/** Seconds from `from` until `until`, at least 1 — the `startAfterSeconds` of a deferred job. */
export function deferralSeconds(until: Date, from: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - from.getTime()) / 1000));
}

// ------------------------------------------------------------------------- local calendar day

export interface LocalDayWindow {
  /** The instant local midnight fell on. */
  readonly dayStart: Date;
  /** The instant the next local midnight falls on (23, 24 or 25 hours later). */
  readonly dayEnd: Date;
  /** `YYYY-MM-DD` in the instance timezone — the daily report's own name for its day. */
  readonly localDate: string;
}

interface LocalDaySqlRow extends Record<string, unknown> {
  day_start: Date | string;
  day_end: Date | string;
  local_date: string;
}

/**
 * The instance-timezone calendar day containing `at` (default `now()`).
 *
 * Same construction as the spend aggregate (TDS 04 §7.8): `interval '1 day'` is added to the
 * **local** timestamp before it is converted back, so the day is 23 or 25 hours long across a
 * DST transition rather than a wrong 24.
 */
export async function readLocalDayWindow(
  db: Db | DbTransaction,
  timezone: string,
  at?: Date,
): Promise<LocalDayWindow> {
  const zone = sql`${timezone}::text`;
  const now = at === undefined ? sql`now()` : sql`${at}::timestamptz`;

  const result = await db.execute<LocalDaySqlRow>(sql`
    WITH b AS (
      SELECT date_trunc('day', ${now} AT TIME ZONE ${zone}) AS local_start
    )
    SELECT b.local_start                        AT TIME ZONE ${zone} AS day_start,
           (b.local_start + interval '1 day')   AT TIME ZONE ${zone} AS day_end,
           to_char(b.local_start, 'YYYY-MM-DD')                     AS local_date
      FROM b
  `);

  const row = result.rows[0];
  /* c8 ignore next — a one-row CTE cannot return zero rows */
  if (row === undefined) throw new Error('Local day window returned no rows');

  return {
    dayStart: asDate(row.day_start),
    dayEnd: asDate(row.day_end),
    localDate: row.local_date,
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
