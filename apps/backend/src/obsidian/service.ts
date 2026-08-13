import {
  createJob,
  type Db,
  findSyncRun,
  insertSyncRun,
  type JobPayload,
  listSyncRuns,
  type ObsidianSyncMode,
  QUEUE_NAMES,
  type QueuePort,
  readConflictedFiles,
  readErroredFiles,
  readObsidianSettings,
  runObsidianSync,
  type ScanBounds,
  SYNC_RUN_KIND,
  type SyncPlan,
  syncBlockedReason,
} from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import {
  isCheckViolation,
  isUniqueViolation,
  SYNC_RUN_KIND_CONSTRAINT,
  syncRunKindRejected,
} from '../db/index.js';
import type { Outbox } from '../events/index.js';
import type { RequestContext } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import {
  type SyncRunDetailResource,
  type SyncRunResource,
  serializeFileDetail,
  serializeSyncRun,
} from './serialize.js';

/**
 * Obsidian sync — the Backend half (TDS 04 §10).
 *
 * The Backend **triggers** runs and **reports** them; it never performs one. Writing to the
 * operator's vault happens in exactly one process, the Sync Worker, and the two communicate
 * only through the queue (F2.2). `POST /sync-runs` therefore does two things in one
 * transaction — insert the run row and enqueue its job — and answers `202`.
 *
 * ## The one place the Backend touches the vault: the dry run
 *
 * `GET /sync-runs/preview` reads the vault (scan + plan) and writes nothing, anywhere: no
 * files, no ledger rows, no SyncRun. It exists because "what will this do to my vault" is a
 * question that has to be answered *before* the first sync of a vault that already has notes
 * in it, and answering it through a queued job would mean the answer arrives after the
 * operator has stopped looking. It runs the same planner the worker runs — not a second
 * implementation that approximates it.
 *
 * The preview costs a bounded directory walk inside a request, exactly like repository
 * discovery does (`github/discovery.ts`), and carries the same four bounds plus a byte cap.
 */

/** Tighter than the worker's: this one runs inside an HTTP request. */
const PREVIEW_BOUNDS: ScanBounds = { deadlineMs: 15_000, maxFiles: 5_000 };

/** Enough to see what a first sync would do without shipping a megabyte of JSON. */
export const MAX_PREVIEW_ITEMS = 500;

/** The `obsidian.sync` job payload — a job, not an event (TDS 04 §15.2). */
export type ObsidianSyncJob = { readonly syncRunId: string };

export interface SyncPreviewItem {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly vaultPath: string;
  readonly reason: string;
  readonly resolution: string | null;
  /** True when running for real would first copy the vault's version aside. */
  readonly wouldKeepVaultCopy: boolean;
}

export interface SyncPreview {
  readonly vaultPath: string;
  /** The mode the plan was computed with. */
  readonly syncMode: ObsidianSyncMode;
  readonly conflictPolicy: string;
  /**
   * True when syncing is switched off. The preview is still computed — seeing what a sync
   * *would* do is most useful precisely when you have not turned it on yet — and this flag is
   * what stops the answer being mistaken for something that is about to happen.
   */
  readonly paused: boolean;
  readonly problem: { readonly kind: string; readonly detail: string } | null;
  readonly summary: {
    readonly create: number;
    readonly update: number;
    readonly import: number;
    readonly inSync: number;
    readonly conflict: number;
    readonly pendingPull: number;
    readonly error: number;
    /** Notes in the managed folders that carry no Mission Control id. Never touched. */
    readonly unmanaged: number;
  };
  readonly items: readonly SyncPreviewItem[];
  readonly itemsTruncated: boolean;
  /** Notes claiming an id another note already claims — a copied or restored file. */
  readonly duplicateIdPaths: readonly string[];
}

export interface ObsidianServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: QueuePort;
  readonly scanBounds?: ScanBounds | undefined;
}

export class ObsidianService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #queue: QueuePort;
  readonly #scanBounds: ScanBounds;

  constructor(options: ObsidianServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#queue = options.queue;
    this.#scanBounds = options.scanBounds ?? PREVIEW_BOUNDS;
  }

  /**
   * `POST /api/v1/sync-runs` -> `202` (§10).
   *
   * `INTEGRATION_NOT_CONFIGURED` covers both "no vault path" and "sync is paused": in both the
   * operator has told the system not to sync, and the `details.reason` says which, so the UI
   * can link to the right settings field instead of showing a generic refusal.
   *
   * `CONFLICT` when a run is already queued or running — and that is decided by
   * `ux_sync_runs_active`, not by a prior `SELECT`. The thing being raced for is write access
   * to the vault, so the guarantee has to be the database's.
   */
  async trigger(principal: Principal, ctx: RequestContext): Promise<SyncRunResource> {
    const settings = await readObsidianSettings(this.#db);
    const blocked = syncBlockedReason(settings);
    if (blocked !== null) {
      throw new ApiError(
        'INTEGRATION_NOT_CONFIGURED',
        blocked === 'vault_path_missing'
          ? 'No Obsidian vault path is configured'
          : 'Obsidian sync is paused',
        { reason: blocked },
      );
    }

    try {
      const row = await this.#outbox.run(async (tx) => {
        const run = await insertSyncRun(tx.tx, { trigger: 'user' });

        // The job id IS the run id: pg-boss inserts `ON CONFLICT (name, id) DO NOTHING`, so a
        // retried request that somehow reached here twice cannot queue two syncs of one run.
        await this.#queue.enqueueJob<ObsidianSyncJob & JobPayload>(
          tx.tx,
          QUEUE_NAMES.OBSIDIAN_SYNC,
          createJob<ObsidianSyncJob & JobPayload>({ syncRunId: run.id }, run.id),
        );

        await recordAuditEntry(tx.tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'sync.triggered',
          entityType: 'sync_runs',
          entityId: run.id,
          after: { kind: 'obsidian', trigger: 'user' },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });

        return run;
      });

      return serializeSyncRun(row);
    } catch (error) {
      if (isUniqueViolation(error, 'ux_sync_runs_active')) {
        throw new ApiError('CONFLICT', 'An Obsidian sync is already queued or running');
      }
      // The same schema-drift translation the memory backfill does, for the same reason: the
      // `kind` written here is a constant, so a `23514` on it can only mean the table's CHECK
      // is not the one this build expects. `obsidian` has been an accepted kind since migration
      // `0000`, so a *pending* migration is a less likely cause here than an altered
      // constraint — which is exactly why the message names the usual cause rather than
      // asserting one.
      if (isCheckViolation(error, SYNC_RUN_KIND_CONSTRAINT)) {
        throw syncRunKindRejected(SYNC_RUN_KIND);
      }
      throw error;
    }
  }

  /** `GET /api/v1/sync-runs` — cursor list, newest first (§10). */
  async list(input: {
    readonly limit: number;
    readonly beforeId?: string | undefined;
  }): Promise<SyncRunResource[]> {
    const rows = await listSyncRuns(this.#db, {
      limit: input.limit,
      ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
    });
    return rows.map(serializeSyncRun);
  }

  /** `GET /api/v1/sync-runs/{id}` — the run plus what is still unresolved (§10). */
  async get(id: string): Promise<SyncRunDetailResource> {
    const row = await findSyncRun(this.#db, id);
    if (row === null) throw new ApiError('NOT_FOUND', `No sync run with id ${id}`);

    const [conflicts, errors] = await Promise.all([
      readConflictedFiles(this.#db),
      readErroredFiles(this.#db),
    ]);

    return {
      ...serializeSyncRun(row),
      conflicts: conflicts.map(serializeFileDetail),
      errors: errors.map(serializeFileDetail),
    };
  }

  /**
   * `GET /api/v1/sync-runs/preview` — the dry run.
   *
   * ⚠ **Not in TDS 04 §10 — flagged, not smuggled in.** §10 defines the trigger and the two
   * reads and no way to find out what a sync would do first. A two-way sync's first contact
   * with a vault that already contains notes is exactly where an operator wants to look before
   * they leap, and where a wrong guess costs them their own writing.
   */
  async preview(): Promise<SyncPreview> {
    const settings = await readObsidianSettings(this.#db);

    if (settings.vaultPath === null || settings.vaultPath.trim().length === 0) {
      throw new ApiError('INTEGRATION_NOT_CONFIGURED', 'No Obsidian vault path is configured', {
        reason: 'vault_path_missing',
      });
    }

    const paused = settings.syncMode === 'paused';
    const syncMode: ObsidianSyncMode = paused ? 'two_way' : settings.syncMode;

    const outcome = await runObsidianSync({
      db: this.#db,
      settings: { ...settings, syncMode },
      dryRun: true,
      bounds: this.#scanBounds,
    });

    return {
      vaultPath: settings.vaultPath,
      syncMode,
      conflictPolicy: settings.conflictPolicy,
      paused,
      problem: outcome.problem,
      summary: summarize(outcome.plan),
      items: previewItems(outcome.plan),
      itemsTruncated: (outcome.plan?.items.length ?? 0) > MAX_PREVIEW_ITEMS,
      duplicateIdPaths: outcome.plan?.duplicateIdPaths ?? [],
    };
  }
}

function summarize(plan: SyncPlan | null): SyncPreview['summary'] {
  if (plan === null) {
    return {
      create: 0,
      update: 0,
      import: 0,
      inSync: 0,
      conflict: 0,
      pendingPull: 0,
      error: 0,
      unmanaged: 0,
    };
  }

  return {
    create: plan.counts.create,
    update: plan.counts.update,
    import: plan.counts.import,
    inSync: plan.counts.inSync,
    conflict: plan.counts.conflict,
    pendingPull: plan.counts.pendingPull,
    error: plan.counts.error,
    unmanaged: plan.unmanagedCount,
  };
}

function previewItems(plan: SyncPlan | null): SyncPreviewItem[] {
  if (plan === null) return [];

  return (
    plan.items
      // `in_sync` is the boring majority; a preview is about what would change.
      .filter((item) => item.action !== 'in_sync')
      .slice(0, MAX_PREVIEW_ITEMS)
      .map((item) => ({
        action: item.action,
        entityType: item.entityType,
        entityId: item.entityId,
        vaultPath: item.vaultPath,
        reason: item.reason,
        resolution: item.resolution,
        wouldKeepVaultCopy: item.backupRequired,
      }))
  );
}
