import type { CommitFile, Db } from '@mc/shared';
import type { Outbox, OutboxTransaction } from '../events/index.js';
import type { GitOptions } from '../repositories/git.js';
import { readRemoteUrl } from '../repositories/git.js';
import {
  findRepositoryById,
  type RepositoryRow,
  updateRepositorySync,
} from '../repositories/store.js';
import type { SecretVault } from '../settings/secrets.js';
import { type AttributionCandidate, attributeCommit } from './attribution.js';
import { GithubClient, type GithubFailure } from './client.js';
import type { GithubHttpPort } from './http.js';
import {
  asArray,
  type GithubCommitSummary,
  type GithubPullRequest,
  type GithubRepositoryMetadata,
  mapCommitDetail,
  mapCommitSummary,
  mapFirstReviewAt,
  mapPullRequest,
  mapRepository,
  type PullRequestState,
} from './map.js';
import { RateLimitBudget } from './rate-limit.js';
import { classifyRemote, type GithubRemote } from './remote.js';
import { GITHUB_NOT_CONFIGURED_MESSAGE, readGithubToken } from './settings.js';
import {
  findAttributionCandidates,
  findKnownCommitShas,
  findPullRequestsByRepository,
  type InsertCommitInput,
  insertNewCommits,
  type PullRequestRow,
  upsertPullRequest,
} from './store.js';

/**
 * `POST /api/v1/repositories/{id}/sync` and the polling producer's per-repository work
 * (TDS 04 §5.1, TDS 02 §2, events §15.2 #14–#20).
 *
 * ## Shape of a sync
 *
 * Every network read happens **before** the transaction opens, and every write happens inside
 * exactly one transaction with its events (F6.3 transactional outbox). A sync therefore either
 * lands whole — rows, `sync_status`, `last_synced_at` and every event — or not at all. There is
 * no window in which `repository.synced` is delivered for commits that then roll back.
 *
 * ## Idempotence
 *
 * - **Commits** dedupe on `(repository_id, sha)` in the database (`insertNewCommits`), and only
 *   the rows the insert actually created emit `commit.recorded`. A second run of an unchanged
 *   repository inserts nothing and emits nothing.
 * - **Pull requests** key on the GitHub number and emit only on a *transition* — a PR whose
 *   fields are byte-identical produces no event and no `updated_at` bump.
 * - **`repository.synced` is emitted only when something changed**, or when a previously failed
 *   repository recovered. A fifteen-minute poll that finds nothing new is silent on the
 *   `repositories` channel; `last_synced_at` still advances, because `/schedule` derives the
 *   GitHub poll's `lastRunAt` from it (§7.7) and a silent-but-running poller must not look
 *   stalled.
 *
 * ## Failure is data
 *
 * Nothing here throws for an ordinary GitHub condition. A 404 on a deleted remote, a rejected
 * token, an exhausted rate limit and a repository whose `origin` is not on github.com all end
 * the same way: `sync_status = 'failed'`, a `last_sync_error` written for the operator, and
 * `repository.sync_failed`. `last_synced_at` is left alone — TDS 03 §3.6 defines it as the last
 * **successful** sync, and advancing it on failure would make `/schedule` claim a poll happened
 * that produced nothing.
 *
 * The one condition that is *not* a failure is a missing token: Mission Control declined to
 * ask, rather than GitHub declining to answer. That returns `skipped` and touches no column —
 * `/schedule` already reports `github_poll` as `enabled: false` when the token is unset, which
 * is where an operator should learn it.
 *
 * ## What it reads, and what it deliberately does not
 *
 * One page of the default branch's commits and one page of pull requests per run. There is no
 * `Link`-header walk: this is a poll, not a history importer. A repository connected today does
 * not acquire its 40 000 historical commits, and pretending otherwise would spend thousands of
 * requests on rows nothing in the product reads.
 */

/** One page of commits per run; GitHub's own page maximum is 100. */
export const MAX_COMMITS_PER_SYNC = 50;
/** `files[]` needs one request per commit, so this bounds the worst case of a first sync. */
export const MAX_COMMIT_DETAILS = 50;
export const MAX_PULL_REQUESTS_PER_SYNC = 50;
/** Reviews are one request per PR and are never re-fetched once `reviewed_at` is known. */
export const MAX_REVIEW_FETCHES = 20;
export const MAX_ATTRIBUTION_CANDIDATES = 500;
/** `last_sync_error` is `text`; this keeps a pathological upstream message out of the UI. */
export const MAX_SYNC_ERROR_LENGTH = 1_000;

export type SyncTrigger = 'user' | 'schedule';

export type SyncSkipReason =
  | 'not_found'
  | 'not_configured'
  /** Another sync of this same repository was already running. */
  | 'in_flight';

export interface SyncCounts {
  readonly newCommits: number;
  readonly newPullRequests: number;
  readonly updatedPullRequests: number;
  readonly attributedCommits: number;
}

export type SyncOutcome =
  | ({ readonly status: 'ok'; readonly repositoryId: string } & SyncCounts)
  | {
      readonly status: 'failed';
      readonly repositoryId: string;
      readonly reason: string;
      readonly failureKind: string;
    }
  | {
      readonly status: 'skipped';
      readonly repositoryId: string;
      readonly reason: SyncSkipReason;
      readonly detail: string | null;
    };

export interface SyncLimits {
  readonly commitsPerSync?: number;
  readonly commitDetails?: number;
  readonly pullRequestsPerSync?: number;
  readonly reviewFetches?: number;
}

export interface RepositorySyncServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly vault: SecretVault;
  /** The injected network edge. Never constructed here — see `http.ts`. */
  readonly http: GithubHttpPort;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly git?: GitOptions | undefined;
  readonly now?: (() => Date) | undefined;
  readonly limits?: SyncLimits | undefined;
}

export class RepositorySyncService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #vault: SecretVault;
  readonly #createClient: (token: string) => GithubClient;
  readonly #git: GitOptions;
  readonly #now: () => Date;
  readonly #limits: Required<SyncLimits>;
  /**
   * Process-wide, shared by every client this service builds. That sharing is the point: a poll
   * over twenty repositories must discover an exhausted rate-limit window **once**, not twenty
   * times, and must not spend twenty requests proving it.
   */
  readonly #budget = new RateLimitBudget();
  /** Repositories currently being synced in this process — the overlap guard. */
  readonly #inFlight = new Set<string>();

  constructor(options: RepositorySyncServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#vault = options.vault;
    this.#git = options.git ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#createClient = (token) =>
      new GithubClient({
        http: options.http,
        token,
        budget: this.#budget,
        now: this.#now,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    this.#limits = {
      commitsPerSync: options.limits?.commitsPerSync ?? MAX_COMMITS_PER_SYNC,
      commitDetails: options.limits?.commitDetails ?? MAX_COMMIT_DETAILS,
      pullRequestsPerSync: options.limits?.pullRequestsPerSync ?? MAX_PULL_REQUESTS_PER_SYNC,
      reviewFetches: options.limits?.reviewFetches ?? MAX_REVIEW_FETCHES,
    };
  }

  /** Whether a sync of this repository is running in this process right now. */
  isSyncing(repositoryId: string): boolean {
    return this.#inFlight.has(repositoryId);
  }

  /** A new token has a new budget. Called when the GitHub settings change. */
  resetBudget(): void {
    this.#budget.reset();
  }

  /**
   * Sync one repository.
   *
   * Never throws for an ordinary GitHub or git condition. The in-flight guard is what makes
   * "must not stack up overlapping syncs for the same repository" true within this process: a
   * second caller — the poll tick arriving while an operator-triggered sync is still running,
   * or a redelivered pg-boss job — is answered `skipped: 'in_flight'` immediately rather than
   * queued behind the first.
   */
  async sync(repositoryId: string): Promise<SyncOutcome> {
    if (this.#inFlight.has(repositoryId)) {
      return {
        status: 'skipped',
        repositoryId,
        reason: 'in_flight',
        detail: 'A sync of this repository is already running',
      };
    }

    this.#inFlight.add(repositoryId);
    try {
      return await this.#sync(repositoryId);
    } finally {
      this.#inFlight.delete(repositoryId);
    }
  }

  async #sync(repositoryId: string): Promise<SyncOutcome> {
    const repository = await findRepositoryById(this.#db, repositoryId);
    if (repository === null) {
      return { status: 'skipped', repositoryId, reason: 'not_found', detail: null };
    }

    const token = await readGithubToken(this.#db, this.#vault);
    if (token.kind === 'not_configured') {
      return {
        status: 'skipped',
        repositoryId,
        reason: 'not_configured',
        detail: GITHUB_NOT_CONFIGURED_MESSAGE,
      };
    }
    if (token.kind === 'unreadable') {
      return this.#fail(repository, 'secret_unreadable', token.message);
    }

    const remote = await this.#resolveRemote(repository);
    if (remote.kind === 'error') {
      return this.#fail(repository, remote.failureKind, remote.message);
    }

    const client = this.#createClient(token.token);
    const ref = { owner: remote.remote.owner, repo: remote.remote.repo };

    const metadataResult = await client.getRepository(ref);
    if (!metadataResult.ok) return this.#failFromGithub(repository, metadataResult.failure);

    const metadata = mapRepository(metadataResult.value);
    if (metadata === null) {
      return this.#fail(
        repository,
        'malformed',
        `GitHub returned a repository document for ${ref.owner}/${ref.repo} that Mission Control could not read.`,
      );
    }

    const branch = metadata.defaultBranch ?? repository.defaultBranch;

    const commits = await this.#readCommits(client, ref, repository, branch);
    if (commits.kind === 'error') return this.#failFromGithub(repository, commits.failure);

    const pullRequests = await this.#readPullRequests(client, ref, repository);
    if (pullRequests.kind === 'error')
      return this.#failFromGithub(repository, pullRequests.failure);

    return this.#commit({
      repository,
      remote: remote.remote,
      metadata,
      branch,
      commits: commits.value,
      pullRequests: pullRequests.value,
    });
  }

  // ------------------------------------------------------------------------------- the remote

  /**
   * Where this repository lives on GitHub.
   *
   * `repositories.remote_url` is the cached answer; the working tree's `origin` is the source
   * of truth. The disk is consulted when the column is empty (every repository registered
   * through `POST /repositories`, which touches no remote) or when the cached value stopped
   * being a GitHub URL — an operator who re-points `origin` should not have to de-register.
   */
  async #resolveRemote(
    repository: RepositoryRow,
  ): Promise<
    { kind: 'ok'; remote: GithubRemote } | { kind: 'error'; failureKind: string; message: string }
  > {
    const cached = repository.remoteUrl === null ? null : classifyRemote(repository.remoteUrl);
    if (cached?.kind === 'github') return { kind: 'ok', remote: cached.remote };

    const read = await readRemoteUrl(repository.localPath, repository.remoteName, this.#git);

    if (read.url === null) {
      const detail = read.detail === null ? '' : ` (${read.detail})`;
      switch (read.unavailableReason) {
        case 'no_remote':
          return {
            kind: 'error',
            failureKind: 'no_remote',
            message: `This repository has no "${repository.remoteName}" remote, so there is nothing on GitHub to sync. Add a remote to ${repository.localPath}, or remove the repository from Mission Control.`,
          };
        case 'not_a_git_repository':
          return {
            kind: 'error',
            failureKind: 'not_a_git_repository',
            message: `${repository.localPath} is no longer a git working tree${detail}. It may have been moved or deleted.`,
          };
        case 'git_unavailable':
          return {
            kind: 'error',
            failureKind: 'git_unavailable',
            message: `git is not available on this machine, so the repository's remote could not be read${detail}.`,
          };
        default:
          return {
            kind: 'error',
            failureKind: read.unavailableReason ?? 'git_failed',
            message: `Could not read the "${repository.remoteName}" remote of ${repository.localPath}${detail}.`,
          };
      }
    }

    const classified = classifyRemote(read.url);
    if (classified.kind === 'github') return { kind: 'ok', remote: classified.remote };

    // Deliberately reports the HOST and never the URL: a git remote can carry a credential
    // (`https://user:ghp_…@host/o/r`) and this string is persisted in `last_sync_error` and
    // shipped to the browser.
    return {
      kind: 'error',
      failureKind: 'remote_not_github',
      message:
        classified.kind === 'other_host'
          ? `The "${repository.remoteName}" remote points at ${classified.host}. Mission Control syncs github.com repositories only; GitHub Enterprise Server is not supported in V1.`
          : `The "${repository.remoteName}" remote of ${repository.localPath} is not a URL Mission Control can parse.`,
    };
  }

  // ------------------------------------------------------------------------------- reads

  async #readCommits(
    client: GithubClient,
    ref: { owner: string; repo: string },
    repository: RepositoryRow,
    branch: string,
  ): Promise<{ kind: 'ok'; value: CommitPlan } | { kind: 'error'; failure: GithubFailure }> {
    const result = await client.listCommits(ref, {
      branch,
      perPage: this.#limits.commitsPerSync,
    });
    if (!result.ok) {
      // A 404 here after a successful repository fetch means the *branch* is gone, not the
      // repository. Reporting the repository as missing would send the operator to the wrong
      // place, so the branch is named in the message the client already built.
      return { kind: 'error', failure: result.failure };
    }

    const summaries: GithubCommitSummary[] = [];
    for (const raw of asArray(result.value)) {
      const mapped = mapCommitSummary(raw);
      if (mapped !== null) summaries.push(mapped);
    }

    if (summaries.length === 0) return { kind: 'ok', value: EMPTY_COMMIT_PLAN };

    const headSha = summaries[0]?.sha ?? null;

    // The cheap cursor (`repositories.last_polled_sha`, TDS 03 §3.6): when the branch head has
    // not moved there is provably nothing new, so the whole commit path — one query and up to
    // fifty detail requests — is skipped.
    if (headSha !== null && headSha === repository.lastPolledSha) {
      return { kind: 'ok', value: { headSha, commits: [] } };
    }

    const known = await findKnownCommitShas(
      this.#db,
      repository.id,
      summaries.map((commit) => commit.sha),
    );

    // Oldest first, so inserted ids are in commit order and the Session-scoped list reads
    // naturally when two commits share a second.
    const fresh = summaries.filter((commit) => !known.has(commit.sha)).reverse();
    const detailed: DetailedCommit[] = [];

    for (const commit of fresh.slice(0, this.#limits.commitDetails)) {
      const detail = await client.getCommit(ref, commit.sha);
      if (!detail.ok) {
        // A rate limit or an outage part-way through the detail walk fails the whole sync
        // rather than storing commits with an empty `files[]` that nothing would ever refill:
        // `insertNewCommits` writes each sha once, so a wrong `files` is permanent. Reporting
        // the failure keeps the commits unrecorded and lets the next poll do it properly.
        return { kind: 'error', failure: detail.failure };
      }
      const mapped = mapCommitDetail(detail.value);
      detailed.push({ ...commit, files: mapped?.files ?? [] });
    }

    // Anything beyond the detail cap is left for the next poll: it will still be new then, and
    // `last_polled_sha` is only advanced when the page was fully absorbed (see `#commit`).
    return {
      kind: 'ok',
      value: {
        headSha,
        commits: detailed,
        ...(fresh.length > detailed.length ? { deferred: fresh.length - detailed.length } : {}),
      },
    };
  }

  async #readPullRequests(
    client: GithubClient,
    ref: { owner: string; repo: string },
    repository: RepositoryRow,
  ): Promise<{ kind: 'ok'; value: PullRequestPlan } | { kind: 'error'; failure: GithubFailure }> {
    const result = await client.listPullRequests(ref, {
      perPage: this.#limits.pullRequestsPerSync,
    });
    if (!result.ok) return { kind: 'error', failure: result.failure };

    const existing = await findPullRequestsByRepository(this.#db, repository.id);
    const planned: PlannedPullRequest[] = [];
    let reviewFetches = 0;

    for (const raw of asArray(result.value)) {
      const mapped = mapPullRequest(raw);
      if (mapped === null) continue;

      const stored = existing.get(mapped.number) ?? null;
      let reviewedAt = stored?.reviewedAt ?? null;

      // One request per PR, spent only when it can change something: we do not know of a
      // review yet, the PR is still open or draft (a merged PR's first review is history we
      // either have or never will), and the run's budget is not used up.
      //
      // Deliberately NOT gated on `hasMoved`: a review changes none of the fields this system
      // stores, so a PR whose only news is "somebody reviewed it" looks identical to one that
      // did not move. Gating on movement would mean `reviewed_at` was only ever discovered by
      // accident, when some *other* field happened to change in the same interval.
      const worthAsking =
        reviewedAt === null &&
        (mapped.state === 'open' || mapped.state === 'draft') &&
        reviewFetches < this.#limits.reviewFetches;

      if (worthAsking) {
        reviewFetches += 1;
        const reviews = await client.listReviews(ref, mapped.number, { perPage: 100 });
        if (!reviews.ok) return { kind: 'error', failure: reviews.failure };
        reviewedAt = mapFirstReviewAt(reviews.value);
      }

      planned.push({ pullRequest: mapped, stored, reviewedAt });
    }

    return { kind: 'ok', value: { planned } };
  }

  // ------------------------------------------------------------------------------- the write

  async #commit(input: {
    repository: RepositoryRow;
    remote: GithubRemote;
    metadata: GithubRepositoryMetadata;
    branch: string;
    commits: CommitPlan;
    pullRequests: PullRequestPlan;
  }): Promise<SyncOutcome> {
    const { repository, remote, metadata, branch } = input;
    const now = this.#now();

    const candidates =
      input.commits.commits.length === 0
        ? []
        : await findAttributionCandidates(this.#db, repository.id, {
            startedBefore: newest(input.commits.commits),
            limit: MAX_ATTRIBUTION_CANDIDATES,
          });

    const remoteUrl = metadata.htmlUrl ?? remote.canonicalUrl;
    const metadataChanged =
      repository.remoteUrl !== remoteUrl ||
      repository.visibility !== metadata.visibility ||
      repository.defaultBranch !== branch;

    return this.#outbox.run(async (tx) => {
      const inserted = await insertNewCommits(
        tx.tx,
        input.commits.commits.map((commit) =>
          this.#toCommitRow(repository.id, branch, commit, candidates, now),
        ),
      );

      let attributedCommits = 0;
      for (const row of inserted) {
        if (row.sessionId !== null) attributedCommits += 1;
        await tx.emit(
          this.#outbox.event(
            'commit.recorded',
            { commitId: row.id, repositoryId: repository.id, sessionId: row.sessionId },
            { correlationId: row.sessionId ?? repository.id },
          ),
        );
      }

      const pullRequestCounts = await this.#writePullRequests(
        tx,
        repository.id,
        input.pullRequests,
      );

      await updateRepositorySync(tx.tx, repository.id, {
        remoteUrl,
        visibility: metadata.visibility,
        defaultBranch: branch,
        // Only advance the cursor when the whole page was absorbed. Advancing it while commits
        // were deferred past the detail cap would make the next poll believe it had them.
        ...(input.commits.deferred === undefined && input.commits.headSha !== null
          ? { lastPolledSha: input.commits.headSha }
          : {}),
        lastSyncedAt: now,
        syncStatus: 'ok',
        lastSyncError: null,
      });

      const changed =
        inserted.length > 0 ||
        pullRequestCounts.created > 0 ||
        pullRequestCounts.updated > 0 ||
        metadataChanged ||
        repository.syncStatus !== 'ok';

      if (changed) {
        await tx.emit(
          this.#outbox.event(
            'repository.synced',
            {
              repositoryId: repository.id,
              newCommits: inserted.length,
              newPullRequests: pullRequestCounts.created,
            },
            { correlationId: repository.id },
          ),
        );
      }

      return {
        status: 'ok' as const,
        repositoryId: repository.id,
        newCommits: inserted.length,
        newPullRequests: pullRequestCounts.created,
        updatedPullRequests: pullRequestCounts.updated,
        attributedCommits,
      };
    });
  }

  #toCommitRow(
    repositoryId: string,
    branch: string,
    commit: DetailedCommit,
    candidates: readonly AttributionCandidate[],
    now: Date,
  ): InsertCommitInput {
    const attribution = attributeCommit(
      { repositoryId, branch, committedAt: commit.committedAt },
      candidates,
      now,
    );

    return {
      repositoryId,
      sessionId: attribution.decision === 'attributed' ? attribution.sessionId : null,
      sha: commit.sha,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      message: commit.message,
      branch,
      files: commit.files,
      committedAt: commit.committedAt,
    };
  }

  async #writePullRequests(
    tx: OutboxTransaction,
    repositoryId: string,
    plan: PullRequestPlan,
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    for (const { pullRequest, stored, reviewedAt } of plan.planned) {
      const events = pullRequestEvents(stored, pullRequest, reviewedAt);
      if (stored !== null && events.length === 0 && !hasMoved(stored, pullRequest)) continue;

      const row = await upsertPullRequest(tx.tx, {
        repositoryId,
        number: pullRequest.number,
        title: pullRequest.title,
        description: pullRequest.description,
        state: pullRequest.state,
        author: pullRequest.author,
        headBranch: pullRequest.headBranch,
        baseBranch: pullRequest.baseBranch,
        url: pullRequest.url,
        openedAt: pullRequest.openedAt,
        reviewedAt,
        mergedAt: pullRequest.mergedAt,
        closedAt: pullRequest.closedAt,
      });

      if (stored === null) created += 1;
      else updated += 1;

      for (const event of events) {
        await tx.emit(
          this.#outbox.event(
            event.type,
            { pullRequestId: row.id, repositoryId, ...event.payload },
            { correlationId: repositoryId },
          ),
        );
      }
    }

    return { created, updated };
  }

  // ------------------------------------------------------------------------------- failure

  async #failFromGithub(repository: RepositoryRow, failure: GithubFailure): Promise<SyncOutcome> {
    return this.#fail(repository, failure.kind, failure.message);
  }

  /**
   * Record a failed sync: `sync_status`, `last_sync_error`, and `repository.sync_failed` in one
   * transaction. `last_synced_at` is untouched — §3.6 defines it as the last *successful* sync.
   */
  async #fail(
    repository: RepositoryRow,
    failureKind: string,
    message: string,
  ): Promise<SyncOutcome> {
    const reason = message.slice(0, MAX_SYNC_ERROR_LENGTH);

    await this.#outbox.run(async (tx) => {
      await updateRepositorySync(tx.tx, repository.id, {
        syncStatus: 'failed',
        lastSyncError: reason,
      });

      // Re-emitting an identical failure every fifteen minutes would bury the `repositories`
      // channel; the row still says `failed` and the badge still shows. The event fires when
      // the failure is new or when its reason changed.
      if (repository.syncStatus !== 'failed' || repository.lastSyncError !== reason) {
        await tx.emit(
          this.#outbox.event(
            'repository.sync_failed',
            { repositoryId: repository.id, reason },
            { correlationId: repository.id },
          ),
        );
      }
    });

    return { status: 'failed', repositoryId: repository.id, reason, failureKind };
  }
}

// ------------------------------------------------------------------------------------- plans

interface DetailedCommit extends GithubCommitSummary {
  readonly files: CommitFile[];
}

interface CommitPlan {
  readonly headSha: string | null;
  readonly commits: readonly DetailedCommit[];
  /** Set when the page held more new commits than the detail budget allowed this run. */
  readonly deferred?: number;
}

const EMPTY_COMMIT_PLAN: CommitPlan = { headSha: null, commits: [] };

interface PlannedPullRequest {
  readonly pullRequest: GithubPullRequest;
  readonly stored: PullRequestRow | null;
  readonly reviewedAt: Date | null;
}

interface PullRequestPlan {
  readonly planned: readonly PlannedPullRequest[];
}

// ------------------------------------------------------------------------- pure decisions

/** Did anything we store about this PR actually change? Drives the "emit nothing" path. */
export function hasMoved(stored: PullRequestRow, incoming: GithubPullRequest): boolean {
  return (
    stored.title !== incoming.title ||
    stored.description !== incoming.description ||
    stored.state !== incoming.state ||
    stored.author !== incoming.author ||
    stored.headBranch !== incoming.headBranch ||
    stored.baseBranch !== incoming.baseBranch ||
    stored.url !== incoming.url ||
    !sameInstant(stored.openedAt, incoming.openedAt) ||
    !sameInstant(stored.mergedAt, incoming.mergedAt) ||
    !sameInstant(stored.closedAt, incoming.closedAt)
  );
}

export interface PullRequestEvent {
  readonly type:
    | 'pull_request.opened'
    | 'pull_request.reviewed'
    | 'pull_request.merged'
    | 'pull_request.closed';
  readonly payload: Record<string, unknown>;
}

/**
 * Which §15.2 events one pull request produces this run.
 *
 * The PRD's lifecycle words (Created/Opened/Reviewed/Merged/Rejected) are event names, never
 * stored states (arbitration A3) — this function is where the stored GitHub truth becomes those
 * words, and it is deliberately conservative:
 *
 *  - **On first sight of a PR, exactly one event.** A repository connected today holds PRs
 *    merged last year; emitting `opened` then `merged` for each of them would replay a year of
 *    history onto the `repositories` channel as though it had just happened. The PR's *current*
 *    state is the one fact that is true now, so that is the one event.
 *  - **Afterwards, one event per fact that newly became true.** `reviewed` when the first
 *    review appears, `merged`/`closed` on the transition, `opened` on a reopen.
 *  - **Nothing at all when nothing moved** — which is the steady state of every poll.
 *
 * `pull_request.closed` carries §15.2's `reason`. GitHub cannot distinguish "superseded" from
 * "rejected": both are `state: closed` with no `merged_at`. The PRD names that fact *Rejected*
 * (§4.3), so that is what a closed-unmerged PR reports; `superseded` and `other` are reachable
 * only when a future producer can actually tell them apart.
 */
export function pullRequestEvents(
  stored: PullRequestRow | null,
  incoming: GithubPullRequest,
  reviewedAt: Date | null,
): readonly PullRequestEvent[] {
  if (stored === null) {
    return [eventForState(incoming.state)];
  }

  const events: PullRequestEvent[] = [];

  if (stored.reviewedAt === null && reviewedAt !== null) {
    events.push({ type: 'pull_request.reviewed', payload: {} });
  }

  const was = stored.state as PullRequestState;
  const now = incoming.state;

  if (was !== now) {
    const wasLive = was === 'open' || was === 'draft';
    const isLive = now === 'open' || now === 'draft';

    if (wasLive && !isLive) events.push(eventForState(now));
    else if (!wasLive && isLive) events.push({ type: 'pull_request.opened', payload: {} });
    // open <-> draft is not a lifecycle fact in §15.2 and gets no event; the row still updates.
  }

  return events;
}

function eventForState(state: PullRequestState): PullRequestEvent {
  switch (state) {
    case 'merged':
      return { type: 'pull_request.merged', payload: {} };
    case 'closed':
      return { type: 'pull_request.closed', payload: { reason: 'rejected' } };
    default:
      return { type: 'pull_request.opened', payload: {} };
  }
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function newest(commits: readonly GithubCommitSummary[]): Date {
  return commits.reduce<Date>(
    (latest, commit) => (commit.committedAt > latest ? commit.committedAt : latest),
    commits[0]?.committedAt ?? new Date(0),
  );
}
