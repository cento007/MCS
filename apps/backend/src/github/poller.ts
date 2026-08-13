import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createJob, type Db, QUEUE_NAMES, type Queue, type Unsubscribe } from '@mc/shared';
import { listRepositoriesForPoll } from '../repositories/store.js';
import { readGithubIntegrationSettings } from './settings.js';
import type { RepositorySyncService, SyncOutcome } from './sync.js';

/**
 * The GitHub polling producer (TDS 02 §2: "commit/PR polling producers"; §7.7's `github_poll`
 * row; `integrations.github.syncIntervalMinutes`, §7.2).
 *
 * ## Why a pg-boss job and not a timer
 *
 * A `setInterval` would restart with the process and look identical from the outside — until
 * the moment it matters. The job is durable, so a tick scheduled before a restart is still
 * scheduled after it; a crash during a tick does not silently stop polling forever; and when the
 * producer moves to the Sync Worker in Phase 2 (F2.1) the queue is already the boundary, so only
 * the envelope's `source` changes.
 *
 * ## Self-rescheduling, not cron
 *
 * Each tick enqueues the next one before it returns, delayed by the configured interval. That
 * is what makes the interval *the setting's* interval rather than a cron expression's — the
 * registry admits any number of minutes up to a day, and a cron step field cannot express most
 * of them (a step of 7 minutes restarts at every hour boundary; 90 minutes is not expressible).
 *
 * **A restart cannot multiply the chain.** The next tick's job id is derived deterministically
 * from the interval bucket it targets (`tickJobId`), and the pg-boss driver inserts jobs with
 * `ON CONFLICT (name, id) DO NOTHING`. So `start()` priming a tick after a restart, while the
 * previous chain's tick is still pending for the same bucket, is a no-op instead of a second
 * chain. Without this, every `tsx watch` reload during development would add another poller.
 *
 * ## Overlap
 *
 * Two guards, at different scopes:
 *
 *  - **Between ticks**: `localConcurrency: 1` on the queue, so this process handles one tick at
 *    a time. A tick that runs long simply delays the next; it never runs beside it.
 *  - **Per repository**: `RepositorySyncService`'s in-flight set. A repository that an operator
 *    is syncing by hand right now is answered `skipped: 'in_flight'` by the tick and picked up
 *    next time. This is the guard that matters, because `POST /sync` and the tick are different
 *    entry points into the same work.
 *
 * ## `syncIntervalMinutes: 0` means manual only
 *
 * The tick does nothing and **does not reschedule** — the chain stops. It is restarted by
 * `prime()`, which `registerGithub` calls when `setting.updated` names the GitHub integration.
 * A chain that kept ticking to re-read a setting that says "do not poll" would be a poller that
 * cannot be turned off.
 */

/** Repositories one tick will sync, at most. Beyond this the next tick continues. */
export const MAX_REPOSITORIES_PER_TICK = 25;

/** The `github.poll` job payload. A job name, not an event — it carries no F6 envelope. */
export type GithubPollJob = {
  /** The interval, in minutes, that scheduled this tick. Diagnostic only. */
  readonly intervalMinutes: number;
  readonly scheduledFor: string;
};

export interface TickSummary {
  readonly ran: boolean;
  readonly reason: 'ok' | 'manual_only' | 'not_configured';
  readonly considered: number;
  readonly outcomes: readonly SyncOutcome[];
  readonly nextTickAt: string | null;
}

export interface GithubPollerOptions {
  readonly db: Db;
  readonly queue: Queue;
  readonly sync: RepositorySyncService;
  readonly now?: (() => Date) | undefined;
  readonly maxRepositoriesPerTick?: number | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly onTick?: ((summary: TickSummary) => void) | undefined;
}

export class GithubPoller {
  readonly #db: Db;
  readonly #queue: Queue;
  readonly #sync: RepositorySyncService;
  readonly #now: () => Date;
  readonly #maxPerTick: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onTick: ((summary: TickSummary) => void) | undefined;

  #unsubscribe: Unsubscribe | null = null;
  #stopping = false;

  constructor(options: GithubPollerOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#sync = options.sync;
    this.#now = options.now ?? (() => new Date());
    this.#maxPerTick = options.maxRepositoriesPerTick ?? MAX_REPOSITORIES_PER_TICK;
    this.#onError = options.onError;
    this.#onTick = options.onTick;
  }

  /** Subscribe the tick consumer and make sure a tick is scheduled. */
  async start(): Promise<void> {
    this.#stopping = false;

    this.#unsubscribe ??= await this.#queue.subscribeJobs<GithubPollJob>(
      QUEUE_NAMES.GITHUB_POLL,
      async () => {
        await this.tick();
      },
      // One tick at a time — see the module header.
      { concurrency: 1 },
    );

    await this.prime();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe !== null) await unsubscribe();
  }

  /**
   * Ensure a tick is scheduled, if polling is enabled at all.
   *
   * Safe to call repeatedly: the deterministic tick id makes a redundant call a no-op at the
   * database. Called at startup and whenever the GitHub settings change.
   */
  async prime(): Promise<void> {
    const settings = await readGithubIntegrationSettings(this.#db);
    if (settings.syncIntervalMinutes <= 0) return;
    await this.#schedule(settings.syncIntervalMinutes);
  }

  /**
   * One poll tick. Public because that is the seam a test drives — the queue is a delivery
   * mechanism, not the behaviour.
   *
   * Never throws for an ordinary failure: `RepositorySyncService.sync` records its own outcome
   * on the row, and a repository that fails does not stop the ones behind it.
   */
  async tick(): Promise<TickSummary> {
    const settings = await readGithubIntegrationSettings(this.#db);

    if (settings.syncIntervalMinutes <= 0) {
      // Manual only: no work, and no next tick. `prime()` restarts the chain if this changes.
      return summary('manual_only', false, 0, [], null);
    }

    if (!settings.tokenIsSet) {
      // Not a failure of any repository — Mission Control declined to ask. Nothing is written
      // and nothing is emitted; `/schedule` already reports `github_poll` as disabled.
      const next = await this.#schedule(settings.syncIntervalMinutes);
      return summary('not_configured', false, 0, [], next);
    }

    const repositories = await listRepositoriesForPoll(this.#db, { limit: this.#maxPerTick });
    const outcomes: SyncOutcome[] = [];

    for (const repository of repositories) {
      if (this.#stopping) break;
      try {
        outcomes.push(await this.#sync.sync(repository.id));
      } catch (error) {
        // The sync service turns GitHub and git conditions into data; reaching here means an
        // infrastructure failure (a dropped connection). One repository must not take the tick.
        this.#onError?.(error);
      }
    }

    const next = await this.#schedule(settings.syncIntervalMinutes);
    const result = summary('ok', true, repositories.length, outcomes, next);
    this.#onTick?.(result);
    return result;
  }

  /** Enqueue the next tick. Returns when it is due, or `null` if the poller is stopping. */
  async #schedule(intervalMinutes: number): Promise<string | null> {
    if (this.#stopping) return null;

    const intervalMs = intervalMinutes * 60_000;
    const scheduledFor = new Date(this.#now().getTime() + intervalMs);

    // The job row must be inserted transactionally like any other (F3's `QueuePort` has no
    // fire-and-forget overload, deliberately). This transaction writes nothing else, which is
    // the honest shape: scheduling the next tick is the only durable effect.
    await this.#db.transaction(async (tx) => {
      await this.#queue.enqueueJob<GithubPollJob>(
        tx,
        QUEUE_NAMES.GITHUB_POLL,
        createJob<GithubPollJob>(
          { intervalMinutes, scheduledFor: scheduledFor.toISOString() },
          tickJobId(scheduledFor, intervalMs),
          { startAfterSeconds: Math.max(1, Math.round(intervalMs / 1000)) },
        ),
      );
    });

    return scheduledFor.toISOString();
  }
}

/**
 * A deterministic job id for the tick that targets `scheduledFor`, bucketed by the interval.
 *
 * Two callers that want a tick in "the same interval-sized slot" produce the same id, so
 * pg-boss's `ON CONFLICT (name, id) DO NOTHING` collapses them into one job. That is what makes
 * `prime()` idempotent across restarts without needing to query pg-boss's own tables — which
 * are vendored and not ours to read (TDS 03 §7.1).
 *
 * A name-based UUID (RFC 4122 §4.3 construction, SHA-256 truncated instead of SHA-1) rather
 * than a random one: the *value* only has to be a stable function of the bucket, and pg-boss's
 * `id` column is a `uuid`, so the version and variant bits are set to keep it well-formed.
 */
export function tickJobId(scheduledFor: Date, bucketMs: number): string {
  const bucket = Math.floor(scheduledFor.getTime() / Math.max(1, bucketMs));
  const digest = createHash('sha256')
    .update(`${QUEUE_NAMES.GITHUB_POLL}:${String(bucketMs)}:${String(bucket)}`)
    .digest();

  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 5 (name-based) and RFC 4122 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function summary(
  reason: TickSummary['reason'],
  ran: boolean,
  considered: number,
  outcomes: readonly SyncOutcome[],
  nextTickAt: string | null,
): TickSummary {
  return { ran, reason, considered, outcomes, nextTickAt };
}
