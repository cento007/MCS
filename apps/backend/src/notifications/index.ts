import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { registerNotificationRoutes } from './routes.js';
import { NotificationService } from './service.js';

/**
 * `notifications/` — the Notification read/acknowledge surface (TDS 04 §8, storage TDS 03 §4.2).
 *
 * Layout:
 *   repository.ts  every `notifications` read and write
 *   serialize.ts   DB row -> API resource, including the flat `telegram` object (WS7 N5)
 *   cursors.ts     the `(createdAt, id)` ordering key behind the opaque F5.3 cursor
 *   service.ts     the §8 contract, one method per row
 *   routes.ts      `/api/v1/notifications/*`
 *
 * **Phase boundary.** The Notification entity is Phase 2 and nothing in Phase 1 writes one —
 * creation is system-only and belongs to the Backend's threshold evaluation and to the
 * Telegram Worker (§15.2 events 29–31), neither of which exists yet. These endpoints are still
 * Phase 1 work because the Dashboard's Notifications widget and the shell's unread badge call
 * them from day one and must get an empty list rather than a 404. When the producers land,
 * they add rows; this module needs no change.
 *
 * No event is emitted here. `notification.created` / `.sent` / `.failed` belong to the
 * producers; marking one read is a UI state change with no consumer (§15.2 catalog).
 */

export * from './cursors.js';
export * from './repository.js';
export * from './routes.js';
export * from './serialize.js';
export * from './service.js';

export interface RegisterNotificationsOptions {
  readonly db: Db;
  readonly now?: () => Date;
}

export function registerNotifications(
  app: FastifyInstance,
  options: RegisterNotificationsOptions,
): NotificationService {
  const notifications = new NotificationService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  registerNotificationRoutes(app, { notifications });

  return notifications;
}
