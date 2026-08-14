import {
  AGENT_WORKFLOW_RUN_STATES,
  AGENT_WORKFLOW_SCOPES,
  type AgentWorkflowRunState,
  type AgentWorkflowScope,
  MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_AGENT_WORKFLOW_NAME_LENGTH,
  MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH,
  MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  MAX_AGENT_WORKFLOW_STEPS,
} from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../../auth/guard.js';
import { requestContextOf } from '../../http/context.js';
import { dataEnvelope } from '../../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../../http/pagination.js';
import {
  dataEnvelopeSchema,
  dataWithMetaSchema,
  listEnvelopeSchema,
} from '../../http/response-schema.js';
import {
  agentWorkflowRunSchema,
  agentWorkflowSchema,
  stoppedSessionMetaSchema,
  workflowCostEstimateSchema,
} from './response-schemas.js';
import type { AgentWorkflowRunService } from './runs.js';
import type { AgentWorkflowService } from './service.js';

/**
 * `/api/v1/agent-workflows/*` and `/api/v1/agent-workflow-runs/*` — PRD §5.6, recorded in
 * TDS 04 §13.2.2. **None of these routes was reserved by §13.2**, which listed Agent CRUD,
 * assignment, execution and AgentTeam CRUD and nothing else; they are recorded there as additions
 * rather than smuggled in, the same way §13.1 recorded the two backfill routes and §13.2.1
 * recorded `DELETE /agent-teams/{id}`.
 *
 *   GET    /api/v1/agent-workflows                    cursor list; `?scope=`, `?projectId=`,
 *                                                     `?includeArchived=`
 *   POST   /api/v1/agent-workflows                    201
 *   GET    /api/v1/agent-workflows/{id}
 *   PATCH  /api/v1/agent-workflows/{id}               name, description, the chain, `archived`
 *   GET    /api/v1/agent-workflows/{id}/cost-estimate bounded read model, no pagination
 *
 *   GET    /api/v1/agent-workflow-runs                cursor list; `?workflowId=`, `?projectId=`,
 *                                                     `?state=`
 *   POST   /api/v1/agent-workflow-runs                201 — starts the chain
 *   GET    /api/v1/agent-workflow-runs/{id}
 *   POST   /api/v1/agent-workflow-runs/{id}/stop      the kill switch
 *   POST   /api/v1/agent-workflow-runs/{id}/resume    a halted run is not a dead row
 *
 * **There is no `DELETE /agent-workflows/{id}`, and no delete for a run.** A workflow is
 * referenced as history by `agent_workflow_runs.workflow_id` exactly as an Agent is by
 * `sessions.agent_id`, so retirement is `PATCH { "archived": true }` and the FK is `RESTRICT`. A
 * run is the record of money spent; nothing deletes one.
 *
 * **Stop and resume are sub-actions, and that is the F5.1 idiom used correctly.** Slice 2 declined
 * `POST /agent-teams/{id}/assignments` because an assignment is a *field*; these two are the
 * opposite case — a run is a genuine state machine (`running -> halted -> running -> stopped`),
 * and a `PATCH { state: 'stopped' }` would invite the client to move it anywhere the enum allows.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const workflowListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    order: { type: 'string', enum: ['asc', 'desc'] },
    scope: { type: 'string', enum: [...AGENT_WORKFLOW_SCOPES] },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    includeArchived: { type: 'boolean' },
  },
} as const;

/**
 * The chain, as an ordered array.
 *
 * `minItems: 1` is here as well as in `assertStepCount` because an empty chain is the one shape
 * that would sail through every other check and then start a run that finishes instantly.
 * `uniqueItems` is deliberately **absent**: `Developer → QA → Developer` is legitimate, which is
 * the one place a workflow differs from a team roster.
 */
const stepsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_AGENT_WORKFLOW_STEPS,
  items: {
    type: 'object',
    required: ['agentId'],
    additionalProperties: false,
    properties: {
      agentId: { type: 'string', pattern: UUID_PATTERN },
      instructions: {
        type: ['string', 'null'],
        maxLength: MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
      },
    },
  },
} as const;

const createWorkflowBodySchema = {
  type: 'object',
  required: ['name', 'scope', 'steps'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_AGENT_WORKFLOW_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH },
    scope: { type: 'string', enum: [...AGENT_WORKFLOW_SCOPES] },
    projectId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    steps: stepsSchema,
  },
} as const;

/** No `scope`, no `projectId`: a workflow's scope is immutable (`service.ts`). */
const updateWorkflowBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_AGENT_WORKFLOW_NAME_LENGTH },
    description: { type: ['string', 'null'], maxLength: MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH },
    steps: stepsSchema,
    archived: { type: 'boolean' },
  },
} as const;

const runListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    order: { type: 'string', enum: ['asc', 'desc'] },
    workflowId: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    state: { type: 'string', enum: [...AGENT_WORKFLOW_RUN_STATES] },
  },
} as const;

/**
 * `maxSessions` is the operator's dial on the spend bound, and it is exposed rather than fixed:
 * the run's own CHECK caps it at `MAX_AGENT_WORKFLOW_RUN_SESSIONS`, and the service refuses a
 * value below the chain's step count. Omitting it takes the default
 * (`defaultAgentWorkflowRunSessions`), which is one Session per step plus three retries.
 */
const createRunBodySchema = {
  type: 'object',
  required: ['workflowId', 'projectId', 'task', 'workingDirectory'],
  additionalProperties: false,
  properties: {
    workflowId: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    task: { type: 'string', minLength: 1, maxLength: MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH },
    workingDirectory: { type: 'string', minLength: 1, maxLength: 4096 },
    repositoryId: { type: 'string', pattern: UUID_PATTERN },
    branch: { type: 'string', minLength: 1, maxLength: 255 },
    model: { type: 'string', minLength: 1, maxLength: 100 },
    maxSessions: { type: 'integer', minimum: 1, maximum: MAX_AGENT_WORKFLOW_RUN_SESSIONS },
  },
} as const;

/** `null` is admitted for the reason the clone and export bodies admit it: a bare POST arrives so. */
const emptyBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {},
} as const;

interface IdParams {
  id: string;
}
interface WorkflowListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  scope?: AgentWorkflowScope;
  projectId?: string;
  includeArchived?: boolean;
}
interface StepBody {
  agentId: string;
  instructions?: string | null;
}
interface CreateWorkflowBody {
  name: string;
  description?: string | null;
  scope: AgentWorkflowScope;
  projectId?: string | null;
  steps: StepBody[];
}
interface UpdateWorkflowBody {
  name?: string;
  description?: string | null;
  steps?: StepBody[];
  archived?: boolean;
}
interface RunListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  workflowId?: string;
  projectId?: string;
  state?: AgentWorkflowRunState;
}
interface CreateRunBody {
  workflowId: string;
  projectId: string;
  task: string;
  workingDirectory: string;
  repositoryId?: string;
  branch?: string;
  model?: string;
  maxSessions?: number;
}

/** See `sessions/routes.ts` for what a `response` block is and is not (it never strips). */
const workflowResponse = dataEnvelopeSchema(agentWorkflowSchema);
const runResponse = dataEnvelopeSchema(agentWorkflowRunSchema);

export interface AgentWorkflowRoutesOptions {
  readonly workflows: AgentWorkflowService;
  readonly runs: AgentWorkflowRunService;
}

export function registerAgentWorkflowRoutes(
  app: FastifyInstance,
  options: AgentWorkflowRoutesOptions,
): void {
  const { workflows, runs } = options;

  // ------------------------------------------------------------------------------ definitions

  app.get<{ Querystring: WorkflowListQuery }>(
    '/api/v1/agent-workflows',
    {
      schema: {
        querystring: workflowListQuerySchema,
        response: { 200: listEnvelopeSchema(agentWorkflowSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const order = request.query.order ?? 'asc';

      const rows = await workflows.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        ...(request.query.scope === undefined ? {} : { scope: request.query.scope }),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
        ...(request.query.includeArchived === undefined
          ? {}
          : { includeArchived: request.query.includeArchived }),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateWorkflowBody }>(
    '/api/v1/agent-workflows',
    { schema: { body: createWorkflowBodySchema, response: { 201: workflowResponse } } },
    async (request, reply) => {
      const body = request.body;
      const created = await workflows.create(
        requirePrincipal(request),
        {
          name: body.name,
          scope: body.scope,
          steps: body.steps,
          ...('description' in body ? { description: body.description } : {}),
          ...('projectId' in body ? { projectId: body.projectId } : {}),
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/agent-workflows/:id',
    { schema: { params: idParamsSchema, response: { 200: workflowResponse } } },
    async (request) => dataEnvelope(await workflows.get(request.params.id)),
  );

  app.patch<{ Params: IdParams; Body: UpdateWorkflowBody }>(
    '/api/v1/agent-workflows/:id',
    {
      schema: {
        params: idParamsSchema,
        body: updateWorkflowBodySchema,
        response: { 200: workflowResponse },
      },
    },
    async (request) => {
      const body = request.body;
      const updated = await workflows.update(
        requirePrincipal(request),
        request.params.id,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...('description' in body ? { description: body.description } : {}),
          ...(body.steps === undefined ? {} : { steps: body.steps }),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        },
        requestContextOf(request),
      );

      return dataEnvelope(updated);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/agent-workflows/:id/cost-estimate',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: dataEnvelopeSchema(workflowCostEstimateSchema) },
      },
    },
    async (request) => dataEnvelope(await workflows.costEstimate(request.params.id)),
  );

  // ------------------------------------------------------------------------------------- runs

  app.get<{ Querystring: RunListQuery }>(
    '/api/v1/agent-workflow-runs',
    {
      schema: {
        querystring: runListQuerySchema,
        response: { 200: listEnvelopeSchema(agentWorkflowRunSchema) },
      },
    },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const order = request.query.order ?? 'desc';

      const rows = await runs.list({
        limit,
        order,
        afterId: decodeIdCursor(request.query.cursor),
        ...(request.query.workflowId === undefined ? {} : { workflowId: request.query.workflowId }),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
        ...(request.query.state === undefined ? {} : { state: request.query.state }),
      });

      return paginate(rows, limit, (row) => row.id);
    },
  );

  app.post<{ Body: CreateRunBody }>(
    '/api/v1/agent-workflow-runs',
    { schema: { body: createRunBodySchema, response: { 201: runResponse } } },
    async (request, reply) => {
      const body = request.body;
      const created = await runs.create(
        requirePrincipal(request),
        {
          workflowId: body.workflowId,
          projectId: body.projectId,
          task: body.task,
          workingDirectory: body.workingDirectory,
          ...(body.repositoryId === undefined ? {} : { repositoryId: body.repositoryId }),
          ...(body.branch === undefined ? {} : { branch: body.branch }),
          ...(body.model === undefined ? {} : { model: body.model }),
          ...(body.maxSessions === undefined ? {} : { maxSessions: body.maxSessions }),
        },
        requestContextOf(request),
      );

      reply.code(201);
      return dataEnvelope(created);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/agent-workflow-runs/:id',
    { schema: { params: idParamsSchema, response: { 200: runResponse } } },
    async (request) => dataEnvelope(await runs.get(request.params.id)),
  );

  /**
   * The response carries `meta.stoppedSession` because "the run is stopped" and "the Claude Code
   * session it launched is stopped" are two different facts, and the operator pressing Stop is
   * asking about the second one. `cancelled` is the case worth naming: the step's launch was still
   * waiting for a concurrency slot, so no process ever started and none now will — the Session is
   * `failed(cancelled)` and its queued launch is dead. It read `left_unstarted` until the launch
   * became revocable, which was a name for the Stop not covering it.
   */
  app.post<{ Params: IdParams; Body: null }>(
    '/api/v1/agent-workflow-runs/:id/stop',
    {
      schema: {
        params: idParamsSchema,
        body: emptyBodySchema,
        response: { 200: dataWithMetaSchema(agentWorkflowRunSchema, stoppedSessionMetaSchema) },
      },
    },
    async (request) => {
      const result = await runs.stop(
        requirePrincipal(request),
        request.params.id,
        requestContextOf(request),
      );
      return { data: result.run, meta: { stoppedSession: result.stoppedSession } };
    },
  );

  app.post<{ Params: IdParams; Body: null }>(
    '/api/v1/agent-workflow-runs/:id/resume',
    {
      schema: {
        params: idParamsSchema,
        body: emptyBodySchema,
        response: { 200: runResponse },
      },
    },
    async (request) =>
      dataEnvelope(
        await runs.resume(requirePrincipal(request), request.params.id, requestContextOf(request)),
      ),
  );
}
