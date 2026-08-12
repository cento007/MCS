import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { requestContextOf } from '../http/context.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import type { RepositoryService } from './service.js';
import { MAX_BRANCH_LENGTH, MAX_REPOSITORY_NAME_LENGTH } from './validation.js';

/**
 * `/api/v1/repositories/*` — TDS 04 §5.1, plus the three routes marked ⚠ in `service.ts`.
 *
 *   GET    /api/v1/repositories             cursor list; `?projectId=` filter (§5.1)
 *   POST   /api/v1/repositories             ⚠ register by local path -> 201
 *   GET    /api/v1/repositories/{id}        (§5.1)
 *   PATCH  /api/v1/repositories/{id}        { projectId?, name?, defaultBranch? } (§5.1 + ⚠)
 *   DELETE /api/v1/repositories/{id}        ⚠ de-register -> 204
 *   GET    /api/v1/repositories/{id}/status ⚠ working-tree read model (WS5 §5.4.1 / WC11)
 *
 * Deliberately absent, for the reason `sessions/routes.ts` states about its own omissions —
 * they promise behaviour this Backend cannot deliver yet: `POST /repositories/discover` (needs
 * the discovery roots from a settings service that does not exist) and
 * `POST /repositories/{id}/sync` (needs the GitHub integration).
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const repositoryIdParamsSchema = {
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
  },
} as const;

const registerBodySchema = {
  type: 'object',
  required: ['localPath'],
  additionalProperties: false,
  properties: {
    localPath: { type: 'string', minLength: 1, maxLength: 4096 },
    name: { type: 'string', minLength: 1, maxLength: MAX_REPOSITORY_NAME_LENGTH },
    // `null` assigns nothing — the "discovered, unassigned" state (TDS 03 §3.6).
    projectId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    defaultBranch: { type: 'string', minLength: 1, maxLength: MAX_BRANCH_LENGTH },
  },
} as const;

const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: MAX_REPOSITORY_NAME_LENGTH },
    defaultBranch: { type: 'string', minLength: 1, maxLength: MAX_BRANCH_LENGTH },
  },
} as const;

interface RepositoryIdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  projectId?: string;
}
interface RegisterBody {
  localPath: string;
  name?: string;
  projectId?: string | null;
  defaultBranch?: string;
}
interface UpdateBody {
  projectId?: string | null;
  name?: string;
  defaultBranch?: string;
}

export interface RepositoryRoutesOptions {
  readonly repositories: RepositoryService;
}

export function registerRepositoryRoutes(
  app: FastifyInstance,
  options: RepositoryRoutesOptions,
): void {
  const { repositories } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/repositories',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      // F5.3's default ordering key is the UUIDv7 `id`, ascending; §5.1 states no exception.
      const order = request.query.order ?? 'asc';

      const rows = await repositories.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: RegisterBody }>(
    '/api/v1/repositories',
    { schema: { body: registerBodySchema } },
    async (request, reply) => {
      const created = await repositories.register(
        requirePrincipal(request),
        {
          localPath: request.body.localPath,
          ...(request.body.name === undefined ? {} : { name: request.body.name }),
          ...('projectId' in request.body ? { projectId: request.body.projectId } : {}),
          ...(request.body.defaultBranch === undefined
            ? {}
            : { defaultBranch: request.body.defaultBranch }),
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: RepositoryIdParams }>(
    '/api/v1/repositories/:id',
    { schema: { params: repositoryIdParamsSchema } },
    async (request) => dataEnvelope(await repositories.get(request.params.id)),
  );

  app.patch<{ Params: RepositoryIdParams; Body: UpdateBody }>(
    '/api/v1/repositories/:id',
    { schema: { params: repositoryIdParamsSchema, body: updateBodySchema } },
    async (request) => {
      const body = request.body;
      const updated = await repositories.update(
        requirePrincipal(request),
        request.params.id,
        {
          ...('projectId' in body ? { projectId: body.projectId } : {}),
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.defaultBranch === undefined ? {} : { defaultBranch: body.defaultBranch }),
        },
        requestContextOf(request),
      );

      return dataEnvelope(updated);
    },
  );

  app.delete<{ Params: RepositoryIdParams }>(
    '/api/v1/repositories/:id',
    { schema: { params: repositoryIdParamsSchema } },
    async (request, reply) => {
      await repositories.remove(
        requirePrincipal(request),
        request.params.id,
        requestContextOf(request),
      );
      reply.code(204);
      return null;
    },
  );

  app.get<{ Params: RepositoryIdParams }>(
    '/api/v1/repositories/:id/status',
    { schema: { params: repositoryIdParamsSchema } },
    // §1.2: a bounded read model returns `{ data: … }` with no `meta`.
    async (request) => dataEnvelope(await repositories.status(request.params.id)),
  );
}
