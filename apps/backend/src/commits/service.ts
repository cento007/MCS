import type { Db } from '@mc/shared';
import { ApiError } from '../http/errors.js';
import { findRepositoryById } from '../repositories/store.js';
import type { CommitCursor } from './cursors.js';
import {
  type CommitDetailResource,
  type CommitResource,
  serializeCommit,
  serializeCommitDetail,
} from './serialize.js';
import { findCommitById, listCommits } from './store.js';

/**
 * The Commit read model — TDS 04 §5.2.
 *
 * **Read-only, and structurally so.** Commits are written by one thing (the GitHub sync,
 * `github/sync.ts`) and this service cannot write: it imports no outbox, no audit recorder and
 * no insert. §5.2 defines no write endpoint, and PRD §4.3's Manual mode is explicit that
 * Mission Control *records* commits rather than making them.
 */

export interface ListCommitsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly after?: CommitCursor | undefined;
  /** §5.2's `?sessionId=` — "which of these commits came out of that Session". */
  readonly sessionId?: string | undefined;
  /** §5.2's `?branch=`. */
  readonly branch?: string | undefined;
}

export interface CommitServiceOptions {
  readonly db: Db;
}

export class CommitService {
  readonly #db: Db;

  constructor(options: CommitServiceOptions) {
    this.#db = options.db;
  }

  /**
   * `GET /api/v1/repositories/{id}/commits` — cursor list, newest `committedAt` first (§5.2).
   *
   * The unknown-Repository case is a `404`, not an empty page. An empty list is a claim —
   * "this repository has no commits" — and answering it for a repository that does not exist
   * would make a typo'd id indistinguishable from a repository that has never been synced.
   */
  async listForRepository(
    repositoryId: string,
    input: ListCommitsApiInput,
  ): Promise<CommitResource[]> {
    await this.#requireRepository(repositoryId);

    const rows = await listCommits(this.#db, {
      repositoryId,
      limit: input.limit,
      order: input.order,
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
    });

    return rows.map(serializeCommit);
  }

  /** `GET /api/v1/commits/{id}` — the single commit, **with** `files[]` (§5.2). */
  async get(id: string): Promise<CommitDetailResource> {
    const row = await findCommitById(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No commit with id ${id}`);
    return serializeCommitDetail(row);
  }

  async #requireRepository(id: string): Promise<void> {
    const repository = await findRepositoryById(this.#db, id);
    if (repository === null) throw new ApiError('NOT_FOUND', `No repository with id ${id}`);
  }
}
