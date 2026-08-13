import {
  ADR_GENERATE_QUEUE,
  createPgBossQueue,
  EVENTS_QUEUE,
  OBSIDIAN_SYNC_QUEUE,
  type PgBossQueue,
  QUEUE_NAMES,
  type QueueDefinition,
} from '@mc/shared';

/**
 * The Sync Worker's `QueuePort` wiring (F3.1).
 *
 * `obsidian.sync` and `adr.generate` come from `@mc/shared` because the Backend provisions
 * them too (it is the producer), and pg-boss's `updateQueue` converges an existing definition —
 * two processes declaring different retry policies would let whichever restarted last silently
 * win. `obsidian.schedule` is this process's alone, so it is declared here.
 *
 * ## The queue this worker deliberately does **not** subscribe to: `events`
 *
 * TDS 04 §15.2 lists the Sync Worker as a consumer of `setting.updated`, `adr.created` and
 * `adr.updated` on the shared `events` queue. It does not subscribe, and that is not an
 * omission:
 *
 *  - **pg-boss is a competing-consumer substrate.** One job goes to exactly one subscriber.
 *    The Telegram Worker already subscribes to `events` (it is that queue's drain), so a second
 *    subscriber here would mean the two workers silently steal each other's envelopes — half
 *    the notifications lost, half the syncs never triggered. The catalog's consumer column
 *    describes a fan-out the chosen substrate does not provide, and inventing one (a relay, or
 *    per-consumer queues) is a foundation change, not a workstream decision. **Recorded as a
 *    contract problem rather than worked around silently.**
 *  - **Nothing is lost by not subscribing.** `adr.created`/`adr.updated` existed to trigger a
 *    re-export; a sync run recomputes what belongs in the vault from the database every time it
 *    runs, so an edited ADR is exported by the next run — scheduled or manual — with no event
 *    involved. `setting.updated` existed to refresh cached config; this worker reads settings
 *    at the start of every run and every scheduler tick instead of caching them, so a settings
 *    change takes effect within one tick with nothing to invalidate.
 */

/**
 * `obsidian.schedule` — the interval tick.
 *
 * `retryLimit: 0`, exactly as `github.poll` and `notification.schedule`: the tick enqueues its
 * own successor before it returns, so a pg-boss retry would create a *second* chain running
 * beside the first — two chains meaning two syncs racing for the vault. A dropped tick costs at
 * most one minute.
 */
export const OBSIDIAN_SCHEDULE_QUEUE: QueueDefinition = Object.freeze({
  name: QUEUE_NAMES.OBSIDIAN_SCHEDULE,
  retryLimit: 0,
  expireInSeconds: 120,
});

export const SYNC_WORKER_QUEUES = Object.freeze([
  OBSIDIAN_SYNC_QUEUE,
  OBSIDIAN_SCHEDULE_QUEUE,
  ADR_GENERATE_QUEUE,
  /**
   * `events` — **provisioned, not subscribed to.** The distinction is the whole point.
   *
   * This worker *produces* F6 events (`sync.started`, `sync.completed`, `sync.failed`,
   * `sync.conflict_detected`, `adr.created`), and pg-boss 10+ refuses to `send` to a queue that
   * does not exist. Provisioning is `createQueue`; the competing-consumer hazard is `work()`,
   * which this worker never calls on `events`.
   *
   * Found by a test rather than reasoned about: without this row, every event the worker
   * emitted failed with "Queue events does not exist" — which in production would mean a fresh
   * install whose Sync Worker happened to start before the Backend could not complete a single
   * sync. The definition is the shared one, so the two processes cannot disagree about its
   * retry policy.
   */
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
    queues: SYNC_WORKER_QUEUES,
    // One sync at a time on a single-user system; pg-boss needs very few connections of its own.
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
