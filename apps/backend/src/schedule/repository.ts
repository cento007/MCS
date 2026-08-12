import { type Db, schema } from '@mc/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

/**
 * The existing rows §7.7 derives `lastRunAt` from. **Nothing here is written, ever** — there is
 * no schedule table, no schedule event and no worker change; every value is read at the moment
 * the endpoint is called, so changing a setting changes the next read immediately.
 */

export interface ScheduleSources {
  /** `completedAt` of the newest `SyncRun` with `kind = 'obsidian'` (TDS 03 §4.5). */
  readonly obsidianLastRunAt: Date | null;
  /** `max(repositories.last_synced_at)` (TDS 03 §3.6). */
  readonly repositoriesLastSyncedAt: Date | null;
  /** `createdAt` of the newest Notification with `type = 'daily_report'` (TDS 03 §4.2). */
  readonly dailyReportLastRunAt: Date | null;
}

export async function readScheduleSources(db: Db): Promise<ScheduleSources> {
  const [obsidian, repositories, dailyReport] = await Promise.all([
    // Newest run first — served by `ix_sync_runs_kind_created_at`. A run still in flight has
    // `completed_at IS NULL`, which reads as "no completed run yet" rather than as a lie about
    // when the last one finished.
    db
      .select({ completedAt: schema.syncRuns.completedAt })
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.kind, 'obsidian'))
      .orderBy(desc(schema.syncRuns.createdAt))
      .limit(1),

    db
      .select({ lastSyncedAt: sql<Date | null>`max(${schema.repositories.lastSyncedAt})` })
      .from(schema.repositories),

    db
      .select({ createdAt: schema.notifications.createdAt })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.type, 'daily_report'),
          isNotNull(schema.notifications.createdAt),
        ),
      )
      .orderBy(desc(schema.notifications.createdAt))
      .limit(1),
  ]);

  return {
    obsidianLastRunAt: obsidian[0]?.completedAt ?? null,
    repositoriesLastSyncedAt: asDate(repositories[0]?.lastSyncedAt ?? null),
    dailyReportLastRunAt: dailyReport[0]?.createdAt ?? null,
  };
}

/**
 * The next occurrence of `HH:mm` in `timezone`, as a UTC instant (§7.7 `daily_report`).
 *
 * Computed in SQL for the same reason the spend bounds are (§7.8): the offset is added to the
 * **local** timestamp before conversion, so the wall-clock delivery time survives a DST
 * transition instead of drifting by an hour twice a year. `time` is a `HH:mm` string validated
 * upstream and cast to `interval` — `'18:00'::interval` is 18 hours.
 */
export async function readNextDailyReportAt(
  db: Db,
  options: { timezone: string; time: string },
): Promise<Date | null> {
  const zone = sql`${options.timezone}::text`;
  const time = sql`${options.time}::interval`;

  const result = await db.execute<{ next_run_at: Date | string | null }>(sql`
    WITH t AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${zone}) + ${time})                    AT TIME ZONE ${zone} AS today_at,
             (date_trunc('day', now() AT TIME ZONE ${zone}) + interval '1 day' + ${time}) AT TIME ZONE ${zone} AS tomorrow_at
    )
    SELECT CASE WHEN t.today_at > now() THEN t.today_at ELSE t.tomorrow_at END AS next_run_at FROM t
  `);

  return asDate(result.rows[0]?.next_run_at ?? null);
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}
