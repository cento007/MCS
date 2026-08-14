import { type AgentWorkflowScope, type Db, defaultAgentWorkflowRunSessions } from '@mc/shared';
import { recordAuditEntry } from '../../audit/index.js';
import type { Principal } from '../../auth/index.js';
import { isUniqueViolation } from '../../db/index.js';
import type { Outbox } from '../../events/index.js';
import type { RequestContext } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { readCostBudget } from '../../settings/claude-code.js';
import { DEFAULT_TIMEZONE, readTimezone } from '../../settings/general.js';
import { isInvalidTimezoneError, readSpendAggregate } from '../../spend/index.js';
import { projectExists } from '../store.js';
import { findAgentsByIds } from '../teams/store.js';
import { buildCostEstimate, type WorkflowCostEstimate } from './estimate.js';
import { type AgentWorkflowResource, serializeWorkflow } from './serialize.js';
import {
  type AgentWorkflowRow,
  type AgentWorkflowUpdate,
  findActiveRunsForWorkflow,
  findWorkflowById,
  insertWorkflow,
  listWorkflowSteps,
  listWorkflows,
  readAgentCostHistory,
  replaceWorkflowSteps,
  type StepInput,
  touchWorkflow,
  updateWorkflow,
} from './store.js';
import {
  assertStepCount,
  assertWorkflowScopeTarget,
  normalizeStepInstructions,
  normalizeWorkflowDescription,
  normalizeWorkflowName,
} from './validation.js';

/**
 * The AgentWorkflow **definition** service — PRD §5.6's `Developer → QA → Security → Architect`,
 * as something an operator can write down. Running it is `runs.ts`.
 *
 * Five decisions this file makes, each of them deliberately:
 *
 * 1. **Scope is immutable**, exactly as an Agent's and a team's are. Moving a project chain to
 *    another project would retroactively invalidate every project-scoped step it holds.
 * 2. **`steps` is replace-the-whole-chain.** A `PATCH` carrying `steps` says "this is the chain";
 *    omitting the field leaves it alone. Order is the value, so there is no add/remove pair that
 *    could express a reorder without a second concept (an "insert before" index) that nothing
 *    would use.
 * 3. **A chain cannot be edited while a run of it is in flight.** `409`, naming the run. The
 *    alternative is worse than it looks: a run reads the definition when it advances, so an edit
 *    mid-flight would change which agent step 3 runs as *after* the operator saw the estimate and
 *    said yes. `step_count` is snapshotted on the run for the same reason, so history is safe
 *    either way — this rule protects the operator's *consent*, not the data.
 * 4. **Archive, never delete** (`store.ts` has no delete function). `agent_workflow_runs.
 *    workflow_id` is history in exactly the way `sessions.agent_id` is, so erasing a workflow
 *    would rewrite what a run executed. This is the Agent rule, not the team rule, and the
 *    difference is which side is history: nothing points at a *team* as history, which is why
 *    that one is deleted.
 * 5. **`agent_workflow.created` / `.updated` go through the outbox**, in the same transaction as
 *    the rows (F6.3).
 */

export interface WorkflowStepInput {
  readonly agentId: string;
  readonly instructions?: string | null | undefined;
}

export interface CreateWorkflowInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly scope: AgentWorkflowScope;
  readonly projectId?: string | null | undefined;
  readonly steps: readonly WorkflowStepInput[];
}

export interface UpdateWorkflowInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly steps?: readonly WorkflowStepInput[] | undefined;
  readonly archived?: boolean | undefined;
}

export interface ListWorkflowsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly scope?: AgentWorkflowScope | undefined;
  readonly projectId?: string | undefined;
  readonly includeArchived?: boolean | undefined;
}

export interface AgentWorkflowServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly onTimezoneRejected?: ((timezone: string, error: unknown) => void) | undefined;
}

export class AgentWorkflowService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #onTimezoneRejected: ((timezone: string, error: unknown) => void) | undefined;

  constructor(options: AgentWorkflowServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#onTimezoneRejected = options.onTimezoneRejected;
  }

  /** `GET /api/v1/agent-workflows` — cursor list; `?scope=`, `?projectId=`, `?includeArchived=`. */
  async list(input: ListWorkflowsApiInput): Promise<AgentWorkflowResource[]> {
    const rows = await listWorkflows(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
    });
    return this.#hydrate(rows);
  }

  /** `GET /api/v1/agent-workflows/{id}`. Archived workflows are readable — history, not offers. */
  async get(id: string): Promise<AgentWorkflowResource> {
    const [resource] = await this.#hydrate([await this.require(id)]);
    /* c8 ignore next */
    if (resource === undefined) throw new ApiError('NOT_FOUND', `No agent workflow with id ${id}`);
    return resource;
  }

  /** `POST /api/v1/agent-workflows` -> `201`. */
  async create(
    principal: Principal,
    input: CreateWorkflowInput,
    ctx: RequestContext,
  ): Promise<AgentWorkflowResource> {
    const name = normalizeWorkflowName(input.name);
    const description = normalizeWorkflowDescription(input.description);
    const projectId = input.projectId ?? null;

    assertWorkflowScopeTarget({ scope: input.scope, projectId });
    assertStepCount(input.steps.length);

    if (projectId !== null && !(await projectExists(this.#db, projectId))) {
      throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
        field: 'projectId',
      });
    }

    const steps = await this.#resolveSteps({ scope: input.scope, projectId }, input.steps);

    const created = await this.#outbox
      .run(async (tx) => {
        const workflow = await insertWorkflow(tx.tx, {
          name,
          description,
          scope: input.scope,
          projectId,
        });

        await replaceWorkflowSteps(tx.tx, workflow, steps);

        await tx.emit(
          this.#outbox.event(
            'agent_workflow.created',
            {
              workflowId: workflow.id,
              scope: workflow.scope,
              projectId,
              stepCount: steps.length,
            },
            { correlationId: workflow.id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'agent_workflow.created',
          entityType: 'agent_workflows',
          entityId: workflow.id,
          after: {
            name: workflow.name,
            scope: workflow.scope,
            projectId,
            steps: steps.map((step) => step.agent.id),
          },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return workflow;
      })
      .catch((error: unknown) => {
        throw asDuplicateName(error, name, input.scope);
      });

    return this.get(created.id);
  }

  /** `PATCH /api/v1/agent-workflows/{id}` — name, description, the chain, and archive. */
  async update(
    principal: Principal,
    id: string,
    input: UpdateWorkflowInput,
    ctx: RequestContext,
  ): Promise<AgentWorkflowResource> {
    const existing = await this.require(id);

    const fieldChanges: AgentWorkflowUpdate = {
      ...(input.name === undefined ? {} : { name: normalizeWorkflowName(input.name) }),
      ...('description' in input
        ? { description: normalizeWorkflowDescription(input.description) }
        : {}),
      ...(input.archived === undefined
        ? {}
        : { archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null }),
    };

    if (Object.keys(fieldChanges).length === 0 && input.steps === undefined) {
      return this.get(id);
    }

    // Decision 3. Checked for **any** structural change, including archive: retiring a chain that
    // a run is still walking would leave the run pointing at something the operator believes is
    // retired, which is a different kind of lie but the same one.
    await this.#assertNoActiveRun(id, 'edited');

    const requestedSteps = input.steps;
    const steps =
      requestedSteps === undefined
        ? null
        : await (async () => {
            assertStepCount(requestedSteps.length);
            return this.#resolveSteps(
              { scope: existing.scope as AgentWorkflowScope, projectId: existing.projectId },
              requestedSteps,
            );
          })();

    const before = await this.#snapshot(existing);
    const changedFields = [...Object.keys(fieldChanges), ...(steps === null ? [] : ['steps'])];

    await this.#outbox
      .run(async (tx) => {
        const updated =
          Object.keys(fieldChanges).length === 0
            ? // A chain change is still a change to the workflow: `updated_at` moves so a client
              // polling the document sees it.
              await touchWorkflow(tx.tx, id)
            : await updateWorkflow(tx.tx, id, fieldChanges);
        /* c8 ignore next */
        if (updated === null) throw new ApiError('NOT_FOUND', `No agent workflow with id ${id}`);

        if (steps !== null) await replaceWorkflowSteps(tx.tx, updated, steps);

        await tx.emit(
          this.#outbox.event(
            'agent_workflow.updated',
            { workflowId: id, changedFields, archived: updated.archivedAt !== null },
            { correlationId: id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'agent_workflow.updated',
          entityType: 'agent_workflows',
          entityId: id,
          before: auditView(before, changedFields),
          after: auditView(
            {
              name: updated.name,
              description: updated.description,
              archivedAt: updated.archivedAt?.toISOString() ?? null,
              steps: (steps ?? []).map((step) => step.agent.id),
            },
            changedFields,
          ),
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });
      })
      .catch((error: unknown) => {
        throw asDuplicateName(
          error,
          fieldChanges.name ?? existing.name,
          existing.scope as AgentWorkflowScope,
        );
      });

    return this.get(id);
  }

  /**
   * `GET /api/v1/agent-workflows/{id}/cost-estimate` — a bounded read model, no pagination and no
   * `meta` (§1.2), like `/spend` and `/services/health`.
   *
   * See `estimate.ts` for why this is history rather than a forecast, and why an unmeasured step
   * reports `null` instead of a plausible number.
   */
  async costEstimate(id: string): Promise<WorkflowCostEstimate> {
    const workflow = await this.require(id);
    const steps = await listWorkflowSteps(this.#db, [workflow.id]);

    const [history, budget, timezone] = await Promise.all([
      readAgentCostHistory(
        this.#db,
        steps.map((step) => step.agentId),
      ),
      readCostBudget(this.#db),
      readTimezone(this.#db),
    ]);

    const spentTodayUsd = await this.#spentToday(timezone);

    return buildCostEstimate({
      workflowId: workflow.id,
      steps,
      history,
      defaultMaxSessions: defaultAgentWorkflowRunSessions(Math.max(steps.length, 1)),
      budget,
      spentTodayUsd,
    });
  }

  /** Shared with `runs.ts`, which needs the row rather than the resource. */
  async require(id: string): Promise<AgentWorkflowRow> {
    const row = await findWorkflowById(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No agent workflow with id ${id}`);
    return row;
  }

  // -------------------------------------------------------------------------------- internals

  async #hydrate(rows: readonly AgentWorkflowRow[]): Promise<AgentWorkflowResource[]> {
    if (rows.length === 0) return [];
    const steps = await listWorkflowSteps(
      this.#db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => serializeWorkflow(row, steps));
  }

  async #snapshot(workflow: AgentWorkflowRow): Promise<{
    readonly name: string;
    readonly description: string | null;
    readonly archivedAt: string | null;
    readonly steps: string[];
  }> {
    const steps = await listWorkflowSteps(this.#db, [workflow.id]);
    return {
      name: workflow.name,
      description: workflow.description,
      archivedAt: workflow.archivedAt?.toISOString() ?? null,
      steps: steps.map((step) => step.agentId),
    };
  }

  /**
   * Turn `steps[]` into agent rows in order, refusing every one the chain may not hold.
   *
   * The database refuses these combinations too (`ck_agent_workflow_steps_agent_scope` and the
   * composite FKs), so this method's job — like `assertScopeTarget`'s — is *the error message*.
   * The four refusals are the team service's four, verbatim and for the same reasons, with one
   * difference: **a repeated agent is not an error here.** `Developer → QA → Developer` is a
   * legitimate chain and the table has no unique index that would stop it.
   */
  async #resolveSteps(
    workflow: { readonly scope: AgentWorkflowScope; readonly projectId: string | null },
    steps: readonly WorkflowStepInput[],
  ): Promise<StepInput[]> {
    if (steps.length === 0) return [];

    const rows = await findAgentsByIds(
      this.#db,
      steps.map((step) => step.agentId),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    return steps.map((step, index) => {
      const agent = byId.get(step.agentId);
      if (agent === undefined) {
        throw new ApiError('VALIDATION_FAILED', 'steps names an Agent that does not exist', {
          field: 'steps',
          index,
          agentId: step.agentId,
        });
      }
      if (agent.scope === 'session') {
        throw new ApiError(
          'VALIDATION_FAILED',
          'A session-scoped agent belongs to one conversation and cannot be a workflow step',
          { field: 'steps', index, agentId: agent.id, scope: agent.scope },
        );
      }
      if (agent.scope === 'project' && agent.projectId !== workflow.projectId) {
        throw new ApiError(
          'VALIDATION_FAILED',
          workflow.scope === 'global'
            ? 'A global workflow may only use global agents; this one is scoped to a project'
            : 'This agent is scoped to a different project than the workflow',
          {
            field: 'steps',
            index,
            agentId: agent.id,
            scope: agent.scope,
            agentProjectId: agent.projectId,
            workflowProjectId: workflow.projectId,
          },
        );
      }
      if (agent.archivedAt !== null) {
        throw new ApiError(
          'CONFLICT',
          'This agent is archived and cannot be added to a workflow; un-archive it first',
          { field: 'steps', index, agentId: agent.id },
        );
      }

      return { agent, instructions: normalizeStepInstructions(step.instructions) } as StepInput;
    });
  }

  async #assertNoActiveRun(workflowId: string, verb: string): Promise<void> {
    const active = await findActiveRunsForWorkflow(this.#db, workflowId);
    const run = active[0];
    if (run === undefined) return;

    throw new ApiError(
      'CONFLICT',
      `This workflow has a ${run.state} run and cannot be ${verb} until it is stopped or finished`,
      { runId: run.id, runState: run.state },
    );
  }

  /**
   * Today's spend in the operator's own timezone — the same statement `GET /spend` runs, so the
   * two documents cannot disagree about the number an operator is about to be measured against.
   *
   * A stored zone PostgreSQL rejects falls back to UTC rather than failing the estimate, exactly
   * as §7.8 specifies for the endpoint this borrows from.
   */
  async #spentToday(timezone: string): Promise<number> {
    try {
      const aggregate = await readSpendAggregate(this.#db, timezone);
      return aggregate.day.totalCostUsd;
    } catch (error) {
      if (!isInvalidTimezoneError(error)) throw error;
      this.#onTimezoneRejected?.(timezone, error);
      const aggregate = await readSpendAggregate(this.#db, DEFAULT_TIMEZONE);
      return aggregate.day.totalCostUsd;
    }
  }
}

/**
 * `ux_agent_workflows_*_name` is partial on `archived_at IS NULL`, so this fires only against a
 * *live* workflow of the same name in the same scope — a `CONFLICT` the operator can act on, not
 * a 500. Identical in shape to `agents/service.ts`'s, and identical for the same reason.
 */
function asDuplicateName(error: unknown, name: string, scope: AgentWorkflowScope): unknown {
  for (const index of ['ux_agent_workflows_global_name', 'ux_agent_workflows_project_name']) {
    if (isUniqueViolation(error, index)) {
      return new ApiError(
        'CONFLICT',
        `A workflow named "${name}" already exists in this ${scope}`,
        {
          field: 'name',
          scope,
        },
      );
    }
  }
  return error;
}

/** Only the fields this request touched, so the audit diff is a diff (TDS 03 §3.14). */
function auditView(
  snapshot: {
    readonly name: string;
    readonly description: string | null;
    readonly archivedAt: string | null;
    readonly steps: readonly string[];
  },
  fields: readonly string[],
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  if (fields.includes('name')) view['name'] = snapshot.name;
  if (fields.includes('description')) view['description'] = snapshot.description;
  if (fields.includes('archivedAt')) view['archivedAt'] = snapshot.archivedAt;
  if (fields.includes('steps')) view['steps'] = [...snapshot.steps];
  return view;
}
