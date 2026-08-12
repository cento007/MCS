import type { DbTransaction } from '../db/index.js';
import type { EventEnvelope } from '../events/index.js';

/**
 * F3 — the queue abstraction. PostgreSQL is the substrate in V1 (pg-boss); Redis does not
 * exist in this system. `QueuePort` is the seam that keeps that a driver decision.
 *
 * SCAFFOLD STATE: interface only, exactly as F3.1 specifies ("a thin `QueuePort` interface
 * owned by `packages/shared`"). The pg-boss driver — including the `db.executeSql` adapter
 * that routes the job INSERT through the caller's transaction (TDS 03 §7.2) — is WS1's to
 * implement once WS3's schema exists. `createNoopQueue()` in `./noop.ts` exists so process
 * entry points can be wired and tested today.
 */
export interface QueuePort {
  /**
   * Enqueue a domain event.
   *
   * `tx` is MANDATORY and deliberately has no fire-and-forget overload: the job row must
   * be inserted on the caller's open transaction so it commits or rolls back with the
   * domain write (F6.3, TDS 03 §7.2 failure mode 4). Making the non-transactional mistake
   * unrepresentable is the whole point of this signature.
   */
  enqueue(tx: DbTransaction, queue: string, event: EventEnvelope): Promise<void>;
}

/** Result of handling one job. Consumers must be idempotent on `event.id` (F6.3). */
export type ConsumerHandler = (event: EventEnvelope) => Promise<void>;

/** Cancels a subscription. Returned by `subscribe`, awaited during shutdown. */
export type Unsubscribe = () => Promise<void>;

/**
 * Consumer side of the queue. Split from `QueuePort` because the Backend is mostly a
 * producer while the workers are mostly consumers (TDS 02 §2.2) — neither needs the
 * other's surface.
 */
export interface QueueConsumerPort {
  /** Start consuming `queue`. Delivery is at-least-once (F6.3). */
  subscribe(queue: string, handler: ConsumerHandler): Promise<Unsubscribe>;
  /** Stop all subscriptions and release the underlying resources. */
  stop(): Promise<void>;
}

/** Convenience for processes that both produce and consume. */
export interface Queue extends QueuePort, QueueConsumerPort {}
