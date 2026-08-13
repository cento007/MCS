import type { Db } from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import type { Outbox } from '../events/index.js';
import type { RequestContext } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import type { GitOptions } from '../repositories/git.js';
import { type RepositoryResource, serializeRepository } from '../repositories/serialize.js';
import { deriveRepositoryName, normalizeLocalPath } from '../repositories/validation.js';
import {
  type CandidateProblem,
  type DiscoveryCandidate,
  type RootReport,
  type ScanOptions,
  scanDiscoveryRoots,
} from './discovery.js';
import { readGithubIntegrationSettings } from './settings.js';
import { findRepositoriesByLocalPaths, insertDiscoveredRepositories } from './store.js';
import { githubCapability, type WorkflowMode } from './workflow.js';

/**
 * `POST /api/v1/repositories/discover` (TDS 04 §5.1, PRD §4.3 "Repository Discovery:
 * automatic detection").
 *
 * ## The contract this implements, and the two deviations it declares
 *
 * §5.1 specifies `202 { data: { jobId } }` and "Emits `repository.discovered` per new repo".
 * This implementation **registers** (matching the event) but answers **`200` with a complete
 * report** instead of `202` with a job id. Both halves are deliberate:
 *
 *  1. **Register rather than propose.** `repository.discovered` is the catalog's only "a
 *     Repository now exists" event (§15.2 #13) and §5.1 says discovery emits one *per new
 *     repo*, so the contract's discovery creates rows. A propose-then-confirm flow would need a
 *     second endpoint that §5.1 does not define. The cost of a wrong registration is bounded and
 *     reversible: a row with `projectId: null`, no session, no sync, removable with
 *     `DELETE /repositories/{id}`. Re-running is a no-op — `ux_repositories_local_path` decides,
 *     not a prior `SELECT`, so nothing duplicates and nothing re-emits.
 *  2. **⚠ `200` with a report, not `202` with a job id — flagged, not silently invented.** Two
 *     reasons. First, the contract defines no job resource: there is no `GET /jobs/{id}` in §2's
 *     catalog, so a returned `jobId` is a token the caller cannot resolve into anything. Second
 *     and decisively, **the skip reasons have nowhere to live.** "this directory has no remote",
 *     "this one points at GitLab", "this one is already registered" are the entire value of
 *     running discovery, and no table stores them; answering `202` discards them permanently
 *     and leaves the operator to guess why a repository they expected did not appear. The scan
 *     is bounded on depth, breadth, count and wall-clock time (`discovery.ts`), which is what
 *     makes it request-shaped in the same way `GET /repositories/{id}/status` is.
 *
 * ## Discovery makes no GitHub API call
 *
 * "Match to GitHub" is decided entirely from the working tree's `origin` remote
 * (`remote.ts`) — which is where the answer actually is. Three consequences, all of them
 * wanted: discovery works before a token is configured; it cannot fail on a rate limit; and it
 * is fast enough to be synchronous. `visibility` and `defaultBranch` are therefore left at their
 * table defaults (`unknown`, `main`) with `sync_status: 'never'`, and the first sync fills them
 * from GitHub, which is their authority. A discovered repository that shows `main` before its
 * first sync is visibly un-synced; one that showed a *guessed* `master` would not be.
 *
 * `INTEGRATION_NOT_CONFIGURED` (409) is reserved for the one thing §5.1 names: no discovery
 * roots configured. A missing token is **not** an error here, because nothing in this path needs
 * one.
 */

export type SkipReason =
  | 'already_registered'
  | CandidateProblem
  /** The path exists and is a working tree, but is not usable as a Repository row. */
  | 'invalid_path';

export interface SkippedCandidate {
  readonly localPath: string;
  readonly reason: SkipReason;
  /** Why, in words. Never contains a remote URL — a remote URL can carry a credential. */
  readonly detail: string | null;
  /** Set only for `already_registered`. */
  readonly repositoryId: string | null;
}

export interface DiscoveredRepository {
  readonly repository: RepositoryResource;
  readonly owner: string;
  readonly repo: string;
}

/**
 * The `200` body of `POST /repositories/discover`. A bounded, computed report (§1.2 shape:
 * `{ data: … }` with no `meta`) — nothing here is paginated and nothing is persisted except the
 * Repository rows named in `registered`.
 */
export interface DiscoveryReport {
  readonly scannedAt: string;
  /** A cap or the wall-clock deadline stopped the scan before it finished. */
  readonly truncated: boolean;
  readonly roots: readonly RootReport[];
  readonly registered: readonly DiscoveredRepository[];
  readonly skipped: readonly SkippedCandidate[];
  readonly counts: {
    readonly workingTreesFound: number;
    readonly registered: number;
    readonly skipped: number;
  };
  /**
   * The effective global Workflow Mode (PRD §4.3). Reported, never acted on: assisted PR
   * actions are Phase 2 under sanctioned deviation D8 — see `workflow.ts`.
   */
  readonly workflowMode: WorkflowMode;
  /** `read_only` in Phase 1 for both modes. */
  readonly capability: 'read_only';
}

export interface RepositoryDiscoveryServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly git?: GitOptions | undefined;
  readonly now?: (() => Date) | undefined;
  /** Scan bounds; the defaults are `discovery.ts`'s constants. Tests shrink them. */
  readonly scan?: Omit<ScanOptions, 'git'> | undefined;
}

export class RepositoryDiscoveryService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #git: GitOptions;
  readonly #now: () => Date;
  readonly #scan: Omit<ScanOptions, 'git'>;

  constructor(options: RepositoryDiscoveryServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#git = options.git ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#scan = options.scan ?? {};
  }

  async discover(principal: Principal, ctx: RequestContext): Promise<DiscoveryReport> {
    const settings = await readGithubIntegrationSettings(this.#db);

    if (settings.discoveryRoots.length === 0) {
      throw new ApiError(
        'INTEGRATION_NOT_CONFIGURED',
        'No repository discovery roots are configured. Add one or more absolute directory paths in Settings → Integrations → GitHub, then run discovery.',
        { integration: 'github', missing: ['integrations.github.discoveryRoots'] },
      );
    }

    const scan = await scanDiscoveryRoots(settings.discoveryRoots, {
      ...this.#scan,
      git: this.#git,
    });

    const existing = await findRepositoriesByLocalPaths(
      this.#db,
      scan.candidates.map((candidate) => candidate.localPath),
    );

    const skipped: SkippedCandidate[] = [];
    const registrable: (DiscoveryCandidate & { name: string })[] = [];

    for (const candidate of scan.candidates) {
      const registered = existing.get(candidate.localPath);
      if (registered !== undefined) {
        skipped.push({
          localPath: candidate.localPath,
          reason: 'already_registered',
          detail: null,
          repositoryId: registered.id,
        });
        continue;
      }

      if (candidate.problem !== null || candidate.remote === null) {
        skipped.push({
          localPath: candidate.localPath,
          reason: candidate.problem ?? 'remote_unreadable',
          detail: candidate.detail,
          repositoryId: null,
        });
        continue;
      }

      // The scanner produced this path with `resolve`/`join`, so this only ever fails for a
      // pathological entry; when it does, the candidate is reported rather than aborting the
      // whole run for the twenty repositories behind it.
      let localPath: string;
      try {
        localPath = normalizeLocalPath(candidate.localPath);
      } catch (error) {
        skipped.push({
          localPath: candidate.localPath,
          reason: 'invalid_path',
          detail: error instanceof ApiError ? error.message : 'path could not be normalised',
          repositoryId: null,
        });
        continue;
      }

      registrable.push({
        ...candidate,
        localPath,
        // The GitHub repository name, not the directory name: a clone in `D:\work\mcs-2` of
        // `cento007/MCS` is that repository, and the operator will look for it under that name.
        name: candidate.remote.repo.slice(0, 200) || deriveRepositoryName(localPath),
      });
    }

    const registered = await this.#register(principal, ctx, registrable);

    // A row that lost the insert race was registered by a concurrent run, not by us — it is
    // "already registered", which is exactly what a re-run would report.
    const registeredPaths = new Set(registered.map((entry) => entry.repository.localPath));
    for (const candidate of registrable) {
      if (registeredPaths.has(candidate.localPath)) continue;
      skipped.push({
        localPath: candidate.localPath,
        reason: 'already_registered',
        detail: 'Registered by a concurrent discovery run',
        repositoryId: null,
      });
    }

    return {
      scannedAt: this.#now().toISOString(),
      truncated: scan.truncated,
      roots: scan.roots,
      registered,
      skipped,
      counts: {
        workingTreesFound: scan.candidates.length,
        registered: registered.length,
        skipped: skipped.length,
      },
      workflowMode: settings.workflowMode,
      capability: githubCapability(settings.workflowMode),
    };
  }

  /**
   * One transaction for the whole run: every new Repository row, its `repository.discovered`
   * event and its audit entry commit together, or none of them does. A partially-registered
   * scan whose report claims otherwise would be worse than a failed one, and the operator's
   * remedy for a failure is to press the button again — which is free, because discovery is
   * idempotent.
   */
  async #register(
    principal: Principal,
    ctx: RequestContext,
    candidates: readonly (DiscoveryCandidate & { name: string })[],
  ): Promise<DiscoveredRepository[]> {
    if (candidates.length === 0) return [];

    const byPath = new Map(candidates.map((candidate) => [candidate.localPath, candidate]));

    return this.#outbox.run(async (tx) => {
      const rows = await insertDiscoveredRepositories(
        tx.tx,
        candidates.map((candidate) => ({
          name: candidate.name,
          localPath: candidate.localPath,
          // The canonical `https://github.com/owner/repo`, rebuilt from the parsed coordinates.
          // Never the raw `origin` value, which may embed a personal access token.
          remoteUrl: candidate.remote?.canonicalUrl ?? '',
          remoteName: 'origin',
        })),
      );

      const discovered: DiscoveredRepository[] = [];

      for (const row of rows) {
        const candidate = byPath.get(row.localPath);
        /* c8 ignore next */
        if (candidate?.remote == null) continue;

        await tx.emit(
          this.#outbox.event(
            'repository.discovered',
            { repositoryId: row.id },
            { correlationId: row.id },
          ),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'repository.discovered',
          entityType: 'repositories',
          entityId: row.id,
          after: {
            name: row.name,
            localPath: row.localPath,
            remoteUrl: row.remoteUrl,
            source: 'discovery',
          },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        discovered.push({
          repository: serializeRepository(row),
          owner: candidate.remote.owner,
          repo: candidate.remote.repo,
        });
      }

      return discovered;
    });
  }
}
