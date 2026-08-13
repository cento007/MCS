import type { Db } from '@mc/shared';
import { ApiError } from '../http/errors.js';
import { findRepositoryById } from '../repositories/store.js';
import type { PullRequestCursor } from './cursors.js';
import {
  type PullRequestDetailResource,
  type PullRequestResource,
  serializePullRequest,
  serializePullRequestDetail,
} from './serialize.js';
import { findPullRequestById, listPullRequests } from './store.js';

/**
 * The PullRequest read model — TDS 04 §5.3.
 *
 * **Read-only, and structurally so** (§5.3: "there are therefore no write endpoints on
 * `pull-requests` in this contract"). The service holds a `Db` and nothing else — no outbox, no
 * queue, no GitHub client — so a Phase 2 assisted action cannot be bolted on here by accident;
 * it will arrive in `github/` where the credential already lives.
 */

export interface ListPullRequestsApiInput {
  readonly limit: number;
  readonly after?: PullRequestCursor | undefined;
  readonly repositoryId?: string | undefined;
  readonly state?: string | undefined;
}

export interface PullRequestServiceOptions {
  readonly db: Db;
}

export class PullRequestService {
  readonly #db: Db;

  constructor(options: PullRequestServiceOptions) {
    this.#db = options.db;
  }

  /** `GET /api/v1/pull-requests` — cursor list; `?repositoryId=`, `?state=` (§5.3). */
  async list(input: ListPullRequestsApiInput): Promise<PullRequestResource[]> {
    // A `?repositoryId=` naming nothing is a 404 here too: the filtered list and the nested
    // route ask the same question and must not answer it two different ways.
    if (input.repositoryId !== undefined) await this.#requireRepository(input.repositoryId);
    return this.#page(input);
  }

  /**
   * `GET /api/v1/repositories/{id}/pull-requests` — §5.3's "nested convenience list".
   *
   * `404` for an unknown Repository, for the reason the Commit list gives: an empty page is the
   * claim "this repository has no pull requests", and a typo'd id must not be able to make it.
   */
  async listForRepository(
    repositoryId: string,
    input: Omit<ListPullRequestsApiInput, 'repositoryId'>,
  ): Promise<PullRequestResource[]> {
    await this.#requireRepository(repositoryId);
    return this.#page({ ...input, repositoryId });
  }

  /** `GET /api/v1/pull-requests/{id}` — single PR, plus its `description` (§5.3). */
  async get(id: string): Promise<PullRequestDetailResource> {
    const row = await findPullRequestById(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No pull request with id ${id}`);
    return serializePullRequestDetail(row);
  }

  async #page(input: ListPullRequestsApiInput): Promise<PullRequestResource[]> {
    const rows = await listPullRequests(this.#db, {
      limit: input.limit,
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return rows.map(serializePullRequest);
  }

  async #requireRepository(id: string): Promise<void> {
    const repository = await findRepositoryById(this.#db, id);
    if (repository === null) throw new ApiError('NOT_FOUND', `No repository with id ${id}`);
  }
}
