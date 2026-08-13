import {
  type EventEnvelope,
  type Heartbeat,
  type Logger,
  type NotificationDispatchJob,
  QUEUE_NAMES,
  type QueueConsumerPort,
  type Unsubscribe,
} from '@mc/shared';
import type { DailyReportTickJob, TickSummary } from './daily-report.js';
import { DeliveryAbortedError, type DeliveryResult } from './delivery.js';

/**
 * Telegram Worker core (TDS 02 §2.2).
 *
 * What the shape enforces, and must keep enforcing:
 *   - the worker talks to the Backend ONLY through the queue (F2.2) — no HTTP client pointed at
 *     the Backend, no import of any Backend module;
 *   - delivery is at-least-once, so every handler is idempotent — the anchor is the
 *     `notifications` row, not the job id (see `delivery.ts`);
 *   - the process exposes no port; health is derived from the heartbeat row (TDS 02 §7.2).
 *
 * ## The three subscriptions
 *
 * | Queue                   | Why this worker has it                                          |
 * |-------------------------|-----------------------------------------------------------------|
 * | `notification.deliver`  | the dispatch job: send one Notification to Telegram             |
 * | `notification.schedule` | the self-rescheduling daily-report tick (TDS 02 §2.2)           |
 * | `events`                | F6 envelopes — and, in practice, the **drain** for that queue    |
 *
 * That last row deserves the honesty: the Backend enqueues every F6 event onto `events`
 * transactionally (F6.3) whether or not anything consumes it, and this worker is currently the
 * only subscriber. If it did not subscribe, `pgboss.job` would grow without bound and the
 * Services panel's queue depth would climb forever. It is also the seam through which
 * `setting.updated` arrives — which this worker needs for nothing today, because it reads
 * settings per operation rather than caching them.
 *
 * **Contract problem, recorded rather than hidden:** TDS 04 §15.2 lists the Sync Worker as a
 * consumer of the same `events` queue (`setting.updated`, `adr.created`, `adr.updated`). pg-boss
 * is a competing-consumer substrate — one job goes to exactly one subscriber — so two workers
 * on `events` will steal each other's envelopes. Fixing that needs either per-consumer queues
 * or a fan-out relay; neither exists, and inventing one here would be a foundation change.
 */

/**
 * The two collaborators, structurally typed.
 *
 * `DeliveryService` and `DailyReportService` satisfy these, and so does a two-line double — so
 * the wiring, the stats, and above all the **shutdown ordering** are unit-testable with no
 * database and no network, which is the tier that must keep passing without PostgreSQL.
 */
export interface DeliveryPort {
  deliver(job: NotificationDispatchJob, signal?: AbortSignal): Promise<DeliveryResult>;
  sweepPending(limit?: number): Promise<number>;
}

export interface DailyReportPort {
  tick(): Promise<TickSummary>;
  setStopping(stopping: boolean): void;
}

export interface WorkerOptions {
  readonly queue: QueueConsumerPort;
  readonly logger: Logger;
  readonly delivery: DeliveryPort;
  readonly dailyReport: DailyReportPort;
  readonly heartbeat?: Heartbeat;
  /** Aborted first on `stop()`, so an in-flight send cannot hold shutdown open. */
  readonly shutdown?: AbortController;
  /** Re-queue Notifications stranded `pending` by a previous process. Default `true`. */
  readonly sweepOnStart?: boolean;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Jobs processed / failed since start — the `stats` column of the heartbeat row. */
  stats(): Readonly<Record<string, number>>;
}

/** Queues this worker consumes (see the table above). */
export const SUBSCRIBED_QUEUES: readonly string[] = Object.freeze([
  QUEUE_NAMES.NOTIFICATION_DELIVER,
  QUEUE_NAMES.NOTIFICATION_SCHEDULE,
  QUEUE_NAMES.EVENTS,
]);

export function createWorker(options: WorkerOptions): Worker {
  const { queue, logger, delivery, dailyReport, heartbeat } = options;
  const unsubscribes: Unsubscribe[] = [];

  let running = false;
  let jobsProcessed = 0;
  let jobsFailed = 0;
  let notificationsSent = 0;

  const stats = (): Readonly<Record<string, number>> => ({
    jobsProcessed,
    jobsFailed,
    notificationsSent,
  });

  const handleEvent = async (event: EventEnvelope): Promise<void> => {
    // Consuming is the point (see the header): the Backend's events must not accumulate.
    // Nothing is *done* with them here — Notification production lives in the Backend, which
    // is the process that can write the row and its dispatch job in one transaction.
    jobsProcessed += 1;
    logger.debug({ eventId: event.id, eventType: event.type }, 'event drained');
  };

  const handleDelivery = async (
    job: NotificationDispatchJob,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      const result = await delivery.deliver(job, signal);
      jobsProcessed += 1;
      if (result.kind === 'sent') notificationsSent += 1;
      logDelivery(logger, result);
    } catch (error) {
      jobsFailed += 1;
      if (error instanceof DeliveryAbortedError) {
        // Expected during shutdown. `warn`, not `error`: nothing is broken, and the job comes
        // back to the next process because this one re-threw instead of completing it.
        logger.warn({ notificationId: job.notificationId }, error.message);
        throw error;
      }
      // Anything reaching here is infrastructure (the database went away). Telegram conditions
      // are recorded on the row, never thrown. pg-boss's retry budget covers this one.
      logger.error(
        { err: error, notificationId: job.notificationId },
        'notification delivery failed',
      );
      throw error;
    }
  };

  const handleTick = async (): Promise<void> => {
    jobsProcessed += 1;
    const summary = await dailyReport.tick();
    logger.debug({ ...summary }, 'daily report tick');
  };

  return {
    stats,

    async start() {
      if (running) return;
      running = true;
      dailyReport.setStopping(false);

      unsubscribes.push(
        await queue.subscribeJobs<NotificationDispatchJob>(
          QUEUE_NAMES.NOTIFICATION_DELIVER,
          async (job) => {
            await handleDelivery(job.payload, job.signal);
          },
          // Strictly one delivery at a time: Telegram rate-limits per chat, and a burst from a
          // sweep should queue rather than earn a 429 the operator then has to wait out.
          { concurrency: 1 },
        ),
      );

      unsubscribes.push(
        await queue.subscribeJobs<DailyReportTickJob>(
          QUEUE_NAMES.NOTIFICATION_SCHEDULE,
          handleTick,
          { concurrency: 1 },
        ),
      );

      unsubscribes.push(await queue.subscribe(QUEUE_NAMES.EVENTS, handleEvent));

      heartbeat?.start();
      // Beat once immediately: the Services panel shows a worker that has never written a row
      // as `disabled` ("not deployed"), so waiting 30 s would mean the first half-minute of
      // every run looks like a worker that was never installed.
      await heartbeat?.beat();

      // Prime the scheduler chain and recover anything a previous process left `pending`. Both
      // are idempotent, both are bounded, and both are what make a restart self-healing.
      const tick = await dailyReport.tick();
      logger.debug({ ...tick }, 'daily report chain primed');

      if (options.sweepOnStart !== false) {
        const swept = await delivery.sweepPending();
        if (swept > 0) logger.info({ swept }, 're-queued notifications left pending by a restart');
      }

      logger.info({ queues: [...SUBSCRIBED_QUEUES] }, 'telegram worker started');
    },

    async stop() {
      if (!running) return;
      running = false;

      // ORDER IS LOAD-BEARING. `offWork` waits for the in-flight handler, so the abort must
      // come first: a send parked on a 10 s HTTP deadline would otherwise hold shutdown for
      // those 10 s, and a send parked on something slower would hold it until the hard exit.
      options.shutdown?.abort();
      dailyReport.setStopping(true);
      heartbeat?.stop();

      for (const unsubscribe of unsubscribes.reverse()) await unsubscribe();
      unsubscribes.length = 0;
      await queue.stop();

      logger.info({ ...stats() }, 'telegram worker stopped');
    },
  };
}

function logDelivery(logger: Logger, result: DeliveryResult): void {
  switch (result.kind) {
    case 'sent':
      logger.info({ notificationId: result.notificationId }, 'notification delivered to telegram');
      return;
    case 'skipped':
      logger.info(
        { notificationId: result.notificationId, reason: result.reason },
        'notification not delivered — telegram is not configured for it',
      );
      return;
    case 'failed':
      // An expected condition with a recorded reason, not a defect: `warn`, not `error`.
      logger.warn(
        { notificationId: result.notificationId, reason: result.reason },
        'notification delivery failed permanently',
      );
      return;
    case 'retry_scheduled':
      logger.warn({ ...result }, 'notification delivery will be retried');
      return;
    case 'already_settled':
      logger.debug(
        { notificationId: result.notificationId, status: result.status },
        'redelivered job for an already-settled notification — nothing sent',
      );
      return;
    case 'missing':
      logger.warn(
        { notificationId: result.notificationId },
        'delivery job named a notification that no longer exists',
      );
  }
}
