import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { requestContextOf } from '../http/context.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import {
  dataEnvelopeSchema,
  listEnvelopeSchema,
  noContentSchema,
} from '../http/response-schema.js';
import { projectSchema } from './response-schemas.js';
import { WORKFLOW_MODES } from './serialize.js';
import type { ProjectService } from './service.js';
import { MAX_PROJECT_NAME_LENGTH } from './validation.js';

/**
 * `/api/v1/projects/*` — TDS 04 §4, path for path and shape for shape.
 *
 *   GET    /api/v1/projects        cursor list; `?archived=false` (default)
 *   POST   /api/v1/projects        201 { data: Project }
 *   GET    /api/v1/projects/{id}
 *   PATCH  /api/v1/projects/{id}   { name?, description?, archivedAt?, workflowMode? }
 *   DELETE /api/v1/projects/{id}   204; 409 while sessions/repositories reference it
 *
 * There is no `POST /projects/{id}/archive`. F5.1 makes sub-actions the home of lifecycle verbs
 * that "don't map to CRUD", and this one does: §4 spells archival as `PATCH { archivedAt }`,
 * so a second spelling of the same write would be the deviation, not the omission.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const projectIdParamsSchema = {
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
    archived: { type: 'boolean' },
  },
} as const;

/**
 * `workflowMode` admits `null` explicitly: on create it means "inherit the global setting",
 * and on update it *clears* an existing override (§4). A schema that only allowed the two
 * strings would make the override one-way.
 */
const workflowModeSchema = {
  type: ['string', 'null'],
  enum: [...WORKFLOW_MODES, null],
} as const;

const createBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_PROJECT_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: 10_000 },
    workflowMode: workflowModeSchema,
  },
} as const;

const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_PROJECT_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: 10_000 },
    workflowMode: workflowModeSchema,
    // Validated as an instant in `validation.ts` rather than with `format: date-time`, so the
    // rule holds for every caller of the service and not only for callers that came in as JSON.
    archivedAt: { type: ['string', 'null'], maxLength: 64 },
  },
} as const;

interface ProjectIdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  archived?: boolean;
}
interface CreateBody {
  name: string;
  description?: string | null;
  workflowMode?: 'manual' | 'assisted' | null;
}
interface UpdateBody {
  name?: string;
  description?: string | null;
  workflowMode?: 'manual' | 'assisted' | null;
  archivedAt?: string | null;
}

/** See `sessions/routes.ts` for what a `response` block is and is not (it never strips). */
const projectResponse = dataEnvelopeSchema(projectSchema);

export interface ProjectRoutesOptions {
  readonly projects: ProjectService;
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectRoutesOptions): void {
  const { projects } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/projects',
    {
      schema: {
        querystring: listQuerySchema,
        response: { 200: listEnvelopeSchema(projectSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      // F5.3's default ordering key is the UUIDv7 `id`, ascending; §4 states no exception.
      const order = request.query.order ?? 'asc';

      const rows = await projects.list({
        limit,
        order,
        archived: request.query.archived ?? false,
        afterId: decodeIdCursor(request.query.cursor),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/v1/projects',
    { schema: { body: createBodySchema, response: { 201: projectResponse } } },
    async (request, reply) => {
      const created = await projects.create(
        requirePrincipal(request),
        {
          name: request.body.name,
          ...('description' in request.body ? { description: request.body.description } : {}),
          ...('workflowMode' in request.body ? { workflowMode: request.body.workflowMode } : {}),
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: ProjectIdParams }>(
    '/api/v1/projects/:id',
    { schema: { params: projectIdParamsSchema, response: { 200: projectResponse } } },
    async (request) => dataEnvelope(await projects.get(request.params.id)),
  );

  app.patch<{ Params: ProjectIdParams; Body: UpdateBody }>(
    '/api/v1/projects/:id',
    {
      schema: {
        params: projectIdParamsSchema,
        body: updateBodySchema,
        response: { 200: projectResponse },
      },
    },
    async (request) => {
      const body = request.body;
      const updated = await projects.update(
        requirePrincipal(request),
        request.params.id,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...('description' in body ? { description: body.description } : {}),
          ...('workflowMode' in body ? { workflowMode: body.workflowMode } : {}),
          ...('archivedAt' in body ? { archivedAt: body.archivedAt } : {}),
        },
        requestContextOf(request),
      );

      return dataEnvelope(updated);
    },
  );

  app.delete<{ Params: ProjectIdParams }>(
    '/api/v1/projects/:id',
    { schema: { params: projectIdParamsSchema, response: { 204: noContentSchema } } },
    async (request, reply) => {
      await projects.remove(
        requirePrincipal(request),
        request.params.id,
        requestContextOf(request),
      );
      reply.code(204);
      // §1.2: deletes answer `204 No Content` — no envelope, no body.
      return null;
    },
  );
}
