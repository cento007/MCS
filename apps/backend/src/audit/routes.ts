import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit } from '../http/pagination.js';
import { decodeAuditCursor, encodeAuditCursor } from './cursors.js';
import { type AuditLogService, parseInstant } from './query.js';

/**
 * `/api/v1/audit-log-entries` — TDS 04 §12.
 *
 *   GET /api/v1/audit-log-entries        cursor list, newest first
 *   GET /api/v1/audit-log-entries/{id}
 *
 * Filters per §12: `?action=`, `?actorType=`, `?from=`, `?to=`, `?entityType=`, `?entityId=`.
 * Read-only — the resource has no writer, which is the point of an audit log.
 *
 * A *known* filter with an unusable value is rejected rather than dropped (`?from=lastTuesday`
 * is a 400, not "every row ever"): an audit filter that fails open answers a narrow question
 * with the whole table.
 *
 * An **unknown** parameter is rejected too, and no longer by anything in this file. It used to
 * be silently discarded by Fastify's Ajv (`removeAdditional: true`), so `?actor=me` read as no
 * filter at all and this endpoint answered a narrow question with every row it had. The fix is
 * where the note said it belonged — one place for all routes: `http/query-strictness.ts`, whose
 * allowlist is derived from the `listQuerySchema` below, so a filter that is not spelled
 * exactly as it appears there is a `VALIDATION_FAILED`.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    action: { type: 'string', minLength: 1, maxLength: 128 },
    actorType: { type: 'string', enum: ['user', 'agent', 'system'] },
    entityType: { type: 'string', minLength: 1, maxLength: 64 },
    entityId: { type: 'string', pattern: UUID_PATTERN },
    from: { type: 'string', minLength: 1, maxLength: 64 },
    to: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

interface ListQuery {
  limit?: number;
  cursor?: string;
  action?: string;
  actorType?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

export interface AuditRoutesOptions {
  readonly audit: AuditLogService;
}

export function registerAuditRoutes(app: FastifyInstance, options: AuditRoutesOptions): void {
  const { audit } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/audit-log-entries',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const query = request.query;

      const rows = await audit.list({
        limit,
        after: decodeAuditCursor(query.cursor),
        action: query.action,
        actorType: query.actorType,
        entityType: query.entityType,
        entityId: query.entityId,
        from: parseInstant(query.from, 'from'),
        to: parseInstant(query.to, 'to'),
      });

      // Keyed on `(occurredAt, id)`, never `id` alone (see `cursors.ts`), so this cannot go
      // through the default `paginate` helper.
      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        data: rows,
        meta: {
          nextCursor:
            last === undefined
              ? null
              : encodeAuditCursor({ occurredAt: new Date(last.occurredAt), id: last.id }),
          limit,
        },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/audit-log-entries/:id',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await audit.get(request.params.id)),
  );
}
