import { MESSAGE_ROLES, SESSION_STATES } from '@mc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { commitSchema } from '../commits/response-schemas.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import {
  dataEnvelopeSchema,
  dataWithMetaSchema,
  listEnvelopeSchema,
} from '../http/response-schema.js';
import {
  decodeCommitCursor,
  decodeOrdinalCursor,
  encodeCommitCursor,
  encodeOrdinalCursor,
} from './cursors.js';
import {
  interruptResultSchema,
  launchMetaSchema,
  messageSchema,
  sessionFilesSchema,
  sessionSchema,
  timelineEntrySchema,
} from './response-schemas.js';
import type { RequestContext, SessionService } from './service.js';
import { MAX_TITLE_LENGTH } from './title.js';

/**
 * `/api/v1/sessions/*` — TDS 04 §6, path-for-path and shape-for-shape.
 *
 *   GET    /api/v1/sessions                    cursor list, filters per §6.2
 *   POST   /api/v1/sessions                    201, managed Session in state `created`
 *   GET    /api/v1/sessions/{id}
 *   PATCH  /api/v1/sessions/{id}               title / notes / projectId / agentId (PRD §5.1)
 *   POST   /api/v1/sessions/{id}/start         200 { data, meta: { launch } } — never 409 on capacity
 *   POST   /api/v1/sessions/{id}/pause         200
 *   POST   /api/v1/sessions/{id}/resume        200 in place from `paused`; 201 new Session otherwise
 *   POST   /api/v1/sessions/{id}/end           200
 *   POST   /api/v1/sessions/{id}/archive       200
 *   POST   /api/v1/sessions/{id}/clone         201
 *   POST   /api/v1/sessions/{id}/interrupt     200 — no state transition (§6.3.1)
 *   GET    /api/v1/sessions/{id}/messages      cursor list keyed on `ordinal` (§6.6)
 *   GET    /api/v1/sessions/{id}/timeline      cursor list from `session_events` (§6.7)
 *   GET    /api/v1/sessions/{id}/commits       cursor list, newest first (§6.10.1)
 *   GET    /api/v1/sessions/{id}/files         bounded read model, no meta (§6.10.2)
 *
 * `POST /sessions/{id}/export` and `/context-package` (§6.7) are served too, from
 * `sessions/export/` — they are registered separately because the context package reads the
 * semantic-memory layer, which is built after this module.
 *
 * `POST /sessions/{id}/prompts` (§6.4) and `POST /hook-events` (§6.8) are registered by
 * `managed/` and `observed/` respectively, each only when its runtime is wired.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const sessionIdParamsSchema = {
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
    state: { type: 'string', enum: [...SESSION_STATES] },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    sessionType: { type: 'string', enum: ['managed', 'observed'] },
    repositoryId: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

const createBodySchema = {
  type: 'object',
  required: ['projectId', 'workingDirectory'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', pattern: UUID_PATTERN },
    workingDirectory: { type: 'string', minLength: 1, maxLength: 4096 },
    repositoryId: { type: 'string', pattern: UUID_PATTERN },
    branch: { type: 'string', maxLength: 255 },
    title: { type: 'string', maxLength: MAX_TITLE_LENGTH },
    model: { type: 'string', maxLength: 128 },
    /** PRD §5.1 — the Agent persona to run as. Global or project-scoped (§13.2, `agents/`). */
    agentId: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // §6.11.4: `null` (and `''`, and whitespace) clears the title.
    title: { type: ['string', 'null'], maxLength: MAX_TITLE_LENGTH },
    notes: { type: ['string', 'null'] },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    /** `null` unbinds. Legal only while the Session is `created` — see `service.ts`. */
    agentId: { type: ['string', 'null'], pattern: UUID_PATTERN },
  },
} as const;

/**
 * `null` is admitted alongside `object` because §6.3 makes the whole body optional
 * (`Body: { title?: string }`) — a `POST` with no payload arrives as `null`, and rejecting it
 * would 400 the plainest possible call to this endpoint.
 */
const cloneBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: { title: { type: 'string', maxLength: MAX_TITLE_LENGTH } },
} as const;

const messagesQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    order: { type: 'string', enum: ['asc', 'desc'] },
    role: { type: 'string', enum: [...MESSAGE_ROLES] },
    status: { type: 'string', enum: ['complete', 'pending', 'interrupted'] },
  },
} as const;

const nestedListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

interface SessionIdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  state?: (typeof SESSION_STATES)[number];
  projectId?: string;
  sessionType?: 'managed' | 'observed';
  repositoryId?: string;
}
interface CreateBody {
  projectId: string;
  workingDirectory: string;
  repositoryId?: string;
  branch?: string;
  title?: string;
  model?: string;
  agentId?: string;
}
interface UpdateBody {
  title?: string | null;
  notes?: string | null;
  projectId?: string;
  agentId?: string | null;
}
interface CloneBody {
  title?: string;
}
interface MessagesQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  role?: (typeof MESSAGE_ROLES)[number];
  status?: 'complete' | 'pending' | 'interrupted';
}
interface NestedListQuery {
  limit?: number;
  cursor?: string;
}

/**
 * The `response` blocks below are **declarations, not serializers** — `http/response-schema.ts`
 * installs a serializer compiler that ignores them, so none of them can drop a field the handler
 * produced. They exist so `openapi.yaml` can state the success payloads and so
 * `apps/frontend/src/lib/api/types.ts` can be generated rather than transcribed; the conformance
 * hook validates every reply against them in the test tiers, which is what keeps them true.
 */
const sessionResponse = dataEnvelopeSchema(sessionSchema);
const sessionLaunchResponse = dataWithMetaSchema(sessionSchema, launchMetaSchema);

export interface SessionRoutesOptions {
  readonly sessions: SessionService;
}

export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { sessions } = options;

  // ------------------------------------------------------------------------- CRUD (§6.2)

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/sessions',
    {
      schema: {
        querystring: listQuerySchema,
        response: { 200: listEnvelopeSchema(sessionSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      // §6.2: newest first by default, which is also what makes the Needs Attention widget's
      // client-side 24 h filter safe at single-operator volumes (N16).
      const order = request.query.order ?? 'desc';

      const rows = await sessions.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        state: request.query.state,
        projectId: request.query.projectId,
        sessionType: request.query.sessionType,
        repositoryId: request.query.repositoryId,
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/v1/sessions',
    { schema: { body: createBodySchema, response: { 201: sessionResponse } } },
    async (request, reply) => {
      const created = await sessions.create(
        requirePrincipal(request),
        {
          projectId: request.body.projectId,
          workingDirectory: request.body.workingDirectory,
          repositoryId: request.body.repositoryId,
          branch: request.body.branch,
          title: request.body.title,
          model: request.body.model,
          agentId: request.body.agentId,
        },
        contextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id',
    { schema: { params: sessionIdParamsSchema, response: { 200: sessionResponse } } },
    async (request) => dataEnvelope(await sessions.get(request.params.id)),
  );

  app.patch<{ Params: SessionIdParams; Body: UpdateBody }>(
    '/api/v1/sessions/:id',
    {
      schema: {
        params: sessionIdParamsSchema,
        body: updateBodySchema,
        response: { 200: sessionResponse },
      },
    },
    async (request) => {
      const body = request.body;
      const updated = await sessions.update(
        requirePrincipal(request),
        request.params.id,
        {
          ...('title' in body ? { title: body.title } : {}),
          ...('notes' in body ? { notes: body.notes } : {}),
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          // `in` rather than `!== undefined`: `null` is a real value here (unbind), and it must
          // stay distinguishable from "the field was not sent".
          ...('agentId' in body ? { agentId: body.agentId } : {}),
        },
        contextOf(request),
      );

      return dataEnvelope(updated);
    },
  );

  // ------------------------------------------------------------ lifecycle actions (§6.3)

  app.post<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/start',
    { schema: { params: sessionIdParamsSchema, response: { 200: sessionLaunchResponse } } },
    async (request) => {
      const result = await sessions.start(
        requirePrincipal(request),
        request.params.id,
        contextOf(request),
      );
      // §6.2.1: saturation is reported, never rejected.
      return { data: result.session, meta: { launch: result.launch } };
    },
  );

  app.post<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/pause',
    { schema: { params: sessionIdParamsSchema, response: { 200: sessionResponse } } },
    async (request) =>
      dataEnvelope(
        await sessions.pause(requirePrincipal(request), request.params.id, contextOf(request)),
      ),
  );

  app.post<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/resume',
    {
      schema: {
        params: sessionIdParamsSchema,
        // Two shapes, two status codes: `200` resumes in place and reports the launch
        // disposition; `201` is a NEW Session (§6.3) and carries the bare envelope.
        response: { 200: sessionLaunchResponse, 201: sessionResponse },
      },
    },
    async (request, reply) => {
      const outcome = await sessions.resume(
        requirePrincipal(request),
        request.params.id,
        contextOf(request),
      );

      if (outcome.kind === 'in_place') {
        return { data: outcome.result.session, meta: { launch: outcome.result.launch } };
      }

      // §6.3: resuming a completed/archived Session creates a NEW Session — 201, not 200.
      reply.code(201);
      return dataEnvelope(outcome.session);
    },
  );

  app.post<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/end',
    { schema: { params: sessionIdParamsSchema, response: { 200: sessionResponse } } },
    async (request) =>
      dataEnvelope(
        await sessions.end(requirePrincipal(request), request.params.id, contextOf(request)),
      ),
  );

  app.post<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/archive',
    { schema: { params: sessionIdParamsSchema, response: { 200: sessionResponse } } },
    async (request) =>
      dataEnvelope(
        await sessions.archive(requirePrincipal(request), request.params.id, contextOf(request)),
      ),
  );

  app.post<{ Params: SessionIdParams; Body: CloneBody }>(
    '/api/v1/sessions/:id/clone',
    {
      schema: {
        params: sessionIdParamsSchema,
        body: cloneBodySchema,
        response: { 201: sessionResponse },
      },
    },
    async (request, reply) => {
      const cloned = await sessions.clone(
        requirePrincipal(request),
        request.params.id,
        { title: request.body?.title },
        contextOf(request),
      );

      reply.code(201);
      return dataEnvelope(cloned);
    },
  );

  app.post<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/interrupt',
    {
      schema: {
        params: sessionIdParamsSchema,
        response: { 200: dataEnvelopeSchema(interruptResultSchema) },
      },
    },
    async (request) =>
      dataEnvelope(
        await sessions.interrupt(requirePrincipal(request), request.params.id, contextOf(request)),
      ),
  );

  // -------------------------------------------------------------------- nested reads

  app.get<{ Params: SessionIdParams; Querystring: MessagesQuery }>(
    '/api/v1/sessions/:id/messages',
    {
      schema: {
        params: sessionIdParamsSchema,
        querystring: messagesQuerySchema,
        response: { 200: listEnvelopeSchema(messageSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const order = request.query.order ?? 'asc';

      const rows = await sessions.listMessages(request.params.id, {
        limit,
        order,
        afterOrdinal: decodeOrdinalCursor(request.query.cursor),
        role: request.query.role,
        status: request.query.status,
      });

      // The cursor is keyed on `ordinal`, never `id` (§6.6 / arbitration A5), so this cannot
      // go through the default `paginate` helper.
      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        data: rows,
        meta: {
          nextCursor: last === undefined ? null : encodeOrdinalCursor(last.ordinal),
          limit,
        },
      };
    },
  );

  app.get<{ Params: SessionIdParams; Querystring: NestedListQuery }>(
    '/api/v1/sessions/:id/timeline',
    {
      schema: {
        params: sessionIdParamsSchema,
        querystring: nestedListQuerySchema,
        response: { 200: listEnvelopeSchema(timelineEntrySchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const rows = await sessions.listTimeline(request.params.id, {
        limit,
        afterId: decodeIdCursor(request.query.cursor),
      });
      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.get<{ Params: SessionIdParams; Querystring: NestedListQuery }>(
    '/api/v1/sessions/:id/commits',
    {
      schema: {
        params: sessionIdParamsSchema,
        querystring: nestedListQuerySchema,
        // §6.10.1 serves "the `Commit` resource of §5.2" — one resource, one schema.
        response: { 200: listEnvelopeSchema(commitSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const rows = await sessions.listCommits(request.params.id, {
        limit,
        after: decodeCommitCursor(request.query.cursor),
      });

      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        data: rows,
        meta: {
          nextCursor:
            last === undefined
              ? null
              : encodeCommitCursor({ committedAt: new Date(last.committedAt), id: last.id }),
          limit,
        },
      };
    },
  );

  app.get<{ Params: SessionIdParams }>(
    '/api/v1/sessions/:id/files',
    {
      schema: {
        params: sessionIdParamsSchema,
        response: { 200: dataEnvelopeSchema(sessionFilesSchema) },
      },
    },
    // §1.2: a bounded read model returns `{ data: … }` with no `meta`.
    async (request) => dataEnvelope(await sessions.listFiles(request.params.id)),
  );
}

function contextOf(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    ipAddress: request.ip.length > 0 ? request.ip : null,
  };
}
