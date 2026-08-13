import {
  createEvent,
  type Db,
  type EntityId,
  type EventEnvelope,
  type EventPayload,
  type EventType,
  QUEUE_NAMES,
  type QueuePort,
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
 * lives in `apps/backend/src/events/` and a worker may not import a Backend module (F2.2). The
 * difference is real, not incidental: this one has no in-process event bus to publish to
 * afterwards — there is no WebSocket hub in this process, and worker-produced events reach the
 * browser only through the Backend, which today means not at all (see the note in `worker.ts`).
 */

export interface WorkerOutboxOptions {
  readonly db: Db;
  readonly queue: QueuePort;
  readonly now?: () => Date;
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

  constructor(options: WorkerOutboxOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date());
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

    return this.#db.transaction(async (tx) => {
      return work({
        tx,
        async emit(event) {
          await queue.enqueue(tx, QUEUE_NAMES.EVENTS, event);
        },
      });
    });
  }
}
