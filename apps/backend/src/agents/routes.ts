import {
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  type AgentRuntime,
  type AgentScope,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_INSTRUCTIONS_LENGTH,
  MAX_AGENT_NAME_LENGTH,
} from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { requestContextOf } from '../http/context.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import { dataEnvelopeSchema, listEnvelopeSchema } from '../http/response-schema.js';
import { agentSchema } from './response-schemas.js';
import type { AgentService } from './service.js';

/**
 * `/api/v1/agents/*` — TDS 04 §13.2, which reserved these routes as "interface only". This is
 * the payload detail.
 *
 *   GET   /api/v1/agents        cursor list; `?scope=`, `?projectId=`, `?sessionId=`,
 *                               `?includeArchived=`
 *   POST  /api/v1/agents        201
 *   GET   /api/v1/agents/{id}
 *   PATCH /api/v1/agents/{id}   fields, permissions, and `archived`
 *
 * **§13.2's other two reserved routes are deliberately absent.**
 * `POST /agents/{id}/assignments` and `POST /agents/{id}/executions` belong to later slices, and
 * their event names (`agent.assigned`, `agent.execution_*`) are correspondingly still unproduced.
 * A route that 501s is worse than one that 404s: it documents a capability that does not exist.
 * Binding an Agent to a Session happens today through the Session's own resource
 * (`POST /sessions` and `PATCH /sessions/{id}`, both carrying `agentId`), which is where the
 * lifecycle rule lives — an Agent may only be bound before launch.
 *
 * **There is no DELETE, and that is a decision** rather than an omission of §13.2's list: an
 * Agent is referenced by `sessions.agent_id`, by `audit_log_entries.actor_id` and by
 * `memory_items.agent_id`, so erasing one would rewrite history that is supposed to be
 * append-only. Retirement is `PATCH { "archived": true }`.
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
    scope: { type: 'string', enum: [...AGENT_SCOPES] },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    sessionId: { type: 'string', pattern: UUID_PATTERN },
    includeArchived: { type: 'boolean' },
  },
} as const;

/**
 * The permission document, spelled out rather than accepted as a free object.
 *
 * `additionalProperties: false` at both levels is load-bearing here in a way it is not on an
 * ordinary body: a misspelt `repository.wrote` would otherwise be dropped by Ajv and read as
 * `write: false` — the operator would be told the agent may not write, and be right, but for the
 * wrong reason and without having asked for it. The three names are exactly the three
 * capabilities that map onto a control surface; the omissions are argued in
 * `packages/shared/src/entities/agent.ts`.
 */
const permissionsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repository: {
      type: 'object',
      additionalProperties: false,
      properties: {
        read: { type: 'boolean' },
        write: { type: 'boolean' },
        shell: { type: 'boolean' },
      },
    },
  },
} as const;

const createBodySchema = {
  type: 'object',
  required: ['name', 'scope'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_AGENT_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: MAX_AGENT_DESCRIPTION_LENGTH },
    scope: { type: 'string', enum: [...AGENT_SCOPES] },
    projectId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    sessionId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    runtime: { type: 'string', enum: [...AGENT_RUNTIMES] },
    permissions: permissionsSchema,
    instructions: { type: ['string', 'null'], maxLength: MAX_AGENT_INSTRUCTIONS_LENGTH },
  },
} as const;

/**
 * No `scope`, `projectId` or `sessionId`: an Agent's scope is immutable (`service.ts`). They are
 * absent from the schema rather than rejected in the handler so the refusal is a `400` naming the
 * field, at the boundary, with the same wording every other unknown field gets.
 */
const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_AGENT_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: MAX_AGENT_DESCRIPTION_LENGTH },
    runtime: { type: 'string', enum: [...AGENT_RUNTIMES] },
    permissions: permissionsSchema,
    instructions: { type: ['string', 'null'], maxLength: MAX_AGENT_INSTRUCTIONS_LENGTH },
    archived: { type: 'boolean' },
  },
} as const;

interface IdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  scope?: AgentScope;
  projectId?: string;
  sessionId?: string;
  includeArchived?: boolean;
}
interface PermissionsBody {
  repository?: { read?: boolean; write?: boolean; shell?: boolean };
}
interface CreateBody {
  name: string;
  description?: string | null;
  scope: AgentScope;
  projectId?: string | null;
  sessionId?: string | null;
  runtime?: AgentRuntime;
  permissions?: PermissionsBody;
  instructions?: string | null;
}
interface UpdateBody {
  name?: string;
  description?: string | null;
  runtime?: AgentRuntime;
  permissions?: PermissionsBody;
  instructions?: string | null;
  archived?: boolean;
}

/** See `sessions/routes.ts` for what a `response` block is and is not (it never strips). */
const agentResponse = dataEnvelopeSchema(agentSchema);

export interface AgentRoutesOptions {
  readonly agents: AgentService;
}

export function registerAgentRoutes(app: FastifyInstance, options: AgentRoutesOptions): void {
  const { agents } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/agents',
    {
      schema: {
        querystring: listQuerySchema,
        response: { 200: listEnvelopeSchema(agentSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const order = request.query.order ?? 'asc';

      const rows = await agents.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        ...(request.query.scope === undefined ? {} : { scope: request.query.scope }),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
        ...(request.query.sessionId === undefined ? {} : { sessionId: request.query.sessionId }),
        ...(request.query.includeArchived === undefined
          ? {}
          : { includeArchived: request.query.includeArchived }),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/v1/agents',
    { schema: { body: createBodySchema, response: { 201: agentResponse } } },
    async (request, reply) => {
      const body = request.body;
      const created = await agents.create(
        requirePrincipal(request),
        {
          name: body.name,
          scope: body.scope,
          ...('description' in body ? { description: body.description } : {}),
          ...('projectId' in body ? { projectId: body.projectId } : {}),
          ...('sessionId' in body ? { sessionId: body.sessionId } : {}),
          ...(body.runtime === undefined ? {} : { runtime: body.runtime }),
          // `'permissions' in body` rather than `!== undefined`: omitting it means "use the
          // install default" and must stay distinguishable from sending `{}`, which means
          // "grant nothing".
          ...('permissions' in body ? { permissions: body.permissions } : {}),
          ...('instructions' in body ? { instructions: body.instructions } : {}),
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/agents/:id',
    { schema: { params: idParamsSchema, response: { 200: agentResponse } } },
    async (request) => dataEnvelope(await agents.get(request.params.id)),
  );

  app.patch<{ Params: IdParams; Body: UpdateBody }>(
    '/api/v1/agents/:id',
    {
      schema: {
        params: idParamsSchema,
        body: updateBodySchema,
        response: { 200: agentResponse },
      },
    },
    async (request) => {
      const body = request.body;
      const updated = await agents.update(
        requirePrincipal(request),
        request.params.id,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...('description' in body ? { description: body.description } : {}),
          ...(body.runtime === undefined ? {} : { runtime: body.runtime }),
          ...('permissions' in body ? { permissions: body.permissions } : {}),
          ...('instructions' in body ? { instructions: body.instructions } : {}),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        },
        requestContextOf(request),
      );

      return dataEnvelope(updated);
    },
  );
}
