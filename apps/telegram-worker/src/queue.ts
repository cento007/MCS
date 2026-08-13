import {
  createPgBossQueue,
  EVENTS_QUEUE,
  NOTIFICATION_DELIVER_QUEUE,
  NOTIFICATION_SCHEDULE_QUEUE,
  type PgBossQueue,
} from '@mc/shared';

/**
 * The Telegram Worker's `QueuePort` wiring (F3.1).
 *
 * All three definitions come from `@mc/shared`, and that is not tidiness: the Backend
 * provisions `events` and `notification.deliver` too, pg-boss's `updateQueue` converges an
 * existing definition, and two processes declaring different retry policies would let whichever
 * restarted last silently win. Declaring them once makes the disagreement unrepresentable.
 *
 * **The worker never runs migrations** (TDS 03 §7.1): `boss.start()` only verifies/creates the
 * vendored `pgboss` schema, and the app schema is the Backend's job.
 */
export const TELEGRAM_WORKER_QUEUES = Object.freeze([
  NOTIFICATION_DELIVER_QUEUE,
  NOTIFICATION_SCHEDULE_QUEUE,
  EVENTS_QUEUE,
]);

export interface CreateWorkerQueueOptions {
  readonly connectionString: string;
  readonly onError?: (error: Error) => void;
  readonly onWarning?: (warning: unknown) => void;
  /** Tests drop this so no case waits out a 2-second poll. */
  readonly pollingIntervalSeconds?: number;
  readonly supervise?: boolean;
  readonly schedule?: boolean;
}

export function createWorkerQueue(options: CreateWorkerQueueOptions): PgBossQueue {
  return createPgBossQueue({
    connectionString: options.connectionString,
    queues: TELEGRAM_WORKER_QUEUES,
    // One job at a time on a single-user system; pg-boss needs very few connections of its own.
    maxConnections: 3,
    ...(options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    ...(options.supervise === undefined ? {} : { supervise: options.supervise }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
}
