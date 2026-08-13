import type { Db, QueuePort } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus, Outbox } from '../events/index.js';
import { NotificationProducer } from './produce.js';
import { registerNotificationRoutes } from './routes.js';
import { NotificationService } from './service.js';

/**
 * `notifications/` — the Notification surface (TDS 04 §8, storage TDS 03 §4.2).
 *
 * Layout:
 *   repository.ts  every `notifications` read and write from the API side
 *   serialize.ts   DB row -> API resource, including the flat `telegram` object (WS7 N5)
 *   cursors.ts     the `(createdAt, id)` ordering key behind the opaque F5.3 cursor
 *   service.ts     the §8 contract, one method per row
 *   routes.ts      `/api/v1/notifications/*`
 *   render.ts      pre-rendered `title`/`body` — Telegram and the UI share them (§8)
 *   facts.ts       the reads that turn an ID-only F6 payload into that text (F6.1)
 *   produce.ts     the producer: row + delivery job + `notification.created`, one transaction
 *
 * **Creation is system-only** (§8) and stays that way: there is no route that writes a
 * Notification and no repository function that would let one appear from a request body. The
 * producer is driven by the in-process event bus, after commit, and by the cost-budget
 * evaluation that rides `session.completed`.
 *
 * The read side emits nothing — marking one read is a UI state change with no consumer.
 * `notification.created` belongs to the producer here; `notification.sent` / `.failed` belong
 * to the Telegram Worker (§15.2 rows 29–31).
 */

export * from './cursors.js';
export * from './facts.js';
export * from './produce.js';
export * from './render.js';
export * from './repository.js';
export * from './routes.js';
export * from './serialize.js';
export * from './service.js';

export interface NotificationsModule {
  readonly service: NotificationService;
  /**
   * `undefined` when the app was built without an outbox/queue (a read-only test app). The
   * endpoints still work; nothing produces.
   */
  readonly producer: NotificationProducer | undefined;
  /** Detach the bus subscriptions. Called by `app.close()`'s teardown. */
  stop(): void;
}

export interface RegisterNotificationsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: QueuePort;
  readonly bus: EventBus;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context: string) => void;
}

export function registerNotifications(
  app: FastifyInstance,
  options: RegisterNotificationsOptions,
): NotificationsModule {
  const service = new NotificationService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  registerNotificationRoutes(app, { notifications: service });

  const producer = new NotificationProducer({
    db: options.db,
    outbox: options.outbox,
    queue: options.queue,
    ...(options.now === undefined ? {} : { now: options.now }),
    onError: (error, context) => {
      options.onError?.(error, context);
      app.log.error({ err: error, context }, 'notification production failed');
    },
  });

  const unsubscribe = producer.start(options.bus);

  return {
    service,
    producer,
    stop: unsubscribe,
  };
}
