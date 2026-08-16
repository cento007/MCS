import {
  createJob,
  type Db,
  findLatestSyncRun,
  insertSyncRun,
  isScheduledSyncDue,
  isUniqueViolation,
  type JobPayload,
  type Logger,
  newId,
  QUEUE_NAMES,
  type QueuePort,
  readObsidianSettings,
  reclaimAbandonedSyncRuns,
  SYNC_RUNS_ACTIVE_CONSTRAINT,
  type SyncRunTrigger,
} from '@mc/shared';
import type { SyncJob } from './sync.js';

/**
 * The `obsidian.schedule` tick — `integrations.obsidian.syncIntervalMinutes` (TDS 04 §7.7),
 * and the thing that makes the Dashboard's `obsidian_sync` schedule row true rather than a
 * promise.
 *
 * **Self-rescheduling, exactly like `github.poll` and `notification.schedule`:** the tick
 * enqueues its own successor before it returns, so the chain survives a restart where a
 * `setInterval` would not, and the interval is re-read from settings on every tick so a change
 * in the Settings page takes effect within one tick instead of at the next fire.
 *
 * ## It also reclaims abandoned runs, and that is not housekeeping
 *
 * `ux_sync_runs_active` admits one non-terminal run. A process killed mid-run leaves a
 * `running` row behind, and from then on **every** trigger — manual or scheduled — answers
 * `409 CONFLICT` forever. Reclaiming stale rows on each tick turns that from "an operator must
 * run SQL" into "it fixes itself within a minute".
 */

/** One tick a minute: fine-grained enough for a 5-minute interval, cheap enough to ignore. */
export const TICK_INTERVAL_SECONDS = 60;

/** A run whose row has not been touched for this long is presumed dead. */
export const ABANDONED_RUN_AGE_MS = 15 * 60_000;

export type ScheduleTickJob = Record<string, never>;

export interface TickSummary {
  readonly reclaimed: number;
  /** The SyncRun this tick created, if it was due. */
  readonly triggeredRunId: string | null;
  readonly rescheduled: boolean;
}

export interface SchedulerOptions {
  readonly db: Db;
  readonly queue: QueuePort;
  readonly logger: Logger;
  readonly now?: (() => Date) | undefined;
  readonly tickIntervalSeconds?: number | undefined;
  readonly abandonedRunAgeMs?: number | undefined;
}

export class SyncScheduler {
  readonly #db: Db;
  readonly #queue: QueuePort;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #tickIntervalSeconds: number;
  readonly #abandonedRunAgeMs: number;

  /** Set on shutdown so a tick in flight does not enqueue a successor nobody will run. */
  #stopping = false;

  constructor(options: SchedulerOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#tickIntervalSeconds = options.tickIntervalSeconds ?? TICK_INTERVAL_SECONDS;
    this.#abandonedRunAgeMs = options.abandonedRunAgeMs ?? ABANDONED_RUN_AGE_MS;
  }

  setStopping(stopping: boolean): void {
    this.#stopping = stopping;
  }

  async tick(): Promise<TickSummary> {
    const now = this.#now();

    const reclaimed = await reclaimAbandonedSyncRuns(this.#db, {
      now,
      olderThanMs: this.#abandonedRunAgeMs,
    });
    if (reclaimed > 0) {
      this.#logger.warn({ reclaimed }, 'failed sync runs left behind by a previous process');
    }

    const settings = await readObsidianSettings(this.#db);
    const latest = await findLatestSyncRun(this.#db);

    // A run still in flight is itself the reason not to start another; the partial unique index
    // would refuse anyway, but asking first keeps a predictable 409 out of the worker's log.
    const inFlight = latest !== null && (latest.state === 'queued' || latest.state === 'running');

    const due =
      !inFlight &&
      isScheduledSyncDue({
        settings,
        lastRunAt: latest?.completedAt ?? latest?.createdAt ?? null,
        now,
      });

    const triggeredRunId = due ? await this.#trigger('schedule') : null;
    const rescheduled = await this.#rescheduleSelf();

    return { reclaimed, triggeredRunId, rescheduled };
  }

  /**
   * Insert the run and enqueue its job in one transaction (F6.3). A `23505` means a manual
   * trigger won the race in the same instant — the operator's sync is running, which is the
   * outcome the scheduler wanted anyway.
   *
   * The guard goes through `isUniqueViolation` rather than reading `error.code` directly, and
   * that is not style: Drizzle 0.45 wraps every query failure in a `DrizzleQueryError` and puts
   * the `pg` error on `cause`, so the top-level `code` is `undefined` and the naive check never
   * matched. The expected race therefore *rethrew* — failing the tick and retaining a failed
   * `obsidian.schedule` job on every worker start, visible only as a red count on the Dashboard.
   * The Backend had already paid for this exact trap; the predicate now lives in `shared` so a
   * third package cannot learn it a third time.
   */
  async #trigger(trigger: SyncRunTrigger): Promise<string | null> {
    try {
      return await this.#db.transaction(async (tx) => {
        const run = await insertSyncRun(tx, { trigger });
        await this.#queue.enqueueJob<SyncJob & JobPayload>(
          tx,
          QUEUE_NAMES.OBSIDIAN_SYNC,
          createJob<SyncJob & JobPayload>({ syncRunId: run.id }, run.id),
        );
        return run.id;
      });
    } catch (error) {
      if (isUniqueViolation(error, SYNC_RUNS_ACTIVE_CONSTRAINT)) {
        this.#logger.debug('a sync run was created by someone else first');
        return null;
      }
      throw error;
    }
  }

  async #rescheduleSelf(): Promise<boolean> {
    if (this.#stopping) return false;

    await this.#db.transaction(async (tx) => {
      await this.#queue.enqueueJob<ScheduleTickJob & JobPayload>(
        tx,
        QUEUE_NAMES.OBSIDIAN_SCHEDULE,
        createJob<ScheduleTickJob & JobPayload>({}, newId(), {
          startAfterSeconds: this.#tickIntervalSeconds,
        }),
      );
    });

    return true;
  }
}
