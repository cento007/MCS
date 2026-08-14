import type { Db } from '@mc/shared';
import {
  AGENT_TEAM_SCOPES,
  type AgentTeamScope,
  MAX_AGENT_TEAM_DESCRIPTION_LENGTH,
  MAX_AGENT_TEAM_MEMBERS,
  MAX_AGENT_TEAM_NAME_LENGTH,
  MAX_AGENT_TEAM_PROJECTS,
} from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../../auth/guard.js';
import { requestContextOf } from '../../http/context.js';
import { dataEnvelope } from '../../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../../http/pagination.js';
import { readProjectAvailableAgents } from './availability.js';
import type { AgentTeamService } from './service.js';

/**
 * `/api/v1/agent-teams/*` plus the one read that consumes them — TDS 04 §13.2, which reserved
 * `GET|POST /agent-teams` and `GET|PATCH /agent-teams/{id}` as "interface only". This is the
 * payload detail.
 *
 *   GET    /api/v1/agent-teams        cursor list; `?scope=`, `?projectId=`
 *   POST   /api/v1/agent-teams        201
 *   GET    /api/v1/agent-teams/{id}
 *   PATCH  /api/v1/agent-teams/{id}   name, description, roster, project assignments
 *   DELETE /api/v1/agent-teams/{id}   204; 409 while assigned
 *
 *   GET    /api/v1/projects/{id}/available-agents
 *
 * **Two of these are not in §13.2's reserved list, and both are recorded there rather than
 * smuggled in.**
 *
 * `DELETE /agent-teams/{id}` exists because the argument that rules it out for `/agents` does not
 * transfer: an Agent is referenced as history (`sessions.agent_id`, `audit_log_entries.actor_id`,
 * `memory_items.agent_id`), a team is referenced only by its own rows. The full case is on
 * `AgentTeamService.remove` and on the tables.
 *
 * `GET /projects/{id}/available-agents` exists because a team that nothing consults is a named
 * list. It hangs off the Project because the question is the Project's ("who can work here?"),
 * and it lives in this module because the answer is agents — the same split `commits/` and
 * `pull-requests/` use for routes that hang off a Repository.
 *
 * **Assignment is a field, not a sub-route.** `PATCH /agent-teams/{id} { projectIds }` replaces
 * the whole set, so assigning, unassigning and moving are one idempotent write with one shape.
 * A `POST /agent-teams/{id}/assignments` would have been the F5.1 idiom for a *state machine*
 * transition, and an assignment is not one — it is a set membership, and F5.1 spells those as
 * fields (the same reasoning that keeps archival on `PATCH /projects/{id}`).
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
    scope: { type: 'string', enum: [...AGENT_TEAM_SCOPES] },
    /** The team's **own** project. Which team a Project is *assigned* is the availability read. */
    projectId: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

/**
 * The roster, as ids.
 *
 * `uniqueItems` is deliberately **absent**: repeats are collapsed rather than rejected
 * (`normalizeIdList`), because sending the same agent twice says the same thing twice and a 400
 * would be pedantry. `maxItems` is present because a team write emits one event per assigned
 * project and the request should not be able to ask for unbounded work.
 */
const agentIdsSchema = {
  type: 'array',
  maxItems: MAX_AGENT_TEAM_MEMBERS,
  items: { type: 'string', pattern: UUID_PATTERN },
} as const;

const projectIdsSchema = {
  type: 'array',
  maxItems: MAX_AGENT_TEAM_PROJECTS,
  items: { type: 'string', pattern: UUID_PATTERN },
} as const;

const createBodySchema = {
  type: 'object',
  required: ['name', 'scope'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_AGENT_TEAM_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: MAX_AGENT_TEAM_DESCRIPTION_LENGTH },
    scope: { type: 'string', enum: [...AGENT_TEAM_SCOPES] },
    projectId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    agentIds: agentIdsSchema,
    projectIds: projectIdsSchema,
  },
} as const;

/**
 * No `scope` and no `projectId`: a team's scope is immutable (`service.ts`). They are absent from
 * the schema rather than rejected in the handler so the refusal is a `400` naming the field, at
 * the boundary, with the same wording every other unknown field gets.
 */
const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_AGENT_TEAM_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: MAX_AGENT_TEAM_DESCRIPTION_LENGTH },
    agentIds: agentIdsSchema,
    projectIds: projectIdsSchema,
  },
} as const;

interface IdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  scope?: AgentTeamScope;
  projectId?: string;
}
interface CreateBody {
  name: string;
  description?: string | null;
  scope: AgentTeamScope;
  projectId?: string | null;
  agentIds?: string[];
  projectIds?: string[];
}
interface UpdateBody {
  name?: string;
  description?: string | null;
  agentIds?: string[];
  projectIds?: string[];
}

export interface AgentTeamRoutesOptions {
  readonly teams: AgentTeamService;
  readonly db: Db;
}

export function registerAgentTeamRoutes(
  app: FastifyInstance,
  options: AgentTeamRoutesOptions,
): void {
  const { teams, db } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/agent-teams',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const order = request.query.order ?? 'asc';

      const rows = await teams.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        ...(request.query.scope === undefined ? {} : { scope: request.query.scope }),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/v1/agent-teams',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const created = await teams.create(
        requirePrincipal(request),
        {
          name: body.name,
          scope: body.scope,
          ...('description' in body ? { description: body.description } : {}),
          ...('projectId' in body ? { projectId: body.projectId } : {}),
          ...(body.agentIds === undefined ? {} : { agentIds: body.agentIds }),
          ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds }),
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/agent-teams/:id',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await teams.get(request.params.id)),
  );

  app.patch<{ Params: IdParams; Body: UpdateBody }>(
    '/api/v1/agent-teams/:id',
    { schema: { params: idParamsSchema, body: updateBodySchema } },
    async (request) => {
      const body = request.body;
      const updated = await teams.update(
        requirePrincipal(request),
        request.params.id,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...('description' in body ? { description: body.description } : {}),
          // `!== undefined` rather than `in`: an omitted array means "leave this set alone" and
          // `[]` means "empty it". `null` is not accepted by the schema, so there is no third
          // spelling to disambiguate.
          ...(body.agentIds === undefined ? {} : { agentIds: body.agentIds }),
          ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds }),
        },
        requestContextOf(request),
      );

      return dataEnvelope(updated);
    },
  );

  app.delete<{ Params: IdParams }>(
    '/api/v1/agent-teams/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      await teams.remove(requirePrincipal(request), request.params.id, requestContextOf(request));
      reply.code(204);
      // §1.2: deletes answer `204 No Content` — no envelope, no body.
      return null;
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/projects/:id/available-agents',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await readProjectAvailableAgents(db, request.params.id)),
  );
}
