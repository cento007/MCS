import {
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TYPES,
  TELEGRAM_DELIVERY_STATUSES,
} from '@mc/shared';
import {
  type Assert,
  type ExactShape,
  entityId,
  enumSchema,
  integerValue,
  nullableOpenObject,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { NotificationResource } from './serialize.js';

/** The `Notification` response shape (TDS 04 §8). */
export const notificationSchema = objectSchema('Notification', {
  id: entityId,
  /** The notification-type enum — never an F6 event name (arbitration A8). */
  type: enumSchema('NotificationType', NOTIFICATION_TYPES),
  severity: enumSchema('NotificationSeverity', NOTIFICATION_SEVERITIES),
  title: stringValue,
  /** Pre-rendered text; Telegram and the UI share it. */
  body: stringValue,
  /** Entity ids for deep links; `payload.eventType` carries the originating F6 event. */
  payload: nullableOpenObject,
  correlationId: nullableString,
  /** The in-app "delivery" state. `null` = unread. */
  readAt: nullableTimestamp,
  createdAt: timestampValue,
  telegram: objectSchema('NotificationTelegramDelivery', {
    status: enumSchema('TelegramDeliveryStatus', TELEGRAM_DELIVERY_STATUSES),
    sentAt: nullableTimestamp,
    error: nullableString,
  }),
});
export type _NotificationShape = Assert<
  ExactShape<NotificationResource, typeof notificationSchema>
>;

/** `POST /notifications/read-all` — how many rows the write actually touched. */
export const readAllResultSchema = objectSchema('NotificationsReadAll', {
  updated: integerValue,
});
