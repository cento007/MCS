import { createPgBossQueue, type PgBossQueue, QUEUE_NAMES } from '@mc/shared';

/**
 * `queue/` — the Backend's QueuePort wiring (TDS 02 §2).
 *
 * Startup order is fixed and not negotiable (TDS 03 §7.1): drizzle migrations first, then
 * `boss.start()` (pg-boss migrates its own vendored `pgboss` schema), then the service accepts
 * work. The Backend is the sole app-migration runner; workers only call `start()`/`work()`.
 *
 * The `session.launch` consumer itself lives with the thing that owns concurrency —
 * `sessions/manager.ts` (TDS 02 §2 names it in both places; the registry is where the
 * semaphore is, so that is where the consumer belongs).
 */

/**
 * Queue definitions for the Backend.
 *
 * `events` — every F6 domain event (F6.3). Retries with exponential backoff, because a
 * consumer failure is nearly always transient and the alternative is losing a notification.
 *
 * `session.launch` — durable launch requests (TDS 02 §4.3). `expireInSeconds` is generous on
 * purpose: the consumer's handler *waits* for a concurrency slot, and a lease shorter than a
 * plausible wait would keep re-delivering a launch that is patiently queued. Beyond that
 * window the job is redelivered, which is the correct outcome for a genuinely stuck launch.
 */
export const BACKEND_QUEUES = Object.freeze([
  Object.freeze({
    name: QUEUE_NAMES.EVENTS,
    retryLimit: 5,
    retryDelaySeconds: 2,
    retryBackoff: true,
  }),
  Object.freeze({
    name: QUEUE_NAMES.SESSION_LAUNCH,
    retryLimit: 3,
    retryDelaySeconds: 5,
    retryBackoff: true,
    expireInSeconds: 3600,
  }),
  /**
   * `session.prompt.retry` — rate-limited turns (TDS 02 §4.3). The **delay** is on the job
   * (`startAfterSeconds`), computed per attempt with jitter by the scheduler, because the wait
   * is a property of that turn's backoff and not of the queue. pg-boss's own retry policy stays
   * short here and covers a different failure: the retry handler itself erroring.
   */
  Object.freeze({
    name: QUEUE_NAMES.SESSION_PROMPT_RETRY,
    retryLimit: 2,
    retryDelaySeconds: 5,
    retryBackoff: true,
    expireInSeconds: 600,
  }),
]);

export interface CreateBackendQueueOptions {
  readonly connectionString: string;
  readonly onError?: (error: Error) => void;
  readonly onWarning?: (warning: unknown) => void;
  /** Tests drop this to keep the launch queue responsive without waiting out a poll. */
  readonly pollingIntervalSeconds?: number;
  readonly supervise?: boolean;
  readonly schedule?: boolean;
}

export function createBackendQueue(options: CreateBackendQueueOptions): PgBossQueue {
  return createPgBossQueue({
    connectionString: options.connectionString,
    queues: BACKEND_QUEUES,
    // Single-node, single-operator: pg-boss needs very few connections of its own.
    maxConnections: 4,
    ...(options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    ...(options.supervise === undefined ? {} : { supervise: options.supervise }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
}
