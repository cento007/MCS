import { eq } from 'drizzle-orm';
import { type Db, schema } from '../db/index.js';
import type { SyncRunStatsShape } from '../entities/adr.js';
import { type AppliedItem, type ApplyOptions, applyPlanItem } from './apply.js';
import { recordSyncAudit } from './audit.js';
import { buildDesiredNotes } from './desired.js';
import { ensureDirectory, inspectVault, type VaultProblemKind, vaultAbsolutePath } from './fs.js';
import { MANAGED_ENTITY_TYPES, MANAGED_FOLDERS } from './layout.js';
import { type LedgerStatus, readLedger, upsertLedgerEntry } from './ledger.js';
import {
  type ConflictResolution,
  type LedgerEntry,
  type PlanItem,
  planSync,
  type SyncPlan,
} from './plan.js';
import { type AdrNoteInput, canonicalAdrHash } from './render.js';
import { type ScanBounds, scanVault } from './scan.js';
import {
  type ObsidianSyncSettings,
  type SyncBlockedReason,
  syncBlockedReason,
} from './settings.js';

/**
 * One Obsidian sync, start to finish.
 *
 * ```
 * settings ─▶ blocked?  ─▶ vault reachable? ─▶ scan (bounded) ─▶ desired notes (DB)
 *                                                                      │
 *                                            ledger (DB) ──────────────┤
 *                                                                      ▼
 *                                                                  planSync
 *                                                                      │
 *                              dry run ◀── plan only ─────────────────┤
 *                                                                      ▼
 *                                                 per item: conflict copy → atomic write
 *                                                           → one transaction (import,
 *                                                             audit, ledger, adr path)
 * ```
 *
 * ## Why the writes are one transaction *per file*
 *
 * Because a run can be interrupted — by `SIGTERM`, by the vault going away halfway, by the
 * machine. A single run-wide transaction would mean either "all fifty notes or none", which is
 * not achievable anyway (the filesystem is not in the transaction), or a ledger that claims
 * files were written that were not. Per file, the ledger is always an accurate description of
 * the vault, and an interrupted run simply resumes: the next one sees the notes already
 * written as `in_sync` and picks up where the last one stopped.
 *
 * ## What this function never does
 *
 * It never deletes a note, never renames one, and never writes over a file it did not first
 * copy aside when the file was not byte-for-byte what Mission Control last wrote. Deleting an
 * entity does not delete its note; deleting a note does not delete its entity.
 */

export type SyncProblemKind = VaultProblemKind | 'scan_truncated';

export interface SyncProblem {
  readonly kind: SyncProblemKind;
  readonly detail: string;
}

export interface ConflictReport {
  readonly vaultPath: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly resolution: ConflictResolution;
  /** Where the losing vault version was preserved. `null` when nothing was overwritten. */
  readonly backupPath: string | null;
  readonly reason: string;
}

export interface FileErrorReport {
  readonly vaultPath: string;
  readonly entityId: string;
  readonly error: string;
}

export interface SyncOutcome {
  readonly stats: SyncRunStatsShape;
  readonly conflicts: readonly ConflictReport[];
  readonly errors: readonly FileErrorReport[];
  /** Set when the run could not proceed at all. The caller fails the SyncRun with it. */
  readonly problem: SyncProblem | null;
  /** Set when settings say not to sync (paused / no vault path). Not a failure. */
  readonly skipped: SyncBlockedReason | null;
  /** The plan, always present when the run got as far as planning. */
  readonly plan: SyncPlan | null;
  /** True when the abort signal stopped the run between files. */
  readonly interrupted: boolean;
  readonly dryRun: boolean;
}

export interface SyncEngineOptions {
  readonly db: Db;
  readonly settings: ObsidianSyncSettings;
  readonly now?: () => Date;
  /** Plan and report, write nothing — anywhere. The preview endpoint's only mode. */
  readonly dryRun?: boolean;
  /** Aborted on shutdown; checked between files, never during one. */
  readonly signal?: AbortSignal;
  readonly bounds?: ScanBounds;
  readonly maxSessionNotes?: number;
  /** The SyncRun this belongs to, recorded on audit rows. */
  readonly syncRunId?: string;
  /** Forwarded to the atomic writer — the crash-between-write-and-rename test seam. */
  readonly write?: ApplyOptions['write'];
  readonly onItem?: (applied: AppliedItem) => void;
}

const EMPTY_STATS: SyncRunStatsShape = { notesExported: 0, notesImported: 0, conflicts: 0 };

export async function runObsidianSync(options: SyncEngineOptions): Promise<SyncOutcome> {
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  const { db, settings } = options;

  const blocked = syncBlockedReason(settings);
  if (blocked !== null) {
    return {
      stats: EMPTY_STATS,
      conflicts: [],
      errors: [],
      problem: null,
      skipped: blocked,
      plan: null,
      interrupted: false,
      dryRun,
    };
  }

  // `syncBlockedReason` already established this is a non-empty path.
  const vaultPath = settings.vaultPath as string;

  const inspection = await inspectVault(vaultPath, { requireWritable: !dryRun });
  if (!inspection.ok) {
    return {
      stats: EMPTY_STATS,
      conflicts: [],
      errors: [],
      problem: { kind: inspection.kind, detail: inspection.detail },
      skipped: null,
      plan: null,
      interrupted: false,
      dryRun,
    };
  }

  const scan = await scanVault(vaultPath, options.bounds ?? {});
  if (scan.truncated) {
    // Deciding on a partial listing is how a vault acquires a second copy of every note.
    return {
      stats: EMPTY_STATS,
      conflicts: [],
      errors: [],
      problem: {
        kind: 'scan_truncated',
        detail: `the vault scan stopped early: ${scan.truncatedReason ?? 'bounds exceeded'}`,
      },
      skipped: null,
      plan: null,
      interrupted: false,
      dryRun,
    };
  }

  const [desired, ledgerRows] = await Promise.all([
    buildDesiredNotes(db, {
      ...(options.maxSessionNotes === undefined
        ? {}
        : { maxSessionNotes: options.maxSessionNotes }),
    }),
    readLedger(db, MANAGED_ENTITY_TYPES),
  ]);

  const plan = planSync({
    desired: desired.notes,
    scan,
    ledger: ledgerRows,
    syncMode: settings.syncMode,
    conflictPolicy: settings.conflictPolicy,
  });

  if (dryRun) {
    return {
      stats: {
        notesExported: plan.counts.create + plan.counts.update,
        notesImported: plan.counts.import,
        conflicts: plan.counts.conflict,
      },
      conflicts: plan.items.filter(isConflict).map((item) => conflictReport(item, null)),
      errors: plan.items
        .filter((item) => item.action === 'error')
        .map((item) => ({
          vaultPath: item.vaultPath,
          entityId: item.entityId,
          error: item.error ?? 'unreadable',
        })),
      problem: null,
      skipped: null,
      plan,
      interrupted: false,
      dryRun: true,
    };
  }

  // Only the folders V1 manages, and only when there is something to put in them.
  if (plan.counts.create > 0) {
    for (const folder of MANAGED_FOLDERS) {
      await ensureDirectory(vaultAbsolutePath(vaultPath, folder));
    }
  }

  const previous = new Map<string, LedgerEntry>();
  for (const entry of ledgerRows) {
    if (entry.entityId !== null) previous.set(entry.entityId, entry);
  }

  const conflicts: ConflictReport[] = [];
  const errors: FileErrorReport[] = [];
  let notesExported = 0;
  let notesImported = 0;
  let interrupted = false;

  for (const item of plan.items) {
    if (options.signal?.aborted === true) {
      interrupted = true;
      break;
    }

    const applied = await applyPlanItem(vaultPath, item, {
      now,
      ...(options.write === undefined ? {} : { write: options.write }),
    });
    options.onItem?.(applied);

    if (applied.outcome === 'written') notesExported += 1;
    // Both halves of "this file did not work": the write failed, or the file could not be read
    // in the first place (and was therefore deliberately not overwritten).
    if (applied.outcome === 'failed' || item.action === 'error') {
      errors.push({
        vaultPath: item.vaultPath,
        entityId: item.entityId,
        error: applied.error ?? item.error ?? 'write failed',
      });
    }

    const persisted = await persistItem({
      db,
      applied,
      previous: previous.get(item.entityId) ?? null,
      adr: desired.adrs.get(item.entityId) ?? null,
      now: now(),
      ...(options.syncRunId === undefined ? {} : { syncRunId: options.syncRunId }),
    });

    if (persisted.imported) notesImported += 1;
    if (isConflict(item)) conflicts.push(conflictReport(item, applied.backupPath));
  }

  return {
    stats: { notesExported, notesImported, conflicts: conflicts.length },
    conflicts,
    errors,
    problem: null,
    skipped: null,
    plan,
    interrupted,
    dryRun: false,
  };
}

function isConflict(item: PlanItem): boolean {
  return item.action === 'conflict';
}

function conflictReport(item: PlanItem, backupPath: string | null): ConflictReport {
  return {
    vaultPath: item.vaultPath,
    entityType: item.entityType,
    entityId: item.entityId,
    resolution: item.resolution ?? 'manual_pending',
    backupPath,
    reason: item.reason,
  };
}

interface PersistInput {
  readonly db: Db;
  readonly applied: AppliedItem;
  readonly previous: LedgerEntry | null;
  readonly adr: AdrNoteInput | null;
  readonly now: Date;
  readonly syncRunId?: string;
}

/**
 * The database half of one file: the import (if any), its audit row, the ledger row, and the
 * ADR's denormalised `obsidian_path` — in one transaction, so a crash cannot leave an ADR
 * claiming a note that was never recorded.
 *
 * ## Why the ADR is written at most once, and why `updated_at` is pinned
 *
 * `updated_at` is part of the note's front matter, so it is part of the canonical projection,
 * so it is part of `mc_hash`. A second `UPDATE` that touched nothing but `obsidian_path` would
 * still bump it — and the next run would see a changed projection, rewrite the note, bump it
 * again, and rewrite forever. Every sync would report exports it did not need to make and the
 * operator's vault would churn on a timer. So there is exactly one `UPDATE` per ADR per file,
 * it carries an explicit `updated_at` (Drizzle's `$onUpdate` would otherwise supply `now`), and
 * it does not run at all when there is nothing to change.
 */
async function persistItem(input: PersistInput): Promise<{ imported: boolean }> {
  const { db, applied, previous, now } = input;
  const { item } = applied;

  return db.transaction(async (tx) => {
    let imported = false;
    let mcHash = item.canonicalHash;
    let vaultHash = applied.vaultHash;
    let vaultMtime = applied.vaultMtime;
    let lastError: string | null = null;

    const adr = input.adr;
    const adrChangesToWrite: Record<string, unknown> = {};
    // Pinned to the value the projection was rendered from — see the header.
    let effectiveUpdatedAt = adr?.updatedAt ?? now;

    if (item.import !== null && adr !== null) {
      const merged = mergeAdrImport(adr, item);
      const changed = adrChanges(adr, merged);

      if (Object.keys(changed.after).length > 0) {
        Object.assign(adrChangesToWrite, changed.after);
        effectiveUpdatedAt = now;

        // The ONLY copy of the fields the vault just overwrote. Without this row, an
        // `obsidian_wins` resolution is unrecoverable data loss on the database side.
        await recordSyncAudit(tx, {
          action: 'adr.imported',
          entityType: 'adrs',
          entityId: adr.id,
          before: changed.before,
          after: changed.after,
          syncRunId: input.syncRunId ?? null,
        });

        imported = true;
      }

      // Re-hash from the values now in the database, so the next run sees no phantom change.
      mcHash = canonicalAdrHash({ ...merged, updatedAt: effectiveUpdatedAt });
      vaultHash = item.fileHash;
      vaultMtime = item.fileMtime;
      lastError = item.import.warning;
    }

    if (item.action === 'conflict') {
      await recordSyncAudit(tx, {
        action:
          item.resolution === 'manual_pending'
            ? 'obsidian.conflict_detected'
            : 'obsidian.conflict_resolved',
        entityType: 'obsidian_sync_states',
        entityId: item.entityId,
        after: {
          vaultPath: item.vaultPath,
          resolution: item.resolution,
          backupPath: applied.backupPath,
          reason: item.reason,
        },
        syncRunId: input.syncRunId ?? null,
      });
    }

    const status = ledgerStatus(applied, imported);

    // An unresolved conflict, a deferred pull and an unreadable file all keep the hashes they
    // had: overwriting them would mark the situation resolved when nothing was resolved, and
    // the next run would sail past it.
    const keepHashes = status === 'conflict' || status === 'pending_pull' || status === 'error';

    await upsertLedgerEntry(tx, {
      ledgerId: item.ledgerId,
      vaultPath: item.vaultPath,
      entityType: item.entityType,
      entityId: item.entityId,
      mcHash: keepHashes ? (previous?.mcHash ?? null) : mcHash,
      vaultHash: keepHashes ? (previous?.vaultHash ?? item.fileHash) : vaultHash,
      vaultMtime: keepHashes ? (previous?.vaultMtime ?? item.fileMtime) : vaultMtime,
      status,
      lastSyncedAt: status === 'in_sync' ? now : (previous?.lastSyncedAt ?? null),
      lastError: applied.error ?? lastError ?? item.error,
    });

    if (
      item.entityType === 'adr' &&
      applied.outcome !== 'failed' &&
      adr !== null &&
      adr.obsidianPath !== item.vaultPath
    ) {
      adrChangesToWrite['obsidianPath'] = item.vaultPath;
    }

    if (Object.keys(adrChangesToWrite).length > 0) {
      await tx
        .update(schema.adrs)
        .set({ ...adrChangesToWrite, updatedAt: effectiveUpdatedAt })
        .where(eq(schema.adrs.id, item.entityId));
    }

    return { imported };
  });
}

function ledgerStatus(applied: AppliedItem, imported: boolean): LedgerStatus {
  if (applied.outcome === 'failed') return 'error';

  switch (applied.item.action) {
    case 'error':
      return 'error';
    case 'pending_pull':
      return 'pending_pull';
    case 'conflict':
      // Resolved in either direction ⇒ the file and the row now agree. Only a conflict nothing
      // was done about stays `conflict` — which is exactly what the Settings panel counts.
      return applied.outcome === 'written' || imported ? 'in_sync' : 'conflict';
    default:
      return 'in_sync';
  }
}

function mergeAdrImport(adr: AdrNoteInput, item: PlanItem): AdrNoteInput {
  const imported = item.import;
  if (imported === null) return adr;

  return {
    ...adr,
    title: imported.title ?? adr.title,
    status: imported.status ?? adr.status,
    context: imported.context ?? adr.context,
    decision: imported.decision ?? adr.decision,
    alternatives: imported.alternatives ?? adr.alternatives,
    consequences: imported.consequences ?? adr.consequences,
  };
}

const IMPORTABLE_ADR_FIELDS = [
  'title',
  'status',
  'context',
  'decision',
  'alternatives',
  'consequences',
] as const;

/** Only the fields this import actually changes, so the audit row is a diff (TDS 03 §3.14). */
function adrChanges(
  before: AdrNoteInput,
  after: AdrNoteInput,
): { before: Record<string, unknown>; after: Record<string, string> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, string> = {};

  for (const field of IMPORTABLE_ADR_FIELDS) {
    if (before[field] === after[field]) continue;
    changedBefore[field] = before[field];
    changedAfter[field] = after[field];
  }

  return { before: changedBefore, after: changedAfter };
}
