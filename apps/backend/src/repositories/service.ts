import type { Db } from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import { isUniqueViolation } from '../db/index.js';
import type { Outbox } from '../events/index.js';
import type { RequestContext } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { type GitOptions, probeWorkingTree } from './git.js';
import {
  type RepositoryResource,
  type RepositoryStatusReadModel,
  serializeRepository,
  serializeRepositoryStatus,
} from './serialize.js';
import {
  countRepositorySessions,
  deleteRepository,
  findRepositoryById,
  findRepositoryByLocalPath,
  insertRepository,
  listRepositories,
  projectExists,
  type RepositoryRow,
  updateRepository,
} from './store.js';
import {
  assertGitWorkingTree,
  deriveRepositoryName,
  normalizeBranch,
  normalizeLocalPath,
  normalizeRepositoryName,
} from './validation.js';

/**
 * The Repository domain service — TDS 04 §5.1.
 *
 * **Phase 1 registers a Repository by local path and touches no remote.** `sync_status` starts
 * at `never` and stays there: nothing in this file calls GitHub, computes a commit, or writes
 * `last_synced_at`. `POST /repositories/discover` and `POST /repositories/{id}/sync` (§5.1) are
 * therefore deliberately absent rather than stubbed — an endpoint that answers `202` for a job
 * nobody will run is worse than one that is honestly missing, and the same rule already governs
 * `sessions/routes.ts`.
 */

export interface RegisterRepositoryInput {
  readonly localPath: string;
  readonly name?: string | undefined;
  readonly projectId?: string | null | undefined;
  readonly defaultBranch?: string | undefined;
}

export interface UpdateRepositoryApiInput {
  readonly projectId?: string | null | undefined;
  readonly name?: string | undefined;
  readonly defaultBranch?: string | undefined;
}

export interface ListRepositoriesApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly projectId?: string | undefined;
}

export interface RepositoryServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  /** Executable + timeout for every git invocation this service makes. */
  readonly git?: GitOptions | undefined;
  /** Injectable clock so `checkedAt` is deterministic in tests. */
  readonly now?: (() => Date) | undefined;
}

export class RepositoryService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #git: GitOptions;
  readonly #now: () => Date;

  constructor(options: RepositoryServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#git = options.git ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  /** `GET /api/v1/repositories` — cursor list; `?projectId=` filter (§5.1). */
  async list(input: ListRepositoriesApiInput): Promise<RepositoryResource[]> {
    const rows = await listRepositories(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
    return rows.map(serializeRepository);
  }

  /** `GET /api/v1/repositories/{id}`. */
  async get(id: string): Promise<RepositoryResource> {
    return serializeRepository(await this.#require(id));
  }

  /**
   * `POST /api/v1/repositories` -> `201` — register an existing working tree by local path.
   *
   * ⚠ **Not in TDS 04 §5.1 — flagged, not silently invented.** The contract gives Repositories
   * a list, a fetch, a `projectId` PATCH, `/discover` and `/sync`, and no way to create one:
   * every Repository is assumed to arrive through discovery, which scans roots configured in
   * Settings — and the settings service does not exist yet. Without this endpoint no Repository
   * can exist at all in Phase 1, so the launch modal's Repository picker is permanently empty.
   *
   * Emits `repository.discovered` (§15.2 #13, payload `{ repositoryId }`, channel
   * `repositories`). That is the catalog's only "a Repository now exists" event and F6's
   * vocabulary is not ours to extend; a manual registration and a scan both make the same fact
   * true, and the UI needs to refresh for both.
   */
  async register(
    principal: Principal,
    input: RegisterRepositoryInput,
    ctx: RequestContext,
  ): Promise<RepositoryResource> {
    const localPath = normalizeLocalPath(input.localPath);
    const name =
      input.name === undefined
        ? deriveRepositoryName(localPath)
        : normalizeRepositoryName(input.name);
    const defaultBranch =
      input.defaultBranch === undefined ? undefined : normalizeBranch(input.defaultBranch);
    const projectId = input.projectId ?? null;

    if (projectId !== null) await this.#assertProjectExists(projectId);

    // Before anything is written: the path has to be a real git working tree on this machine.
    await assertGitWorkingTree(localPath, this.#git);

    const duplicate = await findRepositoryByLocalPath(this.#db, localPath);
    if (duplicate !== null) throw pathConflict(localPath, duplicate.id);

    const row = await this.#outbox
      .run(async (outboxTx) => {
        const repository = await insertRepository(outboxTx.tx, {
          projectId,
          name,
          localPath,
          ...(defaultBranch === undefined ? {} : { defaultBranch }),
        });

        await outboxTx.emit(
          this.#outbox.event(
            'repository.discovered',
            { repositoryId: repository.id },
            { correlationId: repository.id },
          ),
        );

        await recordAuditEntry(outboxTx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'repository.registered',
          entityType: 'repositories',
          entityId: repository.id,
          after: {
            name: repository.name,
            localPath: repository.localPath,
            projectId: repository.projectId,
          },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return repository;
      })
      .catch((error: unknown) => {
        // The pre-check is not atomic; `ux_repositories_local_path` is what actually decides.
        if (isUniqueViolation(error, 'ux_repositories_local_path')) {
          throw pathConflict(localPath, null);
        }
        throw error;
      });

    return serializeRepository(row);
  }

  /**
   * `PATCH /api/v1/repositories/{id}` — `{ projectId }` per §5.1, plus `name` and
   * `defaultBranch`.
   *
   * ⚠ The two extra fields are **additive to §5.1 — flagged.** They exist because
   * registration is manual (see `register`): a repository named from its directory, or
   * defaulted to `main` because Phase 1 asks no remote what its default branch is, otherwise
   * has no correction path short of delete-and-re-register.
   *
   * `projectId: null` **unassigns** the Repository, which is the state discovery leaves it in
   * (TDS 03 §3.6: "NULL = discovered, unassigned").
   */
  async update(
    principal: Principal,
    id: string,
    input: UpdateRepositoryApiInput,
    ctx: RequestContext,
  ): Promise<RepositoryResource> {
    const existing = await this.#require(id);

    const changes: { projectId?: string | null; name?: string; defaultBranch?: string } = {
      ...('projectId' in input ? { projectId: input.projectId ?? null } : {}),
      ...(input.name === undefined ? {} : { name: normalizeRepositoryName(input.name) }),
      ...(input.defaultBranch === undefined
        ? {}
        : { defaultBranch: normalizeBranch(input.defaultBranch) }),
    };

    if (Object.keys(changes).length === 0) return serializeRepository(existing);

    if (typeof changes.projectId === 'string') await this.#assertProjectExists(changes.projectId);

    const row = await this.#db.transaction(async (tx) => {
      const updated = await updateRepository(tx, id, changes);
      /* c8 ignore next */
      if (updated === null) throw new ApiError('NOT_FOUND', `No repository with id ${id}`);

      await recordAuditEntry(tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'repository.updated',
        entityType: 'repositories',
        entityId: id,
        before: auditView(existing, changes),
        after: auditView(updated, changes),
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });

      return updated;
    });

    return serializeRepository(row);
  }

  /**
   * `DELETE /api/v1/repositories/{id}` -> `204` — de-register. Nothing on disk is touched.
   *
   * ⚠ **Not in TDS 04 §5.1 — flagged** (same reasoning as `register`: a path registered by
   * hand can be registered by mistake).
   *
   * Refused with `CONFLICT` while any Session references the Repository. The FK is
   * `ON DELETE SET NULL` (TDS 03 §3.9), so the delete would *succeed* and quietly rewrite the
   * history of Sessions the operator never mentioned — their `repositoryId` would become
   * `null` and the Commits tab would lose its anchor. `commits` and `pull_requests` cascade,
   * which is correct: those rows are facts *about* the Repository and mean nothing without it.
   */
  async remove(principal: Principal, id: string, ctx: RequestContext): Promise<void> {
    const existing = await this.#require(id);

    const sessions = await countRepositorySessions(this.#db, id);
    if (sessions > 0) {
      throw new ApiError(
        'CONFLICT',
        'Repository is referenced by sessions; removing it would detach their history',
        { sessions },
      );
    }

    await this.#db.transaction(async (tx) => {
      const deleted = await deleteRepository(tx, id);
      /* c8 ignore next */
      if (!deleted) throw new ApiError('NOT_FOUND', `No repository with id ${id}`);

      await recordAuditEntry(tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'repository.removed',
        entityType: 'repositories',
        entityId: id,
        before: { name: existing.name, localPath: existing.localPath },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  /**
   * `GET /api/v1/repositories/{id}/status` — the working tree as it is right now.
   *
   * ⚠ **Not in TDS 04 — flagged.** WS5 §5.4.1 (WC11) makes the launch modal show the
   * repository's current branch and uncommitted-file count and warn when the selected branch
   * differs, "because launching a session can silently disrupt local work"; §5.1 exposes
   * `defaultBranch` and nothing else, so the modal today treats *every* launch as unverifiable
   * and forces the acknowledgement — training the operator to click through the one warning
   * that matters. This endpoint is the missing source.
   *
   * Failures are answers, not errors: a path that has been deleted, a directory that stopped
   * being a repository, or a machine with no git all return `200` with `unavailableReason` set.
   * A `404` here means the *Repository record* does not exist, which is the only thing this
   * route can honestly 404 on.
   */
  async status(id: string): Promise<RepositoryStatusReadModel> {
    const row = await this.#require(id);
    const status = await probeWorkingTree(row.localPath, this.#git);
    return serializeRepositoryStatus(row, status, this.#now());
  }

  async #require(id: string): Promise<RepositoryRow> {
    const repository = await findRepositoryById(this.#db, id);
    if (repository === null) throw new ApiError('NOT_FOUND', `No repository with id ${id}`);
    return repository;
  }

  async #assertProjectExists(projectId: string): Promise<void> {
    if (await projectExists(this.#db, projectId)) return;
    throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
      field: 'projectId',
    });
  }
}

function pathConflict(localPath: string, repositoryId: string | null): ApiError {
  return new ApiError('CONFLICT', 'That local path is already registered as a repository', {
    field: 'localPath',
    localPath,
    ...(repositoryId === null ? {} : { repositoryId }),
  });
}

/** Only the fields this request touched, so the audit diff is a diff (TDS 03 §3.14). */
function auditView(row: RepositoryRow, changes: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  if ('projectId' in changes) view['projectId'] = row.projectId;
  if ('name' in changes) view['name'] = row.name;
  if ('defaultBranch' in changes) view['defaultBranch'] = row.defaultBranch;
  return view;
}
