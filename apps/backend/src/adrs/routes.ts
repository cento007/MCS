import { ADR_STATUSES } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { requestContextOf } from '../http/context.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import type { AdrService } from './service.js';
import { MAX_ADR_SECTION_LENGTH, MAX_ADR_TITLE_LENGTH } from './validation.js';

/**
 * `/api/v1/adrs/*` — TDS 04 §9.
 *
 *   GET   /api/v1/adrs                        cursor list; `?projectId=`, `?status=`
 *   POST  /api/v1/adrs                        manual create -> 201 (status defaults `proposed`)
 *   GET   /api/v1/adrs/{id}
 *   PATCH /api/v1/adrs/{id}                   edit fields / change status / supersede
 *   POST  /api/v1/sessions/{id}/generate-adr  -> 202 { jobId }; the Sync Worker drafts it
 *
 * The last route hangs off a Session path but is registered here, with the module that owns
 * the ADR domain — `sessions/` neither creates ADRs nor knows the generation queue exists.
 *
 * `status` is enumerated in the schema so a request carrying `draft` is refused at the
 * boundary with the four legal values in the message (there is no `draft` — §9, A4).
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParamsSchema = {
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
    order: { type: 'string', enum: ['asc', 'desc'] },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    status: { type: 'string', enum: [...ADR_STATUSES] },
  },
} as const;

const section = { type: 'string', maxLength: MAX_ADR_SECTION_LENGTH } as const;

const createBodySchema = {
  type: 'object',
  required: ['projectId', 'title'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', pattern: UUID_PATTERN },
    title: { type: 'string', minLength: 1, maxLength: MAX_ADR_TITLE_LENGTH },
    status: { type: 'string', enum: [...ADR_STATUSES] },
    context: section,
    decision: section,
    alternatives: section,
    consequences: section,
  },
} as const;

const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: MAX_ADR_TITLE_LENGTH },
    status: { type: 'string', enum: [...ADR_STATUSES] },
    context: section,
    decision: section,
    alternatives: section,
    consequences: section,
    supersededByAdrId: { type: ['string', 'null'], pattern: UUID_PATTERN },
  },
} as const;

interface IdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  projectId?: string;
  status?: string;
}
interface CreateBody {
  projectId: string;
  title: string;
  status?: string;
  context?: string;
  decision?: string;
  alternatives?: string;
  consequences?: string;
}
interface UpdateBody {
  title?: string;
  status?: string;
  context?: string;
  decision?: string;
  alternatives?: string;
  consequences?: string;
  supersededByAdrId?: string | null;
}

export interface AdrRoutesOptions {
  readonly adrs: AdrService;
}

export function registerAdrRoutes(app: FastifyInstance, options: AdrRoutesOptions): void {
  const { adrs } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/adrs',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const order = request.query.order ?? 'asc';

      const rows = await adrs.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/v1/adrs',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const created = await adrs.create(
        requirePrincipal(request),
        {
          projectId: request.body.projectId,
          title: request.body.title,
          status: request.body.status,
          context: request.body.context,
          decision: request.body.decision,
          alternatives: request.body.alternatives,
          consequences: request.body.consequences,
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/adrs/:id',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await adrs.get(request.params.id)),
  );

  app.patch<{ Params: IdParams; Body: UpdateBody }>(
    '/api/v1/adrs/:id',
    { schema: { params: idParamsSchema, body: updateBodySchema } },
    async (request) => {
      const body = request.body;
      const updated = await adrs.update(
        requirePrincipal(request),
        request.params.id,
        {
          title: body.title,
          status: body.status,
          context: body.context,
          decision: body.decision,
          alternatives: body.alternatives,
          consequences: body.consequences,
          ...('supersededByAdrId' in body
            ? { supersededByAdrId: body.supersededByAdrId ?? null }
            : {}),
        },
        requestContextOf(request),
      );

      return dataEnvelope(updated);
    },
  );

  app.post<{ Params: IdParams }>(
    '/api/v1/sessions/:id/generate-adr',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const result = await adrs.generateFromSession(
        requirePrincipal(request),
        request.params.id,
        requestContextOf(request),
      );

      reply.code(202);
      return dataEnvelope(result);
    },
  );
}
