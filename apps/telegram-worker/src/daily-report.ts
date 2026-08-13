import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  createEvent,
  createJob,
  type Db,
  decideNotification,
  emitWorkerEvent,
  type LocalDayWindow,
  type NotificationPayload,
  QUEUE_NAMES,
  type Queue,
  readLocalDayWindow,
  readQuietHoursWindow,
  schema,
  type UndeliverableEvent,
  writeNotification,
} from '@mc/shared';
import { and, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import {
  readNotificationRecipientId,
  readNotificationSettings,
  readTelegramSettings,
  readTimezone,
} from './settings.js';

/**
 * The daily report (PRD §9: "Projects, Sessions, PRs, ADRs") — TDS 02 §2.2's
 * "scheduled daily-report job", owned by this worker.
 *
 * ## Why a self-rescheduling tick and not cron
 *
 * The delivery time is a **wall-clock time in the instance timezone**
 * (`notifications.dailyReport.time` in `general.timezone`), and both halves of that can change
 * from the Settings page at any moment. A cron expression is fixed at registration and knows
 * nothing about `general.timezone`; a `setInterval` dies with the process. A durable job that
 * re-reads both settings on every tick and enqueues its own successor survives a restart, picks
 * up a changed time within one tick, and needs no new mechanism — it is exactly the pattern
 * `github.poll` already uses in the Backend.
 *
 * The tick interval is a **ceiling**, not the schedule: each tick asks the database how long
 * until the next due moment and sleeps for the smaller of that and `TICK_CEILING_SECONDS`. So
 * the report fires within a second of its configured minute, while a settings change is still
 * noticed inside a minute.
 *
 * ## What makes it fire at the right local time
 *
 * `readLocalDayWindow` computes local midnight in SQL, exactly as the spend aggregate does
 * (TDS 04 §7.8): `date_trunc('day', now() AT TIME ZONE zone) AT TIME ZONE zone`, with
 * `interval '1 day'` added to the **local** timestamp before conversion. A day is therefore 23
 * or 25 hours long across a DST transition rather than a wrong 24, and `18:00` stays 18:00
 * local on both sides of the change. `GET /schedule`'s `daily_report.nextRunAt` is computed
 * from the same two settings by the same construction, so the widget and the worker cannot
 * disagree about when the report is due.
 *
 * ## What makes it fire once
 *
 * The `notifications` table is the ledger: a report is due only if `now >= dueAt` **and** no
 * `daily_report` Notification has been created since local midnight. That is durable, survives
 * a restart, and is the same row `GET /schedule` reads for `lastRunAt`.
 */

/** The tick payload. A job name, not an event (TDS 04 §15.2). */
export type DailyReportTickJob = {
  readonly scheduledFor: string;
};

/** Longest a tick will sleep. Bounds how stale a settings change can be. */
export const TICK_CEILING_SECONDS = 60;

export interface DailyReportCounts {
  readonly projects: number;
  readonly sessionsStarted: number;
  readonly sessionsCompleted: number;
  readonly sessionsFailed: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  readonly adrs: number;
  readonly commits: number;
  readonly spendUsd: number;
}

export interface TickSummary {
  readonly ran: boolean;
  readonly reason: 'produced' | 'not_due' | 'already_sent' | 'disabled' | 'no_recipient';
  readonly notificationId: string | null;
  readonly nextTickInSeconds: number;
}

/**
 * Pure: should this tick produce a report?
 *
 * Split out from the SQL so the "fires once a day, at the configured local time, even if the
 * worker was down when it came round" rule is testable without a database or a clock.
 */
export function isDailyReportDue(input: {
  readonly enabled: boolean;
  readonly now: Date;
  readonly dueAt: Date;
  readonly dayStart: Date;
  readonly lastReportAt: Date | null;
}): boolean {
  if (!input.enabled) return false;
  if (input.now < input.dueAt) return false;
  // A worker that was asleep at 18:00 and woke at 19:00 still owes today's report; one that
  // already sent it at 18:00 does not owe a second at 18:01.
  return input.lastReportAt === null || input.lastReportAt < input.dayStart;
}

/** Seconds until the next tick: the smaller of "until due" and the ceiling, at least 1. */
export function nextTickSeconds(now: Date, dueAt: Date | null): number {
  if (dueAt === null) return TICK_CEILING_SECONDS;
  const untilDue = Math.ceil((dueAt.getTime() - now.getTime()) / 1000);
  if (untilDue <= 0) return TICK_CEILING_SECONDS;
  return Math.max(1, Math.min(TICK_CEILING_SECONDS, untilDue));
}

export interface DailyReportServiceOptions {
  readonly db: Db;
  readonly queue: Queue;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context: string) => void;
  /** The best-effort relay could not carry an envelope (TDS 04 §15.1). Logged, never fatal. */
  readonly onUndeliverable?: (info: UndeliverableEvent) => void;
}

export class DailyReportService {
  readonly #db: Db;
  readonly #queue: Queue;
  readonly #now: () => Date;
  readonly #onUndeliverable: ((info: UndeliverableEvent) => void) | undefined;

  #stopping = false;

  constructor(options: DailyReportServiceOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date());
    this.#onUndeliverable = options.onUndeliverable;
  }

  setStopping(stopping: boolean): void {
    this.#stopping = stopping;
  }

  /**
   * One scheduler tick. Public because it is the seam a test drives — the queue is a delivery
   * mechanism, not the behaviour.
   */
  async tick(): Promise<TickSummary> {
    const now = this.#now();

    const [notifications, telegram, timezone] = await Promise.all([
      readNotificationSettings(this.#db),
      readTelegramSettings(this.#db),
      readTimezone(this.#db),
    ]);

    // `GET /schedule` reports the `daily_report` row as enabled only when BOTH the daily-report
    // setting and the Telegram integration are on (§7.7). Producing on a different rule would
    // make the widget lie in one direction or the other.
    const enabled = notifications.dailyReport.enabled && telegram.enabled;
    if (!enabled) {
      const next = await this.#schedule(now, null);
      return { ran: false, reason: 'disabled', notificationId: null, nextTickInSeconds: next };
    }

    const day = await readLocalDayWindow(this.#db, timezone, now);
    const dueAt = new Date(
      day.dayStart.getTime() + minutesOfDay(notifications.dailyReport.time) * 60_000,
    );
    const lastReportAt = await this.#lastReportAt();

    if (!isDailyReportDue({ enabled, now, dueAt, dayStart: day.dayStart, lastReportAt })) {
      const next = await this.#schedule(now, dueAt);
      const reason =
        lastReportAt !== null && lastReportAt >= day.dayStart ? 'already_sent' : 'not_due';
      return { ran: false, reason, notificationId: null, nextTickInSeconds: next };
    }

    const notificationId = await this.produce(day, timezone, now);
    const next = await this.#schedule(now, null);

    return {
      ran: notificationId !== null,
      reason: notificationId === null ? 'no_recipient' : 'produced',
      notificationId,
      nextTickInSeconds: next,
    };
  }

  /**
   * Build and write today's report.
   *
   * The row and its delivery job go through the same shared `writeNotification` primitive the
   * Backend producer uses, on one transaction, so a daily report can no more exist
   * undelivered-and-unqueued than any other Notification can (F6.3).
   */
  async produce(day: LocalDayWindow, timezone: string, now: Date): Promise<string | null> {
    const [userId, notifications, telegram, counts] = await Promise.all([
      readNotificationRecipientId(this.#db),
      readNotificationSettings(this.#db),
      readTelegramSettings(this.#db),
      this.#counts(day),
    ]);

    if (userId === null) return null;

    const quietHours = await readQuietHoursWindow(this.#db, {
      timezone,
      settings: notifications.quietHours,
      at: now,
    });

    const decision = decideNotification({
      type: 'daily_report',
      toggles: notifications.events,
      telegram,
      quietHours,
    });

    /* c8 ignore next — `daily_report` has no event toggle, so `create` is always true here */
    if (!decision.create) return null;

    const rendered = renderDailyReport(counts, day, timezone);
    const payload: NotificationPayload = {
      // No `eventType`: a scheduled job has no originating F6 event (arbitration A8).
      localDate: day.localDate,
      timezone,
      counts: { ...counts },
    };

    return this.#db.transaction(async (tx) => {
      const written = await writeNotification(tx, this.#queue, {
        userId,
        type: 'daily_report',
        title: rendered.title,
        body: rendered.body,
        payload,
        decision,
        quietHours: {
          start: notifications.quietHours.start,
          end: notifications.quietHours.end,
          timezone,
        },
        now,
      });

      // Durable enqueue + the best-effort `LISTEN/NOTIFY` relay to the Backend's hub, on this
      // same transaction (TDS 04 §15.1). `emitWorkerEvent` is the only supported emit path in a
      // worker: doing the enqueue alone would leave the `notifications` WS channel unaware that
      // the daily report exists until the browser next polled.
      await emitWorkerEvent(
        tx,
        this.#queue,
        createEvent(
          'notification.created',
          'telegram-worker',
          {
            notificationId: written.id,
            notificationType: 'daily_report',
            severity: decision.severity,
          },
          { occurredAt: now },
        ),
        {
          ...(this.#onUndeliverable === undefined
            ? {}
            : { onUndeliverable: this.#onUndeliverable }),
        },
      );

      return written.id;
    });
  }

  /** Enqueue the next tick. Returns the delay it used. */
  async #schedule(now: Date, dueAt: Date | null): Promise<number> {
    const delaySeconds = nextTickSeconds(now, dueAt);
    if (this.#stopping) return delaySeconds;

    const scheduledFor = new Date(now.getTime() + delaySeconds * 1000);

    await this.#db.transaction(async (tx) => {
      await this.#queue.enqueueJob<DailyReportTickJob>(
        tx,
        QUEUE_NAMES.NOTIFICATION_SCHEDULE,
        createJob<DailyReportTickJob>(
          { scheduledFor: scheduledFor.toISOString() },
          // Deterministic id, bucketed to the second the tick targets, so a restart that primes
          // a tick while the previous chain's tick is still pending collapses into one job
          // (`ON CONFLICT (name, id) DO NOTHING`) instead of starting a second chain. Without
          // it, every `tsx watch` reload in development would add another scheduler.
          tickJobId(scheduledFor),
          { startAfterSeconds: delaySeconds },
        ),
      );
    });

    return delaySeconds;
  }

  /** `created_at` of the newest `daily_report` Notification — the same row `/schedule` reads. */
  async #lastReportAt(): Promise<Date | null> {
    const rows = await this.#db
      .select({ createdAt: schema.notifications.createdAt })
      .from(schema.notifications)
      .where(eq(schema.notifications.type, 'daily_report'))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(1);

    return rows[0]?.createdAt ?? null;
  }

  /**
   * The four PRD §9 figures, plus commits and spend, for one local calendar day.
   *
   * Attribution matches the spend read model (§7.8): a Session belongs to the day it
   * **started**, not the day it was created or finished, so a Session running across midnight
   * is counted once, on the day the operator started it.
   */
  async #counts(day: LocalDayWindow): Promise<DailyReportCounts> {
    const { dayStart, dayEnd } = day;
    const inDay = (column: Parameters<typeof gte>[0]) =>
      and(gte(column, dayStart), lt(column, dayEnd));

    const [sessions, projects, pullRequests, adrs, commits] = await Promise.all([
      this.#db
        .select({
          started: count(),
          completed: sql<number>`count(*) FILTER (WHERE ${schema.sessions.state} = 'completed')`,
          failed: sql<number>`count(*) FILTER (WHERE ${schema.sessions.state} = 'failed')`,
          spend: sql<string>`coalesce(sum(${schema.sessions.totalCostUsd}), 0)`,
        })
        .from(schema.sessions)
        .where(inDay(schema.sessions.startedAt)),

      this.#db
        .select({ total: sql<number>`count(DISTINCT ${schema.sessions.projectId})` })
        .from(schema.sessions)
        .where(inDay(schema.sessions.startedAt)),

      this.#db
        .select({
          opened: sql<number>`count(*) FILTER (WHERE ${schema.pullRequests.openedAt} >= ${dayStart} AND ${schema.pullRequests.openedAt} < ${dayEnd})`,
          merged: sql<number>`count(*) FILTER (WHERE ${schema.pullRequests.mergedAt} >= ${dayStart} AND ${schema.pullRequests.mergedAt} < ${dayEnd})`,
        })
        .from(schema.pullRequests)
        .where(
          and(
            isNotNull(schema.pullRequests.repositoryId),
            sql`(${schema.pullRequests.openedAt} >= ${dayStart} AND ${schema.pullRequests.openedAt} < ${dayEnd})
                 OR (${schema.pullRequests.mergedAt} >= ${dayStart} AND ${schema.pullRequests.mergedAt} < ${dayEnd})`,
          ),
        ),

      this.#db.select({ total: count() }).from(schema.adrs).where(inDay(schema.adrs.createdAt)),

      this.#db
        .select({ total: count() })
        .from(schema.commits)
        .where(inDay(schema.commits.committedAt)),
    ]);

    return {
      projects: toCount(projects[0]?.total),
      sessionsStarted: toCount(sessions[0]?.started),
      sessionsCompleted: toCount(sessions[0]?.completed),
      sessionsFailed: toCount(sessions[0]?.failed),
      pullRequestsOpened: toCount(pullRequests[0]?.opened),
      pullRequestsMerged: toCount(pullRequests[0]?.merged),
      adrs: toCount(adrs[0]?.total),
      commits: toCount(commits[0]?.total),
      spendUsd: toUsd(sessions[0]?.spend),
    };
  }
}

// -------------------------------------------------------------------------------- rendering

/** PRD §9: "Daily Report: Projects, Sessions, PRs, ADRs". Pure. */
export function renderDailyReport(
  counts: DailyReportCounts,
  day: LocalDayWindow,
  timezone: string,
): { title: string; body: string } {
  const quiet =
    counts.sessionsStarted === 0 &&
    counts.pullRequestsOpened === 0 &&
    counts.pullRequestsMerged === 0 &&
    counts.adrs === 0;

  const lines = [
    `Projects active: ${counts.projects}`,
    `Sessions: ${counts.sessionsStarted} started · ${counts.sessionsCompleted} completed · ${counts.sessionsFailed} failed`,
    `Pull requests: ${counts.pullRequestsOpened} opened · ${counts.pullRequestsMerged} merged`,
    `ADRs: ${counts.adrs}`,
    `Commits: ${counts.commits}`,
    `Spend: $${counts.spendUsd.toFixed(2)}`,
    `Day: ${day.localDate} (${timezone})`,
    // A report that says "nothing happened" is still information; an empty one looks broken.
    quiet ? 'No activity recorded for this day.' : null,
  ].filter((line): line is string => line !== null);

  return { title: `Daily report — ${day.localDate}`, body: lines.join('\n') };
}

// ---------------------------------------------------------------------------------- helpers

/** `HH:mm` → minutes since local midnight. The value is registry-validated upstream. */
function minutesOfDay(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  /* c8 ignore next — `normalizeSetting` cannot return an unparseable time */
  if (match === null) return 18 * 60;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A deterministic UUID for the tick targeting `scheduledFor`, bucketed to the second.
 *
 * Same construction and the same reason as the GitHub poller's `tickJobId`: two callers that
 * want a tick in the same slot produce the same id, so pg-boss collapses them.
 */
export function tickJobId(scheduledFor: Date): string {
  const bucket = Math.floor(scheduledFor.getTime() / 1000);
  const hex = createHash('sha256')
    .update(`${QUEUE_NAMES.NOTIFICATION_SCHEDULE}:${String(bucket)}`)
    .digest();

  const bytes = Uint8Array.prototype.slice.call(hex, 0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const text = Buffer.from(bytes).toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function toUsd(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 1_000_000) / 1_000_000 : 0;
}
