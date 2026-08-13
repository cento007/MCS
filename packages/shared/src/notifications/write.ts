import { type DbTransaction, schema } from '../db/index.js';
import type { NotificationPayload } from '../db/schema/notifications.js';
import type { NotificationType, TelegramDeliveryStatus } from '../entities/notification.js';
import { newId } from '../events/envelope.js';
import { createJob } from '../queue/job.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { JobPayload, QueuePort } from '../queue/port.js';
import type { NotificationDecision } from './policy.js';
import { deferralSeconds } from './quiet-hours.js';

/**
 * The one way a Notification comes into existence (TDS 03 §4.2, TDS 04 §8).
 *
 * **The row and its delivery job are written on the same transaction handle**, which is the
 * whole reason this function takes a `DbTransaction` and a `QueuePort` rather than a pool: the
 * pg-boss driver routes its INSERT through the caller's Drizzle transaction (F6.3, mechanism
 * pinned by TDS 03 §7.2), so
 *
 *   - commit   → the Notification exists **and** something is going to deliver it;
 *   - rollback → neither exists, and there is nothing to reconcile.
 *
 * The two states this makes unrepresentable are the ones that actually hurt: a Notification
 * that is `pending` forever because its job was never enqueued, and a delivery job whose
 * Notification was rolled out from under it.
 *
 * Creation is system-only (§8) — there is no API path here, and there is no repository
 * function in the Backend that would let one appear from a request body.
 */

/**
 * The `notification.deliver` payload. A *job*, not an event — no F6 envelope (TDS 04 §15.2).
 *
 * A `type` alias rather than an `interface` on purpose: only object-literal types satisfy
 * `JobPayload`'s index signature.
 */
export type NotificationDispatchJob = {
  readonly notificationId: string;
  /** 1-based delivery attempt, bounded by `MAX_DELIVERY_ATTEMPTS`. */
  readonly attempt: number;
};

/** The deferral marker written into `payload.quietHours` (see `quiet-hours.ts`). */
export type QuietHoursMarker = {
  readonly deferredUntil: string;
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
};

export interface WriteNotificationInput {
  readonly userId: string;
  readonly type: NotificationType;
  /** Pre-rendered (§8): Telegram and the UI share the same text. */
  readonly title: string;
  readonly body: string;
  /** Entity IDs for deep links plus `eventType` — never full entities (F6.1). */
  readonly payload?: NotificationPayload | null;
  /** F6.2 `correlationId` of the originating chain (finding B8). */
  readonly correlationId?: string | null;
  readonly decision: NotificationDecision;
  /** Quiet-hours provenance, merged into `payload` when the decision defers. */
  readonly quietHours?: { readonly start: string; readonly end: string; readonly timezone: string };
  /** Injectable clock; also the base for the deferral delay. */
  readonly now?: Date;
  /** Supplied by tests that need a deterministic id; otherwise a fresh UUIDv7 (F4.2). */
  readonly id?: string;
}

export interface WrittenNotification {
  readonly id: string;
  readonly telegramStatus: TelegramDeliveryStatus;
  /** `true` when a `notification.deliver` job was enqueued on the same transaction. */
  readonly dispatched: boolean;
  readonly deferUntil: Date | null;
}

export async function writeNotification(
  tx: DbTransaction,
  queue: QueuePort,
  input: WriteNotificationInput,
): Promise<WrittenNotification> {
  const id = input.id ?? newId();
  const now = input.now ?? new Date();
  const { decision } = input;

  const payload = withQuietHoursMarker(input, decision.deferUntil);

  await tx.insert(schema.notifications).values({
    id,
    userId: input.userId,
    type: input.type,
    severity: decision.severity,
    title: input.title,
    body: input.body,
    payload,
    correlationId: input.correlationId ?? null,
    telegramStatus: decision.telegramStatus,
    // A `skipped` row states *why* it was skipped. It is the only place an operator can read
    // "Telegram is switched off" without guessing from an empty delivery ledger.
    telegramError: decision.skipMessage,
    createdAt: now,
    updatedAt: now,
  });

  if (!decision.dispatch) {
    return { id, telegramStatus: decision.telegramStatus, dispatched: false, deferUntil: null };
  }

  await enqueueNotificationDispatch(tx, queue, {
    notificationId: id,
    attempt: 1,
    // The job id IS the notification id on the first enqueue: pg-boss inserts with
    // `ON CONFLICT (name, id) DO NOTHING`, so producing the same Notification twice — a
    // redelivered producer job, a restart sweep — cannot create a second delivery.
    jobId: id,
    ...(decision.deferUntil === null
      ? {}
      : { startAfterSeconds: deferralSeconds(decision.deferUntil, now) }),
  });

  return {
    id,
    telegramStatus: decision.telegramStatus,
    dispatched: true,
    deferUntil: decision.deferUntil,
  };
}

export interface EnqueueDispatchInput {
  readonly notificationId: string;
  readonly attempt: number;
  /** Defaults to a fresh UUIDv7 — retries must not collide with the first job's id. */
  readonly jobId?: string;
  readonly startAfterSeconds?: number;
}

/** Enqueue one `notification.deliver` job on an open transaction. */
export async function enqueueNotificationDispatch(
  tx: DbTransaction,
  queue: QueuePort,
  input: EnqueueDispatchInput,
): Promise<void> {
  await queue.enqueueJob<NotificationDispatchJob & JobPayload>(
    tx,
    QUEUE_NAMES.NOTIFICATION_DELIVER,
    createJob<NotificationDispatchJob & JobPayload>(
      { notificationId: input.notificationId, attempt: input.attempt },
      input.jobId ?? newId(),
      input.startAfterSeconds === undefined ? {} : { startAfterSeconds: input.startAfterSeconds },
    ),
  );
}

function withQuietHoursMarker(
  input: WriteNotificationInput,
  deferUntil: Date | null,
): NotificationPayload | null {
  const base = input.payload ?? null;
  if (deferUntil === null || input.quietHours === undefined) return base;

  const marker: QuietHoursMarker = {
    deferredUntil: deferUntil.toISOString(),
    start: input.quietHours.start,
    end: input.quietHours.end,
    timezone: input.quietHours.timezone,
  };

  return { ...(base ?? {}), quietHours: marker };
}
