import type { LedgerEntry, SyncRunRow, SyncRunState, SyncRunTrigger } from '@mc/shared';

/**
 * `SyncRun` — TDS 04 §10, verbatim — plus the per-file detail §10 promises on the detail route
 * ("incl. conflict details when `stats.conflicts > 0`").
 *
 * The detail comes from `obsidian_sync_states` at read time, exactly as TDS 03 §4.5 specifies:
 * the ledger holds *current* per-file state and the run holds the counts, and no FK joins them
 * because a file's conflict status is a fact about now, not about that run.
 */

export interface SyncRunResource {
  readonly id: string;
  readonly kind: 'obsidian';
  readonly state: SyncRunState;
  readonly trigger: SyncRunTrigger;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly stats: {
    readonly notesExported: number;
    readonly notesImported: number;
    readonly conflicts: number;
  } | null;
  readonly error: string | null;
  readonly createdAt: string;
}

/** One unresolved file. `status` is the ledger's, so `conflict` and `error` both surface. */
export interface SyncRunFileDetail {
  readonly vaultPath: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastSyncedAt: string | null;
}

export interface SyncRunDetailResource extends SyncRunResource {
  /**
   * Files still in conflict **right now**, whichever run detected them.
   *
   * A conflict the policy resolved automatically is counted in `stats.conflicts` and recorded
   * in the audit log (`obsidian.conflict_resolved`, with the path its losing version was
   * copied to); it does not appear here, because it is no longer a conflict. What appears here
   * is what the operator still has to decide.
   */
  readonly conflicts: readonly SyncRunFileDetail[];
  /** Files the last run could not read or could not write. Same honesty, different cause. */
  readonly errors: readonly SyncRunFileDetail[];
}

export function serializeSyncRun(row: SyncRunRow): SyncRunResource {
  return {
    id: row.id,
    kind: 'obsidian',
    state: row.state as SyncRunState,
    trigger: row.trigger as SyncRunTrigger,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    stats:
      row.stats === null
        ? null
        : {
            notesExported: row.stats.notesExported ?? 0,
            notesImported: row.stats.notesImported ?? 0,
            conflicts: row.stats.conflicts ?? 0,
          },
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeFileDetail(entry: LedgerEntry): SyncRunFileDetail {
  return {
    vaultPath: entry.vaultPath,
    entityType: entry.entityType,
    entityId: entry.entityId,
    status: entry.status,
    lastError: entry.lastError,
    lastSyncedAt: entry.lastSyncedAt?.toISOString() ?? null,
  };
}
