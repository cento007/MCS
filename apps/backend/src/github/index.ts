import { type Db, QUEUE_NAMES, type Queue, type Unsubscribe } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus, Outbox } from '../events/index.js';
import type { GitOptions } from '../repositories/git.js';
import type { SecretVault } from '../settings/secrets.js';
import { RepositoryDiscoveryService } from './discover.js';
import type { ScanOptions } from './discovery.js';
import { createGithubHttpPort, type GithubHttpPort } from './http.js';
import { GithubPoller } from './poller.js';
import { type RepositorySyncJob, registerGithubRoutes } from './routes.js';
import { RepositorySyncService, type SyncLimits } from './sync.js';

/**
 * `github/` — repository discovery and commit/PR polling (TDS 02 §2, TDS 04 §5, PRD §4.3).
 *
 * Layout:
 *   http.ts         the ONE outbound network edge, as an injectable, bounded, GET-only port
 *   remote.ts       git remote URL -> GitHub coordinates; strips embedded credentials (pure)
 *   rate-limit.ts   the `x-ratelimit-*` headers and this process's budget (pure)
 *   client.ts       the REST client — total, redacting, retry-free
 *   map.ts          GitHub JSON -> row shapes; tolerant, never throws (pure)
 *   attribution.ts  the commit -> Session rule, stated and defended (pure)
 *   store.ts        every `commits` / `pull_requests` write; idempotence enforced by the DB
 *   discovery.ts    the bounded filesystem scan (pure over an injectable fs port)
 *   discover.ts     `POST /repositories/discover` — local only, makes no GitHub call
 *   sync.ts         `POST /repositories/{id}/sync` — reads outside the tx, writes inside one
 *   poller.ts       the self-rescheduling `github.poll` job
 *   settings.ts     `integrations.github.*`, and the only read of the token
 *   workflow.ts     Manual/Assisted — the D8 Phase 2 callout and the inherit rule
 *   routes.ts       the two §5.1 routes
 *
 * ## The three properties this module is built around
 *
 *  1. **The token is a secret and never leaves the process.** It is unsealed in `settings.ts`,
 *     handed to `GithubClient`'s private field, and travels only in an `authorization` header.
 *     No log line, error message, event payload or audit row in this module can carry it —
 *     `client.ts` passes every operator-facing string through `redactSecret` and
 *     `token-redaction.test.ts` asserts the property over every failure kind mechanically
 *     rather than over the ones we remembered.
 *  2. **Every outbound call is bounded, and failure is data.** `http.ts` enforces a wall-clock
 *     deadline and a body cap; `client.ts` turns every GitHub condition into a `GithubFailure`
 *     with an operator-actionable message; `sync.ts` writes that message to
 *     `repositories.last_sync_error` and answers `sync_status: 'failed'`. Nothing here can
 *     produce a 500 from a GitHub outage, and nothing retries into a closed rate-limit window.
 *  3. **Idempotence is enforced by the database, not by a read-then-write.** Commits conflict
 *     on `(repository_id, sha)`, discovered repositories on `local_path`, pull requests on
 *     `(repository_id, number)`; only rows the insert actually created emit an event. A poll
 *     that finds nothing new writes no rows and emits nothing.
 *
 * ## Phase note (sanctioned deviation D8)
 *
 * > **Phase 2 — interface only.** Assisted-mode PR *actions* — PR creation, description
 * > generation, review summaries — are deferred to Phase 2 per deviation D8; they depend on
 * > Phase 2 knowledge generation. Detailed design is out of TDS scope per the project-plan
 * > scope guard.
 *
 * Phase 1 reads `integrations.github.workflowMode` and behaves identically for both values:
 * **read-only tracking**. That is structural, not merely unimplemented — `GithubHttpPort` has
 * no method field and its one implementation issues `GET`, so nothing in this build can write
 * to GitHub. See `workflow.ts`.
 *
 * ## Phase note (producer topology)
 *
 * The Backend is the producer in Phase 1 (on demand + the in-process `github.poll` chain);
 * scheduled polling moves to the Sync Worker in Phase 2 (F2.1) with identical event names and
 * payloads — only the envelope's `source` differs (TDS 04 §15.2).
 */

export * from './attribution.js';
export * from './client.js';
export * from './discover.js';
export * from './discovery.js';
export * from './http.js';
export * from './map.js';
export * from './poller.js';
export * from './rate-limit.js';
export * from './remote.js';
export * from './routes.js';
export * from './settings.js';
export * from './store.js';
export * from './sync.js';
export * from './workflow.js';

export interface RegisterGithubOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: Queue;
  readonly bus: EventBus;
  readonly vault: SecretVault;
  /**
   * The outbound network edge. **Omitting it constructs the real one**, which reaches
   * api.github.com. Every test supplies a double; the integration harness supplies a port that
   * throws, so an accidental call fails loudly and locally instead of quietly succeeding
   * against the real service.
   */
  readonly http?: GithubHttpPort | undefined;
  /** Overridden by tests to point the client at a local stub. */
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly git?: GitOptions | undefined;
  readonly now?: (() => Date) | undefined;
  readonly limits?: SyncLimits | undefined;
  readonly scan?: Omit<ScanOptions, 'git'> | undefined;
  readonly maxRepositoriesPerTick?: number | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export interface GithubModule {
  readonly discovery: RepositoryDiscoveryService;
  readonly sync: RepositorySyncService;
  readonly poller: GithubPoller;
  /** Subscribe the `repository.sync` consumer and the poll chain. Called by `main.ts`. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function registerGithub(app: FastifyInstance, options: RegisterGithubOptions): GithubModule {
  const http = options.http ?? createGithubHttpPort();

  const sync = new RepositorySyncService({
    db: options.db,
    outbox: options.outbox,
    vault: options.vault,
    http,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  const discovery = new RepositoryDiscoveryService({
    db: options.db,
    outbox: options.outbox,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.scan === undefined ? {} : { scan: options.scan }),
  });

  const poller = new GithubPoller({
    db: options.db,
    queue: options.queue,
    sync,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxRepositoriesPerTick === undefined
      ? {}
      : { maxRepositoriesPerTick: options.maxRepositoriesPerTick }),
    onError: (error) => {
      options.onError?.(error, 'github.poll');
      app.log.error({ err: error }, 'github poll tick failed');
    },
  });

  registerGithubRoutes(app, {
    db: options.db,
    queue: options.queue,
    vault: options.vault,
    discovery,
  });

  let unsubscribeJobs: Unsubscribe | null = null;
  let unsubscribeBus: (() => void) | null = null;

  return {
    discovery,
    sync,
    poller,

    async start(): Promise<void> {
      unsubscribeJobs ??= await options.queue.subscribeJobs<RepositorySyncJob>(
        QUEUE_NAMES.REPOSITORY_SYNC,
        async (job) => {
          const outcome = await sync.sync(job.payload.repositoryId);
          if (outcome.status === 'failed') {
            // Already recorded on the row and emitted as `repository.sync_failed`; logged at
            // warn (not error) because it is an expected condition, not a defect.
            app.log.warn(
              { repositoryId: outcome.repositoryId, failureKind: outcome.failureKind },
              'repository sync failed',
            );
          }
        },
        { concurrency: 1 },
      );

      /**
       * A GitHub settings change restarts the poll chain (it may have stopped because the
       * interval was 0) and forgets the rate-limit budget (a new token has a new budget). The
       * event is the one the Settings service already emits through the same outbox.
       */
      unsubscribeBus ??= options.bus.on('setting.updated', (event) => {
        if (event.payload['integration'] !== 'github') return;
        sync.resetBudget();
        void poller.prime().catch((error: unknown) => {
          options.onError?.(error, 'github.prime');
          app.log.error({ err: error }, 'could not reschedule the github poll');
        });
      });

      await poller.start();
    },

    async stop(): Promise<void> {
      unsubscribeBus?.();
      unsubscribeBus = null;
      await poller.stop();
      const unsubscribe = unsubscribeJobs;
      unsubscribeJobs = null;
      if (unsubscribe !== null) await unsubscribe();
    },
  };
}
