import {
  createEvent,
  type Db,
  type DbTransaction,
  type EntityId,
  type EventEnvelope,
  type EventPayload,
  type EventSource,
  type EventType,
  isEphemeralEventType,
  QUEUE_NAMES,
  type QueuePort,
} from '@mc/shared';
import { createEventBus, type EventBus } from './bus.js';

/**
 * The transactional outbox helper (F6.3; mechanism pinned by TDS 03 §7.2).
 *
 * One rule, and the whole module exists to make it unavoidable: **the domain write and its F6
 * event enqueue happen in the same PostgreSQL transaction.** `emit()` inserts the pg-boss job
 * row on the caller's transaction handle, so:
 *
 *   - commit  -> the row and the job are both durable, and a `SKIP LOCKED` fetcher can only
 *                ever see the job after the domain change is visible (no torn reads);
 *   - rollback -> neither exists. There is nothing to compensate and no relay process.
 *
 * The in-process relay to the WebSocket hub is published **after** commit, deliberately: a
 * client must never be told about a state change that then rolls back. That publish is
 * best-effort (F6.3, no replay) and cannot fail the caller.
 */

export interface OutboxOptions {
  readonly db: Db;
  readonly queue: QueuePort;
  /** Defaults to a private bus; pass the app's bus so the WS hub sees these events. */
  readonly bus?: EventBus;
  /** F6.2 `source`. `backend` here by definition (TDS 02 §2). */
  readonly source?: EventSource;
  /** Queue every F6 event travels on (F6.3). */
  readonly queueName?: string;
  /** Injectable clock so `occurredAt` is deterministic in tests. */
  readonly now?: () => Date;
  readonly onPublishError?: (error: unknown, event: EventEnvelope) => void;
}

/**
 * A transaction with an outbox attached. Handed to the callback of `Outbox.run`; every domain
 * write in that callback must use `ctx.tx`, and every event it produces must go through
 * `ctx.emit`.
 */
export interface OutboxTransaction {
  readonly tx: DbTransaction;
  /** Enqueue an F6 event on this transaction. Ephemeral types are rejected (TDS 04 §15.2). */
  emit(event: EventEnvelope): Promise<void>;
  /** Events staged so far, in emit order. Published to the in-process bus after commit. */
  readonly emitted: readonly EventEnvelope[];
}

export interface EmitOptions {
  readonly correlationId?: EntityId | null;
  readonly occurredAt?: Date;
  readonly id?: EntityId;
}

export class Outbox {
  readonly #db: Db;
  readonly #queue: QueuePort;
  readonly #bus: EventBus;
  readonly #source: EventSource;
  readonly #queueName: string;
  readonly #now: () => Date;
  readonly #onPublishError: ((error: unknown, event: EventEnvelope) => void) | undefined;

  constructor(options: OutboxOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#bus = options.bus ?? createEventBus();
    this.#source = options.source ?? 'backend';
    this.#queueName = options.queueName ?? QUEUE_NAMES.EVENTS;
    this.#now = options.now ?? (() => new Date());
    this.#onPublishError = options.onPublishError;
  }

  get bus(): EventBus {
    return this.#bus;
  }

  /** Build an F6.2 envelope with this process's `source` and clock. */
  event<TPayload extends EventPayload>(
    type: EventType,
    payload: TPayload,
    options: EmitOptions = {},
  ): EventEnvelope<TPayload> {
    return createEvent(type, this.#source, payload, {
      occurredAt: options.occurredAt ?? this.#now(),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...(options.id === undefined ? {} : { id: options.id }),
    });
  }

  /**
   * Run `work` inside one transaction, enqueueing every emitted event on it, then publish
   * those events in-process once the transaction has committed.
   */
  async run<T>(work: (ctx: OutboxTransaction) => Promise<T>): Promise<T> {
    const emitted: EventEnvelope[] = [];

    const result = await this.#db.transaction(async (tx) => {
      return work(this.#context(tx, emitted));
    });

    this.#publish(emitted);
    return result;
  }

  /**
   * Reuse an open outbox transaction when there is one, otherwise start one.
   *
   * This is what lets the state machine be called both directly by an API handler and from
   * inside a larger transaction (the launch consumer, observed ingest) without either caller
   * having to know which case it is in — and without ever opening a nested transaction that
   * could commit independently.
   */
  async join<T>(
    existing: OutboxTransaction | undefined,
    work: (ctx: OutboxTransaction) => Promise<T>,
  ): Promise<T> {
    if (existing !== undefined) return work(existing);
    return this.run(work);
  }

  #context(tx: DbTransaction, emitted: EventEnvelope[]): OutboxTransaction {
    const queue = this.#queue;
    const queueName = this.#queueName;

    return {
      tx,
      get emitted() {
        return emitted;
      },
      async emit(event) {
        if (isEphemeralEventType(event.type)) {
          // TDS 04 §15.2 row 10: WebSocket-only, never enqueued, never persisted. Enforced
          // here as well as in the driver so the rule survives a driver swap (F3).
          throw new Error(`Event type ${event.type} is ephemeral and must not be enqueued`);
        }
        await queue.enqueue(tx, queueName, event);
        emitted.push(event);
      },
    };
  }

  #publish(events: readonly EventEnvelope[]): void {
    for (const event of events) {
      try {
        this.#bus.publish(event);
      } catch (error) {
        /* c8 ignore next 2 — the bus already swallows listener errors; this is belt and braces */
        this.#onPublishError?.(error, event);
      }
    }
  }
}
