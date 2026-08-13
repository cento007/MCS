import {
  beginSyncRun,
  completeSyncRun,
  type Db,
  failSyncRun,
  type Logger,
  readObsidianSettings,
  runObsidianSync,
  type ScanBounds,
  type SyncOutcome,
  type SyncRunStatsShape,
} from '@mc/shared';
import type { WorkerOutbox } from './outbox.js';

/**
 * One Obsidian sync run, from queue job to `sync_runs` row.
 *
 * The algorithm itself is `@mc/shared/obsidian` (shared with the Backend's dry run); what this
 * file owns is the **run lifecycle**: claiming the run, emitting the F6 events, and making sure
 * the row always reaches a terminal state.
 *
 * ## Claiming, and why redelivery is safe
 *
 * `beginSyncRun` updates `WHERE state = 'queued'`. Delivery is at-least-once (F6.3), so the
 * second copy of a job updates zero rows, learns the run is not its to do, and returns without
 * touching the vault. That check is the whole idempotency story — no job-id bookkeeping, no
 * "have I seen this" table.
 *
 * ## The row always reaches a terminal state
 *
 * `ux_sync_runs_active` admits one non-terminal run per kind, so a run left `running` blocks
 * every future sync until somebody runs SQL. Every path out of `runOne` therefore completes or
 * fails the row — including the shutdown path, which fails it with a plain reason and returns
 * **normally** so pg-boss does not redeliver a job whose run is already closed. Nothing is
 * lost: files are written atomically and the ledger is committed per file, so the next run
 * resumes from the state the vault is actually in.
 */

/** The `obsidian.sync` payload (a job, not an event — TDS 04 §15.2). */
export type SyncJob = { readonly syncRunId: string };

/**
 * One `sync.conflict_detected` per conflicted file (§15.2 #26), capped.
 *
 * A first sync against a vault full of hand-written notes can conflict on hundreds of files;
 * the *count* is on the run row and in the ledger, so the per-file events are a convenience for
 * the UI feed and not the record of truth. Emitting eight hundred envelopes to say what one
 * number already says is how a queue backs up.
 */
export const MAX_CONFLICT_EVENTS = 50;

export type SyncResultKind =
  /** The run finished. It may still have conflicts and per-file errors. */
  | 'completed'
  /** The run could not proceed — vault gone, read-only, scan truncated. */
  | 'failed'
  /** Settings said not to sync (paused, or the vault path was cleared after the trigger). */
  | 'skipped'
  /** Somebody else already claimed this run — a redelivered job. */
  | 'ignored'
  /** Shutdown interrupted it between files. */
  | 'interrupted';

export interface SyncResult {
  readonly syncRunId: string;
  readonly kind: SyncResultKind;
  readonly stats: SyncRunStatsShape;
  readonly reason: string | null;
}

export interface SyncServiceOptions {
  readonly db: Db;
  readonly outbox: WorkerOutbox;
  readonly logger: Logger;
  readonly bounds?: ScanBounds | undefined;
  readonly maxSessionNotes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const NO_STATS: SyncRunStatsShape = { notesExported: 0, notesImported: 0, conflicts: 0 };

export class SyncService {
  readonly #db: Db;
  readonly #outbox: WorkerOutbox;
  readonly #logger: Logger;
  readonly #bounds: ScanBounds | undefined;
  readonly #maxSessionNotes: number | undefined;
  readonly #now: () => Date;

  constructor(options: SyncServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#logger = options.logger;
    this.#bounds = options.bounds;
    this.#maxSessionNotes = options.maxSessionNotes;
    this.#now = options.now ?? (() => new Date());
  }

  async runOne(job: SyncJob, signal?: AbortSignal): Promise<SyncResult> {
    const { syncRunId } = job;

    const claimed = await this.#outbox.run(async (ctx) => {
      const run = await beginSyncRun(ctx.tx, syncRunId, this.#now());
      if (run === null) return false;

      await ctx.emit(
        this.#outbox.event(
          'sync.started',
          { syncRunId, trigger: run.trigger },
          { correlationId: syncRunId },
        ),
      );
      return true;
    });

    if (!claimed) {
      this.#logger.debug({ syncRunId }, 'sync run was already claimed — redelivered job ignored');
      return { syncRunId, kind: 'ignored', stats: NO_STATS, reason: null };
    }

    let outcome: SyncOutcome;
    try {
      const settings = await readObsidianSettings(this.#db);
      outcome = await runObsidianSync({
        db: this.#db,
        settings,
        syncRunId,
        now: this.#now,
        ...(signal === undefined ? {} : { signal }),
        ...(this.#bounds === undefined ? {} : { bounds: this.#bounds }),
        ...(this.#maxSessionNotes === undefined ? {} : { maxSessionNotes: this.#maxSessionNotes }),
      });
    } catch (error) {
      // Anything the engine did not turn into data: a lost database connection, a bug. The run
      // must not be left `running`, so it is failed here and the error is re-thrown for the
      // worker's log — pg-boss will not retry (`retryLimit: 0`, see `queue.ts`).
      const reason = error instanceof Error ? error.message : String(error);
      await this.#fail(syncRunId, `sync failed unexpectedly: ${reason}`, NO_STATS);
      throw error;
    }

    if (outcome.skipped !== null) {
      // The trigger was accepted while syncing was enabled and it was switched off before the
      // worker got here. Completing with zeros is the truth: nothing was done, nothing failed.
      await this.#complete(syncRunId, NO_STATS);
      this.#logger.info({ syncRunId, reason: outcome.skipped }, 'sync skipped');
      return { syncRunId, kind: 'skipped', stats: NO_STATS, reason: outcome.skipped };
    }

    if (outcome.problem !== null) {
      const reason = `${outcome.problem.kind}: ${outcome.problem.detail}`;
      await this.#fail(syncRunId, reason, NO_STATS);
      this.#logger.warn({ syncRunId, problem: outcome.problem }, 'sync could not run');
      return { syncRunId, kind: 'failed', stats: NO_STATS, reason };
    }

    if (outcome.interrupted) {
      const reason = 'the sync worker shut down before this run finished';
      await this.#fail(syncRunId, reason, outcome.stats);
      this.#logger.warn({ syncRunId, ...outcome.stats }, 'sync interrupted by shutdown');
      return { syncRunId, kind: 'interrupted', stats: outcome.stats, reason };
    }

    await this.#complete(syncRunId, outcome.stats, outcome);

    if (outcome.errors.length > 0) {
      // Per-file failures do not fail the run — the rest of the vault was synced — but they are
      // on the ledger (`status = 'error'`) and `GET /sync-runs/{id}` returns them.
      this.#logger.warn(
        { syncRunId, errors: outcome.errors.length, first: outcome.errors[0] },
        'some notes could not be written',
      );
    }

    this.#logger.info(
      { syncRunId, ...outcome.stats, conflicts: outcome.conflicts.length },
      'sync completed',
    );

    return { syncRunId, kind: 'completed', stats: outcome.stats, reason: null };
  }

  async #complete(
    syncRunId: string,
    stats: SyncRunStatsShape,
    outcome?: SyncOutcome,
  ): Promise<void> {
    await this.#outbox.run(async (ctx) => {
      const completed = await completeSyncRun(ctx.tx, syncRunId, stats, this.#now());
      /* c8 ignore next — the run was claimed by this process moments ago */
      if (!completed) return;

      await ctx.emit(
        this.#outbox.event(
          'sync.completed',
          {
            syncRunId,
            notesExported: stats.notesExported,
            notesImported: stats.notesImported,
            conflicts: stats.conflicts,
          },
          { correlationId: syncRunId },
        ),
      );

      for (const conflict of (outcome?.conflicts ?? []).slice(0, MAX_CONFLICT_EVENTS)) {
        await ctx.emit(
          this.#outbox.event(
            'sync.conflict_detected',
            { syncRunId, path: conflict.vaultPath, resolution: conflict.resolution },
            { correlationId: syncRunId },
          ),
        );
      }
    });
  }

  async #fail(syncRunId: string, reason: string, stats: SyncRunStatsShape): Promise<void> {
    await this.#outbox.run(async (ctx) => {
      const failed = await failSyncRun(ctx.tx, syncRunId, reason, this.#now(), stats);
      if (!failed) return;

      await ctx.emit(
        this.#outbox.event('sync.failed', { syncRunId, reason }, { correlationId: syncRunId }),
      );
    });
  }
}
