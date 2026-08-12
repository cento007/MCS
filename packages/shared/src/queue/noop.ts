import type { EventEnvelope } from '../events/index.js';
import type { ConsumerHandler, Queue, Unsubscribe } from './port.js';

/**
 * SCAFFOLD ONLY — an in-memory `Queue` that persists nothing.
 *
 * This is NOT the F3 driver. The real driver is pg-boss over PostgreSQL and is WS1's to
 * implement once WS3's schema exists (TDS 03 §7.2 pins the transactional mechanism).
 * This implementation exists so the worker process entry points can be wired, started and
 * unit-tested with no database present. Delivering a job through it is impossible on
 * purpose: `enqueue` records the call and returns.
 *
 * Anything that ships to production must fail if it finds this in the object graph.
 */
export interface NoopQueue extends Queue {
  /** Events passed to `enqueue`, in order. Test/diagnostic surface only. */
  readonly enqueued: readonly { queue: string; event: EventEnvelope }[];
  /** Queue names with a live subscription. */
  readonly subscriptions: readonly string[];
}

export function createNoopQueue(): NoopQueue {
  const enqueued: { queue: string; event: EventEnvelope }[] = [];
  const handlers = new Map<string, ConsumerHandler>();

  return {
    get enqueued() {
      return enqueued;
    },
    get subscriptions() {
      return [...handlers.keys()];
    },
    async enqueue(_tx, queue, event) {
      enqueued.push({ queue, event });
    },
    async subscribe(queue, handler): Promise<Unsubscribe> {
      handlers.set(queue, handler);
      return async () => {
        handlers.delete(queue);
      };
    },
    async stop() {
      handlers.clear();
    },
  };
}
