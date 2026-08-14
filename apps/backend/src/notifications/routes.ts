import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit } from '../http/pagination.js';
import { dataEnvelopeSchema, listEnvelopeSchema } from '../http/response-schema.js';
import { decodeNotificationCursor, encodeNotificationCursor } from './cursors.js';
import { notificationSchema, readAllResultSchema } from './response-schemas.js';
import type { NotificationService } from './service.js';

/**
 * `/api/v1/notifications/*` — TDS 04 §8, path-for-path.
 *
 *   GET  /api/v1/notifications                 cursor list, newest first; `?unread=true`
 *   GET  /api/v1/notifications/{id}
 *   POST /api/v1/notifications/{id}/read       200 { data: Notification } — idempotent
 *   POST /api/v1/notifications/read-all        200 { data: { updated: number } }
 *
 * There is no create endpoint and there will not be one: creation is system-only (§8) —
 * the Backend and workers translate events into rows per `NotificationsSettings`.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const notificationIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    unread: { type: 'boolean' },
  },
} as const;

interface NotificationIdParams {
  id: string;
}

interface ListQuery {
  limit?: number;
  cursor?: string;
  unread?: boolean;
}

/** See `sessions/routes.ts` for what a `response` block is and is not (it never strips). */
const notificationResponse = dataEnvelopeSchema(notificationSchema);

export interface NotificationRoutesOptions {
  readonly notifications: NotificationService;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  options: NotificationRoutesOptions,
): void {
  const { notifications } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/notifications',
    {
      schema: {
        querystring: listQuerySchema,
        response: { 200: listEnvelopeSchema(notificationSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);

      const rows = await notifications.list(requirePrincipal(request), {
        limit,
        unreadOnly: request.query.unread === true,
        after: decodeNotificationCursor(request.query.cursor),
      });

      // The cursor is keyed on `(createdAt, id)`, never `id` alone (see `cursors.ts`), so this
      // cannot go through the default `paginate` helper.
      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        data: rows,
        meta: {
          nextCursor:
            last === undefined
              ? null
              : encodeNotificationCursor({ createdAt: new Date(last.createdAt), id: last.id }),
          limit,
        },
      };
    },
  );

  app.get<{ Params: NotificationIdParams }>(
    '/api/v1/notifications/:id',
    { schema: { params: notificationIdParamsSchema, response: { 200: notificationResponse } } },
    async (request) =>
      dataEnvelope(await notifications.get(requirePrincipal(request), request.params.id)),
  );

  app.post<{ Params: NotificationIdParams }>(
    '/api/v1/notifications/:id/read',
    { schema: { params: notificationIdParamsSchema, response: { 200: notificationResponse } } },
    async (request) =>
      dataEnvelope(await notifications.markRead(requirePrincipal(request), request.params.id)),
  );

  app.post(
    '/api/v1/notifications/read-all',
    { schema: { response: { 200: dataEnvelopeSchema(readAllResultSchema) } } },
    async (request) => dataEnvelope(await notifications.markAllRead(requirePrincipal(request))),
  );
}
