/**
 * F4.1 — Notification vocabulary (TDS 04 §8, storage TDS 03 §4.2).
 *
 * **`type` is the notification-type enum, NOT an F6 event name** (arbitration A8 / finding
 * B10): `daily_report` (a scheduled job) and `cost_budget_alert` (a threshold evaluation) have
 * no originating event. Where one exists, its F6 type rides in `payload.eventType`.
 *
 * The Telegram delivery state is flat and mirrors the columns one-to-one (`telegram_status`,
 * `telegram_sent_at`, `telegram_error`) — the earlier `deliveries[]` array was removed by
 * WS7 N5 because V1 has exactly one outbound channel and the `ui` entry in it was synthetic:
 * the Notification row *is* the in-app notification and `readAt` is its only UI state.
 */

export const NOTIFICATION_TYPES = [
  'session_completed',
  'session_failed',
  'sync_failed',
  'repository_problem',
  'daily_report',
  'cost_budget_alert',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'error'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** `skipped` = Telegram is disabled or this event type is toggled off (PRD §4.4.3). */
export const TELEGRAM_DELIVERY_STATUSES = ['skipped', 'pending', 'sent', 'failed'] as const;
export type TelegramDeliveryStatus = (typeof TELEGRAM_DELIVERY_STATUSES)[number];
