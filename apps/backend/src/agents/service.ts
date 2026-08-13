import {
  type AgentPermissions,
  type AgentRuntime,
  type AgentScope,
  agentPermissionsFromTemplate,
  type Db,
} from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import { isUniqueViolation } from '../db/index.js';
import type { Outbox } from '../events/index.js';
import type { RequestContext } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { readDefaultPermissionTemplate } from '../settings/agents.js';
import { type AgentResource, serializeAgent } from './serialize.js';
import {
  type AgentRow,
  type AgentUpdate,
  findAgentById,
  insertAgent,
  listAgents,
  projectExists,
  sessionExists,
  updateAgent,
} from './store.js';
import {
  assertScopeTarget,
  normalizeAgentDescription,
  normalizeAgentInstructions,
  normalizeAgentName,
  normalizeRequestedPermissions,
} from './validation.js';

/**
 * The Agent domain service — TDS 04 §13.2's reserved routes, now built.
 *
 * Four things this file decides, each of them deliberately:
 *
 * 1. **Scope is immutable.** `PATCH` cannot change `scope`, `projectId` or `sessionId`. Moving a
 *    project agent to another project would silently change which Sessions may use it, including
 *    Sessions that already ran as it — the record would then describe a persona that never
 *    applied there. Retire it and create the one you meant.
 * 2. **Archive, never delete** (§13.2 lists no DELETE, and this agrees with it for a reason).
 *    `PATCH { archived: true }` sets `archived_at`; `false` clears it. Reversible, idempotent, and
 *    inside the reserved route set — a `POST /agents/{id}/archive` sub-action would be the F5.1
 *    idiom for a *state machine*, and an Agent does not have one.
 * 3. **Permissions default from settings**, not from a constant: `agents.defaultPermissionTemplate`
 *    is read on every create that omits them, which is the only reason that setting exists.
 * 4. **`agent.created` / `agent.updated` go through the outbox**, in the same transaction as the
 *    row (F6.3). The other four §15.4 names stay unproduced.
 */

export interface CreateAgentInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly scope: AgentScope;
  readonly projectId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
  readonly runtime?: AgentRuntime | undefined;
  /** Omitted -> `settings.agents.defaultPermissionTemplate`. */
  readonly permissions?: unknown;
  readonly instructions?: string | null | undefined;
}

export interface UpdateAgentInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly runtime?: AgentRuntime | undefined;
  readonly permissions?: unknown;
  readonly instructions?: string | null | undefined;
  /** `true` retires the agent, `false` brings it back. See the header. */
  readonly archived?: boolean | undefined;
}

export interface ListAgentsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly scope?: AgentScope | undefined;
  readonly projectId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly includeArchived?: boolean | undefined;
}

export interface AgentServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
}

export class AgentService {
  readonly #db: Db;
  readonly #outbox: Outbox;

  constructor(options: AgentServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
  }

  /**
   * `GET /api/v1/agents` — cursor list; `?scope=`, `?projectId=`, `?sessionId=`,
   * `?includeArchived=`.
   *
   * Archived agents are **excluded by default**. An archived agent cannot be bound to a new
   * Session, so listing it beside usable ones would offer the operator a choice that then fails;
   * `includeArchived=true` is how the history is read back.
   */
  async list(input: ListAgentsApiInput): Promise<AgentResource[]> {
    const rows = await listAgents(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
    });
    return rows.map(serializeAgent);
  }

  /** `GET /api/v1/agents/{id}`. Archived agents are readable — history, not offers. */
  async get(id: string): Promise<AgentResource> {
    return serializeAgent(await this.require(id));
  }

  /** `POST /api/v1/agents` -> `201`. */
  async create(
    principal: Principal,
    input: CreateAgentInput,
    ctx: RequestContext,
  ): Promise<AgentResource> {
    const name = normalizeAgentName(input.name);
    const description = normalizeAgentDescription(input.description);
    const instructions = normalizeAgentInstructions(input.instructions);
    const projectId = input.projectId ?? null;
    const sessionId = input.sessionId ?? null;

    assertScopeTarget({ scope: input.scope, projectId, sessionId });

    if (projectId !== null && !(await projectExists(this.#db, projectId))) {
      throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
        field: 'projectId',
      });
    }
    if (sessionId !== null && !(await sessionExists(this.#db, sessionId))) {
      throw new ApiError('VALIDATION_FAILED', 'sessionId does not reference a known Session', {
        field: 'sessionId',
      });
    }

    const permissions = await this.#permissionsFor(input.permissions);

    let row: AgentRow;
    try {
      row = await this.#outbox.run(async (tx) => {
        const created = await insertAgent(tx.tx, {
          name,
          description,
          scope: input.scope,
          projectId,
          sessionId,
          runtime: input.runtime ?? 'claude_code',
          permissions,
          instructions,
        });

        await tx.emit(
          this.#outbox.event(
            'agent.created',
            { agentId: created.id, scope: created.scope, projectId, sessionId },
            { correlationId: created.id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'agent.created',
          entityType: 'agents',
          entityId: created.id,
          // The permission document is the security-relevant fact about an agent, so it is in
          // the audit trail verbatim. It holds no secret material — three booleans.
          after: {
            name: created.name,
            scope: created.scope,
            projectId,
            sessionId,
            runtime: created.runtime,
            permissions,
          },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return created;
      });
    } catch (error) {
      throw asDuplicateName(error, name, input.scope);
    }

    return serializeAgent(row);
  }

  /** `PATCH /api/v1/agents/{id}` — fields, permissions, and archive/unarchive. */
  async update(
    principal: Principal,
    id: string,
    input: UpdateAgentInput,
    ctx: RequestContext,
  ): Promise<AgentResource> {
    const existing = await this.require(id);

    const changes: AgentUpdate = {
      ...(input.name === undefined ? {} : { name: normalizeAgentName(input.name) }),
      ...('description' in input
        ? { description: normalizeAgentDescription(input.description) }
        : {}),
      ...('instructions' in input
        ? { instructions: normalizeAgentInstructions(input.instructions) }
        : {}),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.permissions === undefined
        ? {}
        : { permissions: normalizeRequestedPermissions(input.permissions) }),
      ...(input.archived === undefined
        ? {}
        : { archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null }),
    };

    if (Object.keys(changes).length === 0) return serializeAgent(existing);

    const changedFields = Object.keys(changes);

    let row: AgentRow;
    try {
      row = await this.#outbox.run(async (tx) => {
        const updated = await updateAgent(tx.tx, id, changes);
        /* c8 ignore next */
        if (updated === null) throw new ApiError('NOT_FOUND', `No agent with id ${id}`);

        await tx.emit(
          this.#outbox.event(
            'agent.updated',
            { agentId: id, changedFields, archived: updated.archivedAt !== null },
            { correlationId: id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'agent.updated',
          entityType: 'agents',
          entityId: id,
          before: fieldSubset(existing, changedFields),
          after: fieldSubset(updated, changedFields),
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return updated;
      });
    } catch (error) {
      throw asDuplicateName(error, changes.name ?? existing.name, existing.scope as AgentScope);
    }

    return serializeAgent(row);
  }

  /** Shared with `binding.ts`, which needs the row rather than the resource. */
  async require(id: string): Promise<AgentRow> {
    const row = await findAgentById(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No agent with id ${id}`);
    return row;
  }

  /**
   * The requested permissions, or the install's default template.
   *
   * This is the whole justification for `settings.agents.defaultPermissionTemplate`: it is read
   * here, on the create path, and the value it supplies goes on to decide which tools the agent's
   * sessions lose. Nothing else reads it, and if this call were removed the setting would have to
   * go with it.
   */
  async #permissionsFor(requested: unknown): Promise<AgentPermissions> {
    if (requested !== undefined) return normalizeRequestedPermissions(requested);
    return agentPermissionsFromTemplate(await readDefaultPermissionTemplate(this.#db));
  }
}

/**
 * `ux_agents_*_name` is partial on `archived_at IS NULL`, so this fires only against a *live*
 * agent of the same name in the same scope — which is a `CONFLICT` the operator can act on
 * ("archive the old one, or pick another name"), not a 500.
 */
function asDuplicateName(error: unknown, name: string, scope: AgentScope): unknown {
  for (const index of ['ux_agents_global_name', 'ux_agents_project_name', 'ux_agents_session_name'])
    if (isUniqueViolation(error, index)) {
      return new ApiError('CONFLICT', `An agent named "${name}" already exists in this ${scope}`, {
        field: 'name',
        scope,
      });
    }
  return error;
}

/** Only the fields this request touched, so the audit diff is a diff (TDS 03 §3.14). */
function fieldSubset(row: AgentRow, fields: readonly string[]): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    view[field] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  return view;
}
