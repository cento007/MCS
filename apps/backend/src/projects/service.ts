import type { Db } from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import { isUniqueViolation } from '../db/index.js';
import type { RequestContext } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import {
  countProjectDependents,
  deleteProject,
  ensureDefaultWorkspace,
  findProjectById,
  findProjectByName,
  insertProject,
  listProjects,
  type ProjectRow,
  updateProject,
} from './repository.js';
import { type ProjectResource, serializeProject, type WorkflowMode } from './serialize.js';
import { normalizeDescription, normalizeProjectName, parseArchivedAt } from './validation.js';

/**
 * The Project domain service — TDS 04 §4, one method per contract row.
 *
 * **No F6 events.** The event catalog (§15.2) has no `project.*` type and §14.3 has no
 * `projects` WebSocket channel, so a Project mutation emits nothing: it writes an audit row
 * (TDS 03 §3.14) and that is the whole durable record. Inventing `project.created` here would
 * add vocabulary to F6, which WS-level work may not do (F9.5) — it is flagged to the contract
 * owners instead. That is also why this service takes a `Db` and not an `Outbox`: with nothing
 * to emit, there is nothing for the transactional outbox to make atomic.
 */

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly workflowMode?: WorkflowMode | null | undefined;
}

export interface UpdateProjectApiInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly workflowMode?: WorkflowMode | null | undefined;
  readonly archivedAt?: string | null | undefined;
}

export interface ListProjectsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly archived: boolean;
}

export class ProjectService {
  readonly #db: Db;

  constructor(options: { readonly db: Db }) {
    this.#db = options.db;
  }

  /** `GET /api/v1/projects` — cursor list; `?archived=false` by default (§4). */
  async list(input: ListProjectsApiInput): Promise<ProjectResource[]> {
    const rows = await listProjects(this.#db, {
      limit: input.limit,
      order: input.order,
      archived: input.archived,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
    });
    return rows.map(serializeProject);
  }

  /** `GET /api/v1/projects/{id}`. */
  async get(id: string): Promise<ProjectResource> {
    return serializeProject(await this.#require(id));
  }

  /** `POST /api/v1/projects` -> `201`. */
  async create(
    principal: Principal,
    input: CreateProjectInput,
    ctx: RequestContext,
  ): Promise<ProjectResource> {
    const name = normalizeProjectName(input.name);
    const description = normalizeDescription(input.description);
    const workflowMode = input.workflowMode ?? null;

    // The Workspace is resolved (and seeded on first use) outside the transaction below: it is
    // its own idempotent critical section and must not hold a lock across the Project insert.
    const workspaceId = await ensureDefaultWorkspace(this.#db);

    const existing = await findProjectByName(this.#db, workspaceId, name);
    if (existing !== null) throw nameConflict(name);

    const row = await this.#db
      .transaction(async (tx) => {
        const project = await insertProject(tx, {
          workspaceId,
          name,
          description,
          workflowMode,
        });

        await recordAuditEntry(tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'project.created',
          entityType: 'projects',
          entityId: project.id,
          after: { name: project.name, workflowMode: project.workflowMode },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return project;
      })
      .catch((error: unknown) => {
        // The pre-check above is not atomic; the unique index is what actually decides.
        if (isUniqueViolation(error, 'ux_projects_workspace_name')) throw nameConflict(name);
        throw error;
      });

    return serializeProject(row);
  }

  /**
   * `PATCH /api/v1/projects/{id}` — `{ name?, description?, archivedAt?, workflowMode? }`.
   *
   * `workflowMode: null` **clears the override** (back to inherit) rather than meaning "leave
   * it alone", which is why every field is tested with `in` rather than `!== undefined`:
   * "absent" and "explicitly null" are different requests here (§4).
   */
  async update(
    principal: Principal,
    id: string,
    input: UpdateProjectApiInput,
    ctx: RequestContext,
  ): Promise<ProjectResource> {
    const existing = await this.#require(id);

    const changes: {
      name?: string;
      description?: string | null;
      workflowMode?: WorkflowMode | null;
      archivedAt?: Date | null;
    } = {
      ...(input.name === undefined ? {} : { name: normalizeProjectName(input.name) }),
      ...('description' in input ? { description: normalizeDescription(input.description) } : {}),
      ...('workflowMode' in input ? { workflowMode: input.workflowMode ?? null } : {}),
      ...('archivedAt' in input ? { archivedAt: parseArchivedAt(input.archivedAt ?? null) } : {}),
    };

    if (Object.keys(changes).length === 0) return serializeProject(existing);

    if (changes.name !== undefined && changes.name.toLowerCase() !== existing.name.toLowerCase()) {
      const clash = await findProjectByName(this.#db, existing.workspaceId, changes.name);
      if (clash !== null) throw nameConflict(changes.name);
    }

    const row = await this.#db
      .transaction(async (tx) => {
        const updated = await updateProject(tx, id, changes);
        /* c8 ignore next */
        if (updated === null) throw new ApiError('NOT_FOUND', `No project with id ${id}`);

        await recordAuditEntry(tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: archiveAction(existing, updated) ?? 'project.updated',
          entityType: 'projects',
          entityId: id,
          before: auditView(existing, changes),
          after: auditView(updated, changes),
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return updated;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'ux_projects_workspace_name')) {
          throw nameConflict(changes.name ?? existing.name);
        }
        throw error;
      });

    return serializeProject(row);
  }

  /**
   * `DELETE /api/v1/projects/{id}` -> `204`; `CONFLICT` while anything still references it.
   *
   * Both dependents are refused, for different reasons: a Session's `project_id` is
   * `ON DELETE RESTRICT` (the database would refuse anyway, with a message no operator should
   * have to read), and a Repository's is `ON DELETE SET NULL` — which would *succeed*, quietly
   * unassigning repositories the operator never mentioned. Archiving is the non-destructive
   * path and the error message says so.
   */
  async remove(principal: Principal, id: string, ctx: RequestContext): Promise<void> {
    const existing = await this.#require(id);
    const dependents = await countProjectDependents(this.#db, id);

    if (dependents.sessions > 0 || dependents.repositories > 0) {
      throw new ApiError(
        'CONFLICT',
        'Project still has sessions or repositories; reassign them or archive the project instead',
        { sessions: dependents.sessions, repositories: dependents.repositories },
      );
    }

    await this.#db.transaction(async (tx) => {
      const deleted = await deleteProject(tx, id);
      /* c8 ignore next */
      if (!deleted) throw new ApiError('NOT_FOUND', `No project with id ${id}`);

      await recordAuditEntry(tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'project.deleted',
        entityType: 'projects',
        entityId: id,
        before: { name: existing.name, workflowMode: existing.workflowMode },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  async #require(id: string): Promise<ProjectRow> {
    const project = await findProjectById(this.#db, id);
    if (project === null) throw new ApiError('NOT_FOUND', `No project with id ${id}`);
    return project;
  }
}

function nameConflict(name: string): ApiError {
  return new ApiError('CONFLICT', `A project named '${name}' already exists`, { field: 'name' });
}

/** Archiving is worth its own audit action; renaming a description is not. */
function archiveAction(before: ProjectRow, after: ProjectRow): string | null {
  const wasArchived = before.archivedAt !== null;
  const isArchived = after.archivedAt !== null;
  if (wasArchived === isArchived) return null;
  return isArchived ? 'project.archived' : 'project.unarchived';
}

/** Only the fields this request touched, so the audit diff is a diff (TDS 03 §3.14). */
function auditView(row: ProjectRow, changes: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  if ('name' in changes) view['name'] = row.name;
  if ('description' in changes) view['description'] = row.description;
  if ('workflowMode' in changes) view['workflowMode'] = row.workflowMode;
  if ('archivedAt' in changes) view['archivedAt'] = row.archivedAt?.toISOString() ?? null;
  return view;
}
