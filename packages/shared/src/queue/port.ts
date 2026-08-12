import type { DbTransaction } from '../db/index.js';
import type { EntityId } from '../entities/index.js';
import type { EventEnvelope } from '../events/index.js';

/**
 * F3 — the queue abstraction. PostgreSQL is the substrate in V1 (pg-boss); Redis does not
 * exist in this system. `QueuePort` is the seam that keeps that a driver decision.
 *
 * Two kinds of message travel over it, and conflating them is the mistake this file exists
 * to prevent:
 *
 *  1. **F6 domain events** — an `EventEnvelope` on the `events` queue, routed by consumers on
 *     `envelope.type` (F6.2/F6.3).
 *  2. **Jobs** — durable work requests that are explicitly *not* events and carry no F6
 *     envelope. `session.launch` is the Phase 1 example, and TDS 04 §15.2 says so in as many
 *     words: "`session.launch` is a pg-boss job name, not an event — it never appears in this
 *     catalog and carries no F6 envelope."
 *
 * Both halves require a transaction handle. The event half must (F6.3 transactional outbox);
 * the job half does not strictly have to, but giving it a second, looser API would be an
 * invitation, and every producer we have is already inside a transaction anyway.
 */

/** Job payloads are plain JSON objects — they are stored as `jsonb` by the driver. */
export type JobPayload = Record<string, unknown>;

/**
 * A durable job. `id` is a UUIDv7 (F4.2) and doubles as the at-least-once de-duplication key,
 * exactly as `EventEnvelope.id` does for events (F6.3).
 */
export interface QueueJob<TPayload extends JobPayload = JobPayload> {
  readonly id: EntityId;
  readonly payload: TPayload;
  /**
   * Earliest delivery, in seconds from now. Omitted means "as soon as a consumer is free".
   *
   * This is what makes TDS 02 §4.3's rate-limit backoff expressible: a turn that stopped on a
   * rate limit is re-enqueued *later*, with exponential backoff and jitter, while the Session
   * stays `running`. A driver without delayed delivery would force a sleeping timer inside the
   * Backend — state that does not survive a restart, which is the whole reason the job is
   * durable in the first place.
   */
  readonly startAfterSeconds?: number;
}

export interface QueuePort {
  /**
   * Enqueue an F6 domain event.
   *
   * `tx` is MANDATORY and deliberately has no fire-and-forget overload: the job row must
   * be inserted on the caller's open transaction so it commits or rolls back with the
   * domain write (F6.3, TDS 03 §7.2 failure mode 4). Making the non-transactional mistake
   * unrepresentable is the whole point of this signature.
   */
  enqueue(tx: DbTransaction, queue: string, event: EventEnvelope): Promise<void>;

  /** Enqueue a non-event job (see the file header). Same transactional rule. */
  enqueueJob<TPayload extends JobPayload>(
    tx: DbTransaction,
    queue: string,
    job: QueueJob<TPayload>,
  ): Promise<void>;
}

/** Result of handling one job. Consumers must be idempotent on `event.id` (F6.3). */
export type ConsumerHandler = (event: EventEnvelope) => Promise<void>;

/**
 * A job as delivered to a consumer. `signal` aborts when the process is shutting down or the
 * job's lease expires — a handler that waits for something (the launch consumer waits for a
 * concurrency slot, TDS 02 §4.3) must honour it or it will hold a job through shutdown.
 */
export interface DeliveredJob<TPayload extends JobPayload = JobPayload> extends QueueJob<TPayload> {
  readonly signal: AbortSignal;
}

export type JobHandler<TPayload extends JobPayload = JobPayload> = (
  job: DeliveredJob<TPayload>,
) => Promise<void>;

/** Cancels a subscription. Returned by `subscribe`, awaited during shutdown. */
export type Unsubscribe = () => Promise<void>;

export interface JobSubscriptionOptions {
  /**
   * Jobs this process handles at once. `1` (the default) means strictly one at a time, which
   * is what makes the `session.launch` queue FIFO (TDS 02 §4.3).
   */
  readonly concurrency?: number;
}

/**
 * Consumer side of the queue. Split from `QueuePort` because the Backend is mostly a
 * producer while the workers are mostly consumers (TDS 02 §2.2) — neither needs the
 * other's surface.
 */
export interface QueueConsumerPort {
  /** Start consuming F6 events from `queue`. Delivery is at-least-once (F6.3). */
  subscribe(queue: string, handler: ConsumerHandler): Promise<Unsubscribe>;
  /** Start consuming jobs from `queue`. Delivery is at-least-once (F6.3). */
  subscribeJobs<TPayload extends JobPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options?: JobSubscriptionOptions,
  ): Promise<Unsubscribe>;
  /** Stop all subscriptions and release the underlying resources. */
  stop(): Promise<void>;
}

/** Convenience for processes that both produce and consume. */
export interface Queue extends QueuePort, QueueConsumerPort {}

/** Per-queue depth, for the Settings -> Services health view (TDS 02 §7.1). */
export interface QueueDepth {
  readonly queue: string;
  /** Jobs waiting to run (excludes future-dated ones). */
  readonly ready: number;
  /** Jobs currently being handled. */
  readonly active: number;
  /** Failed jobs still retained — the dead-letter signal (TDS 03 §7.3 failure mode 6). */
  readonly failed: number;
}
