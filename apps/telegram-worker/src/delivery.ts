import {
  createEvent,
  type Db,
  type DbTransaction,
  deliveryBackoffSeconds,
  type EventType,
  emitWorkerEvent,
  enqueueNotificationDispatch,
  MAX_DELIVERY_ATTEMPTS,
  type NotificationDispatchJob,
  type Queue,
  schema,
  telegramSkipMessage,
  type UndeliverableEvent,
} from '@mc/shared';
import { and, asc, eq, lte } from 'drizzle-orm';
import { type BotTokenRead, createBotTokenReader, readTelegramSettings } from './settings.js';
import type { SendOutcome, TelegramClient } from './telegram/client.js';
import { formatNotificationMessage } from './telegram/format.js';

/**
 * Telegram delivery — the `notification.deliver` consumer (TDS 02 §2.2, TDS 03 §4.2).
 *
 * ## Idempotence: the Notification row is the anchor
 *
 * pg-boss is at-least-once (F6.3), so this handler *will* be asked to deliver the same
 * Notification twice. The dedupe key is not the job id and not an in-memory set — it is
 * `notifications.telegram_status`:
 *
 *   - only a `pending` row is deliverable; the handler reads the row first and returns
 *     `already_settled` for anything else;
 *   - a successful send writes `sent` under `WHERE telegram_status = 'pending'`, so the
 *     transition happens at most once even if two writers race;
 *   - the first dispatch job's id **is** the notification id (`writeNotification`), so a
 *     producer that runs twice cannot create two deliveries in the first place.
 *
 * A crash in the microseconds between Telegram accepting the message and this process
 * committing `sent` is the one window that can double-send. It cannot be closed from here —
 * `sendMessage` has no idempotency key — so it is narrowed instead: the HTTP call is bounded at
 * 10 s while the job lease is 120 s, so a lease can never expire mid-send, and the status write
 * is the very next statement.
 *
 * ## Failure is data
 *
 * Nothing in the delivery path throws for a Telegram condition. A bad token, a chat that does
 * not exist, a network timeout and a `429` each end as a `telegram_error` sentence an operator
 * can act on. The handler throws for exactly two things: an infrastructure failure (the
 * database went away — pg-boss's retry budget covers it) and shutdown (below).
 *
 * ## Shutdown
 *
 * `offWork` waits for the in-flight handler, so a handler parked on something that never
 * completes blocks `SIGTERM` forever — the failure the session registry already hit once. Two
 * guards: the HTTP call is bounded, and it carries the worker's shutdown signal, so `stop()`
 * unblocks it immediately. An aborted send **throws** rather than returning: returning would
 * let pg-boss complete a job whose Notification is still `pending`, stranding it. Throwing puts
 * the job back for the next process to pick up, which is the honest outcome for work that did
 * not finish.
 */

/** Thrown when a send is cut short by shutdown, so pg-boss re-queues rather than completes. */
export class DeliveryAbortedError extends Error {
  constructor(notificationId: string) {
    super(`Telegram delivery of ${notificationId} was interrupted by shutdown; it will retry`);
    this.name = 'DeliveryAbortedError';
  }
}

export type DeliveryResult =
  | { readonly kind: 'sent'; readonly notificationId: string }
  | { readonly kind: 'skipped'; readonly notificationId: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly notificationId: string; readonly reason: string }
  | {
      readonly kind: 'retry_scheduled';
      readonly notificationId: string;
      readonly attempt: number;
      readonly delaySeconds: number;
      readonly reason: string;
    }
  | { readonly kind: 'already_settled'; readonly notificationId: string; readonly status: string }
  | { readonly kind: 'missing'; readonly notificationId: string };

export interface DeliveryServiceOptions {
  readonly db: Db;
  readonly queue: Queue;
  readonly client: TelegramClient;
  /** Base64 `MC_ENCRYPTION_KEY` — the KEK the bot token was sealed with (F8.2). */
  readonly encryptionKey: string;
  readonly now?: () => Date;
  /** Aborted on shutdown; passed into every outbound request. */
  readonly signal?: AbortSignal;
  readonly onError?: (error: unknown, context: string) => void;
  /** The best-effort relay could not carry an envelope (TDS 04 §15.1). Logged, never fatal. */
  readonly onUndeliverable?: (info: UndeliverableEvent) => void;
}

export class DeliveryService {
  readonly #db: Db;
  readonly #queue: Queue;
  readonly #client: TelegramClient;
  readonly #readBotToken: (db: Db) => Promise<BotTokenRead>;
  readonly #now: () => Date;
  readonly #signal: AbortSignal | undefined;
  readonly #onUndeliverable: ((info: UndeliverableEvent) => void) | undefined;

  constructor(options: DeliveryServiceOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#client = options.client;
    this.#readBotToken = createBotTokenReader({ encryptionKey: options.encryptionKey });
    this.#now = options.now ?? (() => new Date());
    this.#signal = options.signal;
    this.#onUndeliverable = options.onUndeliverable;
  }

  /**
   * Deliver one Notification.
   *
   * `job.signal` is pg-boss's own per-job signal (lease expiry / stop); it is combined with the
   * worker's shutdown signal so either can unblock an in-flight request.
   */
  async deliver(job: NotificationDispatchJob, jobSignal?: AbortSignal): Promise<DeliveryResult> {
    const { notificationId } = job;
    const attempt = Math.max(1, Math.floor(job.attempt));

    const row = await this.#read(notificationId);
    if (row === null) return { kind: 'missing', notificationId };

    // The idempotence gate. A redelivered job for a Notification that already went out finds
    // `sent` here and does nothing — no second message, no second row write.
    if (row.telegramStatus !== 'pending') {
      return { kind: 'already_settled', notificationId, status: row.telegramStatus };
    }

    const settings = await readTelegramSettings(this.#db);
    if (!settings.enabled) {
      return this.#skip(notificationId, telegramSkipMessage('telegram_disabled'));
    }
    if (!settings.chatIdIsSet || settings.chatId === null) {
      return this.#skip(notificationId, telegramSkipMessage('chat_id_missing'));
    }

    const token = await this.#readBotToken(this.#db);
    if (token.kind === 'not_configured') {
      // A terminal, stated `skipped` — NOT a retry. Waiting does not conjure a bot token, and a
      // job that keeps coming back for one is a queue that never drains.
      return this.#skip(notificationId, telegramSkipMessage('bot_token_missing'));
    }
    if (token.kind === 'unreadable') {
      return this.#fail(notificationId, token.message);
    }

    const outcome = await this.#client.sendMessage({
      botToken: token.token,
      chatId: settings.chatId,
      text: formatNotificationMessage({ title: row.title, body: row.body }),
      signal: combineSignals(this.#signal, jobSignal),
    });

    return this.#record(notificationId, attempt, outcome);
  }

  async #record(
    notificationId: string,
    attempt: number,
    outcome: SendOutcome,
  ): Promise<DeliveryResult> {
    switch (outcome.kind) {
      case 'sent':
        return this.#succeed(notificationId);

      case 'aborted':
        // Not recorded on the row: nothing is known about whether it arrived, and inventing a
        // status would be a guess written into an operator-facing ledger.
        throw new DeliveryAbortedError(notificationId);

      case 'terminal':
        return this.#fail(notificationId, outcome.message);

      case 'rate_limited':
        return this.#retryOrFail(
          notificationId,
          attempt,
          outcome.message,
          outcome.retryAfterSeconds,
        );

      case 'retriable':
        return this.#retryOrFail(notificationId, attempt, outcome.message, null);
    }
  }

  /**
   * `sent` + `notification.sent` (§15.2 row 30), in one transaction.
   *
   * The `WHERE telegram_status = 'pending'` guard is what makes the transition at-most-once:
   * a second writer that somehow got this far updates zero rows and emits nothing.
   */
  async #succeed(notificationId: string): Promise<DeliveryResult> {
    const now = this.#now();

    await this.#db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.notifications)
        .set({ telegramStatus: 'sent', telegramSentAt: now, telegramError: null, updatedAt: now })
        .where(
          and(
            eq(schema.notifications.id, notificationId),
            eq(schema.notifications.telegramStatus, 'pending'),
          ),
        )
        .returning({ id: schema.notifications.id });

      if (updated.length === 0) return;
      await this.#emit(tx, 'notification.sent', { notificationId, channel: 'telegram' }, now);
    });

    return { kind: 'sent', notificationId };
  }

  /** Terminal `failed` + `notification.failed` (§15.2 row 31). */
  async #fail(notificationId: string, reason: string): Promise<DeliveryResult> {
    const now = this.#now();

    await this.#db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.notifications)
        .set({ telegramStatus: 'failed', telegramError: reason, updatedAt: now })
        .where(
          and(
            eq(schema.notifications.id, notificationId),
            eq(schema.notifications.telegramStatus, 'pending'),
          ),
        )
        .returning({ id: schema.notifications.id });

      if (updated.length === 0) return;
      await this.#emit(
        tx,
        'notification.failed',
        { notificationId, channel: 'telegram', reason },
        now,
      );
    });

    return { kind: 'failed', notificationId, reason };
  }

  /**
   * Terminal `skipped` with a stated reason.
   *
   * No `notification.failed`: nothing failed. The operator turned the channel off, or never
   * finished configuring it, and §8 says that is what `skipped` means.
   */
  async #skip(notificationId: string, reason: string): Promise<DeliveryResult> {
    const now = this.#now();

    await this.#db
      .update(schema.notifications)
      .set({ telegramStatus: 'skipped', telegramError: reason, updatedAt: now })
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.telegramStatus, 'pending'),
        ),
      );

    return { kind: 'skipped', notificationId, reason };
  }

  /**
   * Schedule attempt `n + 1`, or give up.
   *
   * The row stays `pending` and its `telegram_error` carries the progress note, so an operator
   * watching the Notifications list sees *"Rate limited by Telegram (429) — retrying in 30 s
   * (attempt 2 of 5)"* rather than a row that silently sits there. The new job gets a fresh id:
   * re-using the notification id would collide with the original job's primary key and the
   * retry would be silently swallowed by `ON CONFLICT DO NOTHING`.
   */
  async #retryOrFail(
    notificationId: string,
    attempt: number,
    reason: string,
    retryAfterSeconds: number | null,
  ): Promise<DeliveryResult> {
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      return this.#fail(
        notificationId,
        `${reason} — gave up after ${MAX_DELIVERY_ATTEMPTS} attempts.`,
      );
    }

    const delaySeconds = deliveryBackoffSeconds(attempt, retryAfterSeconds);
    const next = attempt + 1;
    const now = this.#now();
    const note = `${reason} — retrying in ${delaySeconds}s (attempt ${next} of ${MAX_DELIVERY_ATTEMPTS}).`;

    await this.#db.transaction(async (tx) => {
      await tx
        .update(schema.notifications)
        .set({ telegramError: note, updatedAt: now })
        .where(
          and(
            eq(schema.notifications.id, notificationId),
            eq(schema.notifications.telegramStatus, 'pending'),
          ),
        );

      await enqueueNotificationDispatch(tx, this.#queue, {
        notificationId,
        attempt: next,
        startAfterSeconds: delaySeconds,
      });
    });

    return { kind: 'retry_scheduled', notificationId, attempt: next, delaySeconds, reason: note };
  }

  /**
   * Re-enqueue delivery jobs for Notifications left `pending` with nothing to deliver them.
   *
   * Called once at startup. It closes the only hole the at-least-once design leaves open: a
   * process killed mid-delivery (or during a deploy) leaves a `pending` row whose job pg-boss
   * eventually exhausts. Without the sweep that Notification waits forever; with it, the worker
   * is self-healing across restarts.
   *
   * **A quiet-hours deferral survives the sweep.** Rows carry `payload.quietHours.deferredUntil`;
   * a row still inside its window is re-enqueued with the remaining delay, not immediately —
   * otherwise every restart during the night would defeat the very setting that suppressed it.
   *
   * Bounded: oldest first, at most `limit` rows. A worker that has been down for a week should
   * not open with a thousand-message burst.
   */
  async sweepPending(limit = 100): Promise<number> {
    const now = this.#now();

    const rows = await this.#db
      .select({
        id: schema.notifications.id,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.telegramStatus, 'pending'),
          // Leave anything created in the last minute alone: its own dispatch job is almost
          // certainly still in flight, and racing it buys nothing.
          lte(schema.notifications.createdAt, new Date(now.getTime() - 60_000)),
        ),
      )
      .orderBy(asc(schema.notifications.createdAt))
      .limit(limit);

    for (const row of rows) {
      const deferredUntil = readDeferredUntil(row.payload);
      const startAfterSeconds =
        deferredUntil === null || deferredUntil <= now
          ? undefined
          : Math.ceil((deferredUntil.getTime() - now.getTime()) / 1000);

      await this.#db.transaction(async (tx) => {
        await enqueueNotificationDispatch(tx, this.#queue, {
          notificationId: row.id,
          attempt: 1,
          ...(startAfterSeconds === undefined ? {} : { startAfterSeconds }),
        });
      });
    }

    return rows.length;
  }

  async #read(id: string): Promise<{ title: string; body: string; telegramStatus: string } | null> {
    const rows = await this.#db
      .select({
        title: schema.notifications.title,
        body: schema.notifications.body,
        telegramStatus: schema.notifications.telegramStatus,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * An F6 envelope on the caller's transaction — the outbox, by construction (F6.3) — plus the
   * best-effort `LISTEN/NOTIFY` relay to the Backend's WebSocket hub (TDS 04 §15.1).
   *
   * Both halves ride the same transaction, so `notification.sent` reaches a browser only if the
   * row that says the message went out is also committed. This is the only emit path in this
   * class: `queue.enqueue` on its own would put the envelope on a durable queue whose only
   * consumer drains and discards it, which is precisely how `notification.sent` and
   * `notification.failed` came to be "emitted by the Telegram Worker and consumed by nobody".
   */
  async #emit(
    tx: DbTransaction,
    type: EventType,
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<void> {
    await emitWorkerEvent(
      tx,
      this.#queue,
      createEvent(type, 'telegram-worker', payload, { occurredAt }),
      {
        ...(this.#onUndeliverable === undefined ? {} : { onUndeliverable: this.#onUndeliverable }),
      },
    );
  }
}

/** The `deferredUntil` marker `writeNotification` left in `payload.quietHours`. */
function readDeferredUntil(payload: Record<string, unknown> | null): Date | null {
  const quietHours = payload?.['quietHours'];
  if (typeof quietHours !== 'object' || quietHours === null) return null;

  const value = (quietHours as Record<string, unknown>)['deferredUntil'];
  if (typeof value !== 'string') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One signal that aborts when either input does.
 *
 * `AbortSignal.any` exists on Node 20+, but it is used through a guard because both inputs are
 * optional and the common case in tests is neither.
 */
export function combineSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}
