import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss } from 'pg-boss';
import type { DbTransaction } from '../db/index.js';
import { type EventEnvelope, isEphemeralEventType } from '../events/index.js';
import type {
  ConsumerHandler,
  JobHandler,
  JobPayload,
  JobSubscriptionOptions,
  Queue,
  QueueDepth,
  QueueJob,
  Unsubscribe,
} from './port.js';

/**
 * The F3 queue driver: pg-boss over PostgreSQL, behind `QueuePort`.
 *
 * ## The transactional outbox (F6.3, mechanism pinned by TDS 03 §7.2)
 *
 * TDS 03 §7.2 requires the job INSERT to run "on the same connection, inside the same open
 * transaction" as the domain write, and sketches it as a hand-written `db.executeSql` adapter
 * reaching into `tx.session.client`. pg-boss 12 ships that adapter as a supported export —
 * **`fromDrizzle(tx, sql)`** — so this driver uses it instead of reaching into Drizzle
 * internals. The guarantee is exactly the one §7.2 specifies; only the spelling differs, and
 * the supported spelling does not break when Drizzle reshapes its session object.
 *
 * ## De-duplication
 *
 * §7.2 also proposes `singletonKey: event.id` as "belt and braces". On pg-boss's default
 * `standard` queue policy `singletonKey` carries **no uniqueness constraint** — the unique
 * indexes exist only for the `short`/`singleton`/`stately`/`exclusive`/`key_strict_fifo`
 * policies — so on its own it would dedupe nothing. What does work is the job's own primary
 * key: `pgboss.job` is `PRIMARY KEY (name, id)` and every insert is `ON CONFLICT DO NOTHING`,
 * so passing `id: event.id` makes a repeated enqueue of the same envelope a no-op. This driver
 * therefore sets **both**: `id` for the real guarantee, `singletonKey` because §7.2 asks for it
 * and it makes the key visible to `findJobs`. Neither replaces consumer-side idempotency,
 * which stays the contract (F6.3).
 *
 * ## Schema ownership
 *
 * pg-boss creates and migrates its own `pgboss` schema through `start()`. It is vendored:
 * drizzle-kit never sees it (TDS 03 §7.1). Startup order is app migrations -> `start()` ->
 * accept work.
 */

/** pg-boss owns this schema outright (TDS 03 §7.1). */
export const DEFAULT_QUEUE_SCHEMA = 'pgboss';

export interface QueueDefinition {
  readonly name: string;
  /** Retries before the job is parked/dead-lettered (TDS 03 §7.3 failure mode 6). */
  readonly retryLimit?: number;
  readonly retryDelaySeconds?: number;
  readonly retryBackoff?: boolean;
  /** How long a handler may hold the job before it is considered lost. */
  readonly expireInSeconds?: number;
  readonly deadLetter?: string;
}

export interface PgBossQueueOptions {
  readonly connectionString: string;
  /** Defaults to `pgboss`. Only tests have a reason to change it. */
  readonly schema?: string;
  /** pg-boss owns its own small pool; the app pool is not shared with it. */
  readonly maxConnections?: number;
  /**
   * Queues to provision on `start()`. pg-boss 10+ refuses to send to a queue that does not
   * exist, so this is not optional bookkeeping.
   */
  readonly queues?: readonly QueueDefinition[];
  /** Polling floor. Polling is the delivery guarantee; NOTIFY only shortens latency (§7.2). */
  readonly pollingIntervalSeconds?: number;
  /** LISTEN/NOTIFY wake-ups (F3.2). Costs one dedicated connection. */
  readonly useListenNotify?: boolean;
  /** Background maintenance/cron. Tests turn these off to keep runs quiet. */
  readonly supervise?: boolean;
  readonly schedule?: boolean;
  readonly onError?: (error: Error) => void;
  readonly onWarning?: (warning: unknown) => void;
}

export interface PgBossQueue extends Queue {
  /** Runs pg-boss's own migrations and provisions `options.queues`. Idempotent. */
  start(): Promise<void>;
  /** Depth per configured queue, for the Services health view (TDS 02 §7.1). */
  depth(): Promise<QueueDepth[]>;
}

const DEFAULT_POLLING_INTERVAL_SECONDS = 2;

/**
 * Polling settings for every worker this driver starts.
 *
 * **`notifyPollingIntervalSeconds` is pinned to the same value as `pollingIntervalSeconds`,
 * and that is not a tuning choice.** pg-boss relaxes a notify-enabled queue's poll to 30 s on
 * the reasoning that NOTIFY will wake the worker the moment a job appears. That reasoning
 * holds only when "a job appeared" is the whole trigger — and for `session.launch` it is not:
 * the job is inserted while the slot pool is full, and what the consumer is actually waiting
 * for is a **concurrency slot to free**, which no NOTIFY announces. Left at the default, a
 * queued launch could sit up to 30 s after capacity appeared. Polling stays the delivery
 * guarantee (TDS 03 §7.2); NOTIFY only shortens the insert-to-fetch latency on top of it.
 */
function pollingOptions(pollingIntervalSeconds: number): {
  pollingIntervalSeconds: number;
  notifyPollingIntervalSeconds: number;
} {
  return {
    pollingIntervalSeconds,
    notifyPollingIntervalSeconds: pollingIntervalSeconds,
  };
}

export function createPgBossQueue(options: PgBossQueueOptions): PgBossQueue {
  const schema = options.schema ?? DEFAULT_QUEUE_SCHEMA;
  const queues = options.queues ?? [];
  const pollingIntervalSeconds = options.pollingIntervalSeconds ?? DEFAULT_POLLING_INTERVAL_SECONDS;

  let boss: PgBoss | null = null;
  const workerIds = new Map<string, string>();

  const started = (): PgBoss => {
    if (boss === null) {
      throw new Error('Queue is not started — call start() before enqueueing or subscribing');
    }
    return boss;
  };

  /**
   * The one place the outbox guarantee lives: pg-boss's INSERT is routed through the caller's
   * Drizzle transaction, so it commits or rolls back with the domain write.
   */
  const onTransaction = (tx: DbTransaction) => fromDrizzle(tx, sql);

  return {
    async start(): Promise<void> {
      if (boss !== null) return;

      const instance = new PgBoss({
        connectionString: options.connectionString,
        schema,
        ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
        useListenNotify: options.useListenNotify ?? true,
        supervise: options.supervise ?? true,
        schedule: options.schedule ?? true,
      });

      // pg-boss is an EventEmitter: an unhandled 'error' is fatal to the process in Node.
      instance.on('error', (error) => options.onError?.(error as Error));
      instance.on('warning', (warning) => options.onWarning?.(warning));

      await instance.start();

      for (const queue of queues) {
        const definition = {
          ...(queue.retryLimit === undefined ? {} : { retryLimit: queue.retryLimit }),
          ...(queue.retryDelaySeconds === undefined ? {} : { retryDelay: queue.retryDelaySeconds }),
          ...(queue.retryBackoff === undefined ? {} : { retryBackoff: queue.retryBackoff }),
          ...(queue.expireInSeconds === undefined
            ? {}
            : { expireInSeconds: queue.expireInSeconds }),
          ...(queue.deadLetter === undefined ? {} : { deadLetter: queue.deadLetter }),
          notify: options.useListenNotify ?? true,
        };
        // `createQueue` is ON CONFLICT DO NOTHING, so it will not update an existing row;
        // `updateQueue` is what makes a changed definition converge on restart.
        await instance.createQueue(queue.name, definition);
        await instance.updateQueue(queue.name, definition);
      }

      boss = instance;
    },

    async enqueue(tx: DbTransaction, queue: string, event: EventEnvelope): Promise<void> {
      if (isEphemeralEventType(event.type)) {
        // TDS 04 §14.5/§15.2: delta events are WebSocket-only, never enqueued, never persisted.
        throw new Error(`Event type ${event.type} is ephemeral and must not be enqueued`);
      }

      await started().send(queue, event, {
        id: event.id,
        singletonKey: event.id,
        db: onTransaction(tx),
      });
    },

    async enqueueJob<TPayload extends JobPayload>(
      tx: DbTransaction,
      queue: string,
      job: QueueJob<TPayload>,
    ): Promise<void> {
      await started().send(queue, job.payload, {
        id: job.id,
        singletonKey: job.id,
        // Delayed delivery is pg-boss's own `startAfter` (TDS 02 §4.3 rate-limit backoff).
        ...(job.startAfterSeconds === undefined ? {} : { startAfter: job.startAfterSeconds }),
        db: onTransaction(tx),
      });
    },

    async subscribe(queue: string, handler: ConsumerHandler): Promise<Unsubscribe> {
      const instance = started();
      const workerId = await instance.work<EventEnvelope>(
        queue,
        { batchSize: 1, localConcurrency: 1, ...pollingOptions(pollingIntervalSeconds) },
        async (jobs) => {
          for (const job of jobs) await handler(job.data);
        },
      );

      workerIds.set(queue, workerId);
      return async () => {
        workerIds.delete(queue);
        await instance.offWork(queue, { id: workerId });
      };
    },

    async subscribeJobs<TPayload extends JobPayload>(
      queue: string,
      handler: JobHandler<TPayload>,
      subscription: JobSubscriptionOptions = {},
    ): Promise<Unsubscribe> {
      const instance = started();
      const workerId = await instance.work<TPayload>(
        queue,
        {
          batchSize: 1,
          localConcurrency: subscription.concurrency ?? 1,
          ...pollingOptions(pollingIntervalSeconds),
        },
        async (jobs) => {
          for (const job of jobs) {
            await handler({ id: job.id, payload: job.data, signal: job.signal });
          }
        },
      );

      workerIds.set(queue, workerId);
      return async () => {
        workerIds.delete(queue);
        await instance.offWork(queue, { id: workerId });
      };
    },

    async depth(): Promise<QueueDepth[]> {
      const results = await started().getQueues(queues.map((queue) => queue.name));
      return results.map((queue) => ({
        queue: queue.name,
        ready: queue.readyCount,
        active: queue.activeCount,
        failed: queue.failedCount,
      }));
    },

    async stop(): Promise<void> {
      const instance = boss;
      if (instance === null) return;
      boss = null;
      workerIds.clear();
      await instance.stop({ graceful: true, close: true });
    },
  };
}
