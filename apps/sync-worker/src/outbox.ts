import {
  createEvent,
  type Db,
  type EntityId,
  type EventEnvelope,
  type EventPayload,
  type EventType,
  emitWorkerEvent,
  type QueuePort,
  type UndeliverableEvent,
} from '@mc/shared';

/**
 * The transactional outbox, worker side (F6.3, mechanism pinned by TDS 03 §7.2).
 *
 * Same rule as the Backend's `events/outbox.ts`: **the domain write and its F6 event enqueue
 * happen in the same PostgreSQL transaction**, so a committed `sync.completed` can only ever
 * describe a `sync_runs` row that is also committed, and a rolled-back run leaves no event
 * claiming it finished.
 *
 * It is a second, smaller implementation rather than an import, because the Backend's version
 * lives in `apps/backend/src/events/` and a worker may not import a Backend module (F2.2).
 *
 * ## The relay half
 *
 * The Backend's outbox publishes to an in-process bus after commit; this process has no bus and
 * no WebSocket hub, so its equivalent is a `pg_notify` on the same transaction
 * (`emitWorkerEvent`, TDS 04 §15.1). PostgreSQL holds the notification until commit and
 * discards it on rollback, so the three effects — domain row, durable job, browser hint — are
 * atomic together. Every `sync.*` and `adr.created` this process produces travels that path;
 * the Backend's `events/relay.ts` is on the other end.
 *
 * The relay is best-effort by contract (F6.3, no replay) and must never fail a sync run, so an
 * envelope the transport cannot carry is reported through `onUndeliverable` and dropped — the
 * durable job on the `events` queue is unaffected.
 */

export interface WorkerOutboxOptions {
  readonly db: Db;
  readonly queue: QueuePort;
  readonly now?: () => Date;
  /** Called when the best-effort `NOTIFY` could not carry an envelope (oversized payload). */
  readonly onUndeliverable?: (info: UndeliverableEvent) => void;
}

/** A transaction with an outbox attached — the only way to emit from this process. */
export interface OutboxTransaction {
  readonly tx: Parameters<Parameters<Db['transaction']>[0]>[0];
  emit(event: EventEnvelope): Promise<void>;
}

export class WorkerOutbox {
  readonly #db: Db;
  readonly #queue: QueuePort;
  readonly #now: () => Date;
  readonly #onUndeliverable: ((info: UndeliverableEvent) => void) | undefined;

  constructor(options: WorkerOutboxOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date());
    this.#onUndeliverable = options.onUndeliverable;
  }

  /** Build an F6.2 envelope with `source: 'sync-worker'`. */
  event<TPayload extends EventPayload>(
    type: EventType,
    payload: TPayload,
    options: { readonly correlationId?: EntityId | null } = {},
  ): EventEnvelope<TPayload> {
    return createEvent(type, 'sync-worker', payload, {
      occurredAt: this.#now(),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    });
  }

  async run<T>(work: (ctx: OutboxTransaction) => Promise<T>): Promise<T> {
    const queue = this.#queue;
    const onUndeliverable = this.#onUndeliverable;

    return this.#db.transaction(async (tx) => {
      return work({
        tx,
        async emit(event) {
          // Durable enqueue + best-effort relay, one transaction. Never `queue.enqueue`
          // directly: an emit site that skipped the notify would be a worker event that
          // silently never reaches a browser, which is the exact defect this closes.
          await emitWorkerEvent(tx, queue, event, {
            ...(onUndeliverable === undefined ? {} : { onUndeliverable }),
          });
        },
      });
    });
  }
}
