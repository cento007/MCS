import type { EventEnvelope } from '../events/index.js';
import type {
  ConsumerHandler,
  JobHandler,
  JobPayload,
  Queue,
  QueueJob,
  Unsubscribe,
} from './port.js';

/**
 * SCAFFOLD ONLY — an in-memory `Queue` that persists nothing.
 *
 * This is NOT the F3 driver; `createPgBossQueue()` in `./pg-boss.ts` is. This implementation
 * exists so process entry points and unit tests can be wired with no database present.
 * Delivering a job through it is impossible on purpose: `enqueue` records the call and returns.
 *
 * Anything that ships to production must fail if it finds this in the object graph.
 */
export interface NoopQueue extends Queue {
  /** Events passed to `enqueue`, in order. Test/diagnostic surface only. */
  readonly enqueued: readonly { queue: string; event: EventEnvelope }[];
  /** Jobs passed to `enqueueJob`, in order. Test/diagnostic surface only. */
  readonly enqueuedJobs: readonly { queue: string; job: QueueJob }[];
  /** Queue names with a live subscription. */
  readonly subscriptions: readonly string[];
}

export function createNoopQueue(): NoopQueue {
  const enqueued: { queue: string; event: EventEnvelope }[] = [];
  const enqueuedJobs: { queue: string; job: QueueJob }[] = [];
  const handlers = new Map<string, ConsumerHandler | JobHandler<JobPayload>>();

  return {
    get enqueued() {
      return enqueued;
    },
    get enqueuedJobs() {
      return enqueuedJobs;
    },
    get subscriptions() {
      return [...handlers.keys()];
    },
    async enqueue(_tx, queue, event) {
      enqueued.push({ queue, event });
    },
    async enqueueJob(_tx, queue, job) {
      enqueuedJobs.push({ queue, job });
    },
    async subscribe(queue, handler): Promise<Unsubscribe> {
      handlers.set(queue, handler);
      return async () => {
        handlers.delete(queue);
      };
    },
    async subscribeJobs(queue, handler): Promise<Unsubscribe> {
      handlers.set(queue, handler as JobHandler<JobPayload>);
      return async () => {
        handlers.delete(queue);
      };
    },
    async stop() {
      handlers.clear();
    },
  };
}
