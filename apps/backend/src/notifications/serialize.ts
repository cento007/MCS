import type { NotificationSeverity, NotificationType, TelegramDeliveryStatus } from '@mc/shared';
import type { NotificationRow } from './repository.js';

/**
 * DB row -> API resource (TDS 04 §8), using TDS 03 §4.2 as the storage authority.
 *
 * The delivery representation is the flat `telegram` object, mirroring
 * `telegram_status` / `telegram_sent_at` / `telegram_error` one-to-one (WS7 N5). A future
 * second channel is an additive sibling object (e.g. `email: {…}`), not a re-abstraction.
 */

export interface NotificationResource {
  readonly id: string;
  /** The notification-type enum — never an F6 event name (A8). */
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  /** Pre-rendered text; Telegram and the UI share it. */
  readonly body: string;
  /** Entity IDs for deep links; `payload.eventType` carries the originating F6 event. */
  readonly payload: Record<string, unknown> | null;
  readonly correlationId: string | null;
  /** The in-app "delivery" state. `null` = unread. */
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly telegram: {
    readonly status: TelegramDeliveryStatus;
    readonly sentAt: string | null;
    readonly error: string | null;
  };
}

export function serializeNotification(row: NotificationRow): NotificationResource {
  return {
    id: row.id,
    type: row.type as NotificationType,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    body: row.body,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    correlationId: row.correlationId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    telegram: {
      status: row.telegramStatus as TelegramDeliveryStatus,
      sentAt: row.telegramSentAt?.toISOString() ?? null,
      error: row.telegramError,
    },
  };
}
