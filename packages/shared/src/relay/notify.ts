import { sql } from 'drizzle-orm';
import type { DbTransaction } from '../db/index.js';
import { type EventEnvelope, isEphemeralEventType } from '../events/index.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueuePort } from '../queue/port.js';
import {
  EVENT_RELAY_CHANNEL,
  encodeRelayEvent,
  NOTIFY_MAX_PAYLOAD_BYTES,
  type RelayEncodeResult,
} from './codec.js';

/**
 * The producer half of the worker -> Backend event relay (TDS 04 §15.1).
 *
 * ## `pg_notify` goes INSIDE the caller's transaction, and that is the whole design
 *
 * PostgreSQL queues notifications raised inside a transaction and delivers them **at commit**;
 * a rollback discards them. Putting the notify on the same handle as the domain write and the
 * pg-boss job therefore buys the same guarantee the transactional outbox already gives (F6.3):
 *
 *   - commit   -> the row is durable, the durable job exists, and the hint went out;
 *   - rollback -> none of the three happened, and no browser was told about a state change
 *                 that never occurred.
 *
 * It also makes the worker's emit path structurally identical to the Backend's: `Outbox.run`
 * publishes to the in-process bus after commit, and this publishes to PostgreSQL's notification
 * list at commit. Neither can announce an uncommitted fact.
 *
 * ## What can and cannot fail the caller
 *
 * The relay is best-effort by contract, so it must never be able to abort a domain transaction.
 * The one way `NOTIFY` can fail on a well-formed call is an oversized payload (SQLSTATE 22023),
 * and an error raised inside the transaction poisons it — so the size is checked in this process
 * and an oversized envelope is refused **before any SQL is issued**. The domain write and the
 * durable job still commit; only the best-effort hint is dropped, and the caller is told through
 * `onUndeliverable` so it can count and log it.
 *
 * The one thing that *does* throw is an attempt to relay an ephemeral event, because that is a
 * programming error rather than a runtime condition — same rule, same spelling, as
 * `Outbox.emit` and the pg-boss driver's `enqueue`.
 */

export type RelayNotifyOutcome =
  | { readonly delivered: true; readonly bytes: number }
  | { readonly delivered: false; readonly reason: 'oversized'; readonly bytes: number };

export interface UndeliverableEvent {
  readonly reason: 'oversized';
  readonly event: EventEnvelope;
  readonly bytes: number;
  readonly limit: number;
}

export interface NotifyEventOptions {
  /** Override only in tests; production always uses `EVENT_RELAY_CHANNEL`. */
  readonly channel?: string;
  /**
   * Called when the envelope could not be carried. Not an error path — the durable copy is
   * unaffected — but it must be visible, so every caller wires it to a log line and a counter.
   */
  readonly onUndeliverable?: (info: UndeliverableEvent) => void;
}

/**
 * Publish one F6 envelope to every Backend listening on `EVENT_RELAY_CHANNEL`, on the caller's
 * open transaction.
 */
export async function notifyEvent(
  tx: DbTransaction,
  event: EventEnvelope,
  options: NotifyEventOptions = {},
): Promise<RelayNotifyOutcome> {
  if (isEphemeralEventType(event.type)) {
    throw new Error(
      `Event type ${event.type} is ephemeral and must not be relayed through LISTEN/NOTIFY`,
    );
  }

  const encoded: RelayEncodeResult = encodeRelayEvent(event);
  if (!encoded.ok) {
    options.onUndeliverable?.({
      reason: 'oversized',
      event,
      bytes: encoded.bytes,
      limit: NOTIFY_MAX_PAYLOAD_BYTES,
    });
    return { delivered: false, reason: 'oversized', bytes: encoded.bytes };
  }

  // `pg_notify(text, text)` rather than the `NOTIFY` statement: only the function form takes
  // bind parameters, and the payload is JSON that must never be spliced into SQL text.
  await tx.execute(
    sql`SELECT pg_notify(${options.channel ?? EVENT_RELAY_CHANNEL}, ${encoded.payload})`,
  );
  return { delivered: true, bytes: encoded.bytes };
}

export interface EmitWorkerEventOptions extends NotifyEventOptions {
  /** Defaults to the `events` queue (F6.3). */
  readonly queueName?: string;
}

/**
 * The **only** supported way for a worker to emit an F6 event: durable enqueue plus best-effort
 * relay, on one transaction.
 *
 * Both workers call this rather than `queue.enqueue` directly, so "a worker event reaches the
 * browser" cannot regress by someone adding a new emit site and forgetting half of it. Order is
 * deliberate — the durable job is inserted first, so if the notify were ever to fail the whole
 * transaction unwinds and neither exists.
 */
export async function emitWorkerEvent(
  tx: DbTransaction,
  queue: QueuePort,
  event: EventEnvelope,
  options: EmitWorkerEventOptions = {},
): Promise<RelayNotifyOutcome> {
  await queue.enqueue(tx, options.queueName ?? QUEUE_NAMES.EVENTS, event);
  return notifyEvent(tx, event, options);
}
