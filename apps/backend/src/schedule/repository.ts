import { type Db, QUEUE_NAMES, schema } from '@mc/shared';
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
  /** The `memory.retention` chain's own job rows — see {@link readQueueTickTimes}. */
  readonly memoryRetention: QueueTickTimes;
}

export async function readScheduleSources(db: Db): Promise<ScheduleSources> {
  const [obsidian, repositories, dailyReport, memoryRetention] = await Promise.all([
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

    readQueueTickTimes(db, QUEUE_NAMES.MEMORY_RETENTION),
  ]);

  return {
    obsidianLastRunAt: obsidian[0]?.completedAt ?? null,
    repositoriesLastSyncedAt: asDate(repositories[0]?.lastSyncedAt ?? null),
    dailyReportLastRunAt: dailyReport[0]?.createdAt ?? null,
    memoryRetention,
  };
}

/** When a self-rescheduling job chain next fires, and when it last finished. */
export interface QueueTickTimes {
  /** `start_after` of the earliest tick still waiting. `null` when the chain is not scheduled. */
  readonly nextAt: Date | null;
  /** `completed_on` of the newest finished tick pg-boss still holds. */
  readonly lastRunAt: Date | null;
}

/**
 * Read a self-rescheduling chain's next and last tick **from the queue itself**.
 *
 * Every other row in §7.7 derives `nextRunAt` from an interval setting plus a domain artifact —
 * a `SyncRun`, `repositories.last_synced_at`, a `daily_report` Notification. The memory retention
 * chain has no such artifact: a sweep that deletes nothing writes nothing, and its interval is a
 * constant rather than a setting (`MEMORY_RETENTION_TICK_MINUTES` — deliberately not a knob). Its
 * next tick is a *durable job*, so the job is where the answer is, and it is the exact instant
 * rather than an interval arithmetic that would only agree with it by luck.
 *
 * **Best-effort and deliberately isolated**, exactly like `readOldestReadyJobAge` in
 * `health/services.ts`: this reads pg-boss's vendored table, so a schema change there must cost a
 * detail on one widget row, never the whole endpoint. `to_regclass` guards an install whose queue
 * has not been provisioned (the no-op queue, and every unit test).
 *
 * `lastRunAt` is bounded by pg-boss's own retention of completed jobs — it goes back to `null`
 * once the last successful tick has been deleted. That is a smaller claim than the other three
 * rows make, and it is the honest one available: nothing else records that a sweep happened.
 */
export async function readQueueTickTimes(db: Db, queueName: string): Promise<QueueTickTimes> {
  try {
    const result = await db.execute<{
      next_at: Date | string | null;
      last_at: Date | string | null;
    }>(
      sql`
        SELECT CASE WHEN to_regclass('pgboss.job') IS NULL THEN NULL ELSE (
                 SELECT min(start_after) FROM pgboss.job
                  WHERE name = ${queueName} AND state IN ('created', 'retry')) END AS next_at,
               CASE WHEN to_regclass('pgboss.job') IS NULL THEN NULL ELSE (
                 SELECT max(completed_on) FROM pgboss.job
                  WHERE name = ${queueName} AND state = 'completed') END AS last_at
      `,
    );

    return {
      nextAt: asDate(result.rows[0]?.next_at ?? null),
      lastRunAt: asDate(result.rows[0]?.last_at ?? null),
    };
  } catch {
    return { nextAt: null, lastRunAt: null };
  }
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
