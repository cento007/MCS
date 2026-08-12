import type { Db } from '@mc/shared';
import type { Principal } from '../auth/index.js';
import { ApiError } from '../http/errors.js';
import type { NotificationCursor } from './cursors.js';
import {
  findNotificationById,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './repository.js';
import { type NotificationResource, serializeNotification } from './serialize.js';

/**
 * The Notification service — TDS 04 §8, one method per contract row.
 *
 * Everything here is scoped to the calling principal's `userId`. V1 has a single local account
 * (F4.1), so this changes no behaviour today; it is written this way because `notifications`
 * carries a `user_id` FK and both of its indexes lead with it — a query that ignored the column
 * would neither use the index nor survive the day a second account exists.
 */

export interface ListNotificationsRequest {
  readonly limit: number;
  readonly unreadOnly: boolean;
  readonly after?: NotificationCursor | undefined;
}

export interface NotificationServiceOptions {
  readonly db: Db;
  readonly now?: () => Date;
}

export class NotificationService {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(options: NotificationServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
  }

  async list(
    principal: Principal,
    request: ListNotificationsRequest,
  ): Promise<readonly NotificationResource[]> {
    const rows = await listNotifications(this.#db, {
      userId: principal.userId,
      limit: request.limit,
      unreadOnly: request.unreadOnly,
      after: request.after,
    });

    return rows.map(serializeNotification);
  }

  async get(principal: Principal, id: string): Promise<NotificationResource> {
    const row = await findNotificationById(this.#db, principal.userId, id);
    if (row === null) throw notFound(id);
    return serializeNotification(row);
  }

  /**
   * `POST /notifications/{id}/read` — idempotent.
   *
   * The UPDATE only touches unread rows, so a repeat call returns the same `readAt` it
   * returned the first time instead of resetting the moment the operator saw it. An id that
   * matched nothing at all is a 404, which is why the miss is re-read rather than assumed.
   */
  async markRead(principal: Principal, id: string): Promise<NotificationResource> {
    const updated = await markNotificationRead(this.#db, principal.userId, id, this.#now());
    if (updated !== null) return serializeNotification(updated);

    const existing = await findNotificationById(this.#db, principal.userId, id);
    if (existing === null) throw notFound(id);
    return serializeNotification(existing);
  }

  /** `POST /notifications/read-all` -> `{ data: { updated: number } }`. */
  async markAllRead(principal: Principal): Promise<{ updated: number }> {
    const updated = await markAllNotificationsRead(this.#db, principal.userId, this.#now());
    return { updated };
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'Notification not found', { notificationId: id });
}
