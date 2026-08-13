import type { ObsidianConflictPolicy, ObsidianSyncMode } from '../settings/types.js';
import { disambiguatePath, type ObsidianEntityType } from './layout.js';
import { noteHash, type ParsedNote } from './note.js';
import type { ScannedFile, VaultScan } from './scan.js';

/**
 * The planner: **decide, do not assume**.
 *
 * Everything in this file is pure — rows and a directory listing in, a list of intentions out.
 * No filesystem, no database, no clock beyond the one passed in. That is what makes the
 * conflict matrix testable in the unit tier (no PostgreSQL, per TDS 07) and what makes the
 * dry-run preview *provably* identical to what the worker would do: it is the same function.
 *
 * ## The comparison, in one paragraph
 *
 * For every entity Mission Control exports, the ledger (`obsidian_sync_states`) remembers two
 * hashes from the last sync: `mc_hash`, the hash of our own projection of the row, and
 * `vault_hash`, the hash of the file as it was left. This run recomputes both. `mcChanged`
 * and `vaultChanged` fall straight out, and **"changed on both sides" is a conflict** — never
 * a race to overwrite, never a timestamp comparison standing in for a content comparison.
 * (The timestamp is consulted only *afterwards*, and only when the policy is `newer_wins`.)
 *
 * ## The matrix
 *
 * | mcChanged | vaultChanged | result |
 * |---|---|---|
 * | — | file absent | `create` |
 * | false | false | `in_sync` |
 * | true | false | `update` (a plain push; nothing in the vault is at risk) |
 * | false | true | `import` when the type is importable and the mode is two-way, else `pending_pull` |
 * | true | true | **`conflict`** — resolved by policy, and the loser is always kept |
 *
 * A file the scan could not read (locked, or bigger than the read cap) yields `error` and is
 * **never overwritten**: a version we did not read is a version we cannot preserve.
 */

/**
 * How much the filesystem clock and the database clock are allowed to disagree before
 * `newer_wins` believes one of them. See `resolveConflict` for the measurement behind it.
 */
export const CLOCK_SKEW_MS = 2_000;

export type PlanAction =
  /** Write a note that does not exist in the vault. */
  | 'create'
  /** Overwrite a note whose vault copy is exactly what we last wrote. */
  | 'update'
  /** Take the vault's version into the database. */
  | 'import'
  /** Nothing to do; the ledger may still be refreshed (path moved, `last_synced_at`). */
  | 'in_sync'
  /** Both sides changed. `resolution` says what the policy did about it. */
  | 'conflict'
  /** The vault changed and this run will not take it (export-only note, or one-way mode). */
  | 'pending_pull'
  /** The file could not be read. Recorded, never overwritten. */
  | 'error';

/** TDS 04 §15.2 event 26 `resolution`, verbatim. */
export type ConflictResolution =
  | 'newer_wins'
  | 'mission_control_wins'
  | 'obsidian_wins'
  | 'manual_pending';

/** What a vault note contributes back to its `adrs` row. `null` fields are left alone. */
export interface AdrImport {
  readonly title: string | null;
  readonly status: string | null;
  readonly context: string | null;
  readonly decision: string | null;
  readonly alternatives: string | null;
  readonly consequences: string | null;
  /** Set when part of the file was understood and part was not (e.g. an unknown status). */
  readonly warning: string | null;
}

export interface DesiredNote {
  readonly entityType: ObsidianEntityType;
  readonly entityId: string;
  /** Where the note goes when it has never been written. Never used to *find* an existing one. */
  readonly idealPath: string;
  /** Hash of the canonical projection — `obsidian_sync_states.mc_hash`. */
  readonly canonicalHash: string;
  /** The entity's `updated_at`: the Mission Control clock for `newer_wins`. */
  readonly updatedAt: Date;
  /** Headings this note type owns; everything else in the file is the operator's. */
  readonly canonicalSections: readonly string[];
  /** Render the file, given the note being replaced, so unknown sections survive. */
  render(existing: ParsedNote | null): string;
  /** V1: ADRs only. An export-only note answers `null` and is never imported. */
  parseImport?(note: ParsedNote): AdrImport | null;
}

/** The `obsidian_sync_states` fields the planner reads. */
export interface LedgerEntry {
  readonly id: string;
  readonly vaultPath: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly mcHash: string | null;
  readonly vaultHash: string | null;
  readonly vaultMtime: Date | null;
  readonly status: string;
  readonly lastSyncedAt: Date | null;
  readonly lastError: string | null;
}

export interface PlanItem {
  readonly action: PlanAction;
  readonly entityType: ObsidianEntityType;
  readonly entityId: string;
  /** Vault-relative target path for this run. */
  readonly vaultPath: string;
  /** `null` unless the note moved in the vault since the last sync. */
  readonly previousPath: string | null;
  /** Human-readable justification, stored in logs and returned by the preview. */
  readonly reason: string;
  /** Bytes to write, for `create`/`update` and for a conflict resolved in our favour. */
  readonly content: string | null;
  readonly canonicalHash: string;
  readonly fileHash: string | null;
  readonly fileMtime: Date | null;
  readonly ledgerId: string | null;
  readonly resolution: ConflictResolution | null;
  /** True when a losing vault version must be copied aside before this item writes. */
  readonly backupRequired: boolean;
  readonly import: AdrImport | null;
  readonly error: string | null;
}

export interface SyncPlan {
  readonly items: readonly PlanItem[];
  readonly unmanagedCount: number;
  readonly duplicateIdPaths: readonly string[];
  readonly counts: PlanCounts;
}

export interface PlanCounts {
  readonly create: number;
  readonly update: number;
  readonly import: number;
  readonly inSync: number;
  readonly conflict: number;
  readonly pendingPull: number;
  readonly error: number;
}

export interface PlanInput {
  readonly desired: readonly DesiredNote[];
  readonly scan: VaultScan;
  readonly ledger: readonly LedgerEntry[];
  readonly syncMode: ObsidianSyncMode;
  readonly conflictPolicy: ObsidianConflictPolicy;
}

export function planSync(input: PlanInput): SyncPlan {
  const { desired, scan, ledger, syncMode, conflictPolicy } = input;

  const ledgerByEntity = new Map<string, LedgerEntry>();
  const ledgerPaths = new Set<string>();
  for (const entry of ledger) {
    if (entry.entityId !== null) ledgerByEntity.set(entry.entityId, entry);
    ledgerPaths.add(entry.vaultPath);
  }

  // Paths already spoken for by *another* entity, so a new note never lands on one.
  const takenPaths = new Set<string>([...scan.byPath.keys()]);

  const items: PlanItem[] = [];
  // Sorted by entity id (UUIDv7 ⇒ creation order) so name collisions resolve the same way on
  // every run: the note created first keeps the clean file name.
  const ordered = [...desired].sort((left, right) =>
    left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
  );

  for (const note of ordered) {
    const entry = ledgerByEntity.get(note.entityId) ?? null;
    const file = locateFile(note, entry, scan);
    const item = decide({ note, entry, file, syncMode, conflictPolicy, takenPaths });
    takenPaths.add(item.vaultPath);
    items.push(item);
  }

  return {
    items,
    unmanagedCount: scan.unmanagedCount,
    duplicateIdPaths: scan.duplicateIdPaths,
    counts: count(items),
  };
}

/**
 * Find the entity's note in the vault.
 *
 * **By `mcId` first, path second** — that ordering is the whole reason the id is in the front
 * matter. An operator who renamed `ADR-0007 Use pg-boss.md` to `Queue decision.md` in Obsidian
 * has not created a second ADR, and a path-first lookup would say they had.
 */
function locateFile(
  note: DesiredNote,
  entry: LedgerEntry | null,
  scan: VaultScan,
): ScannedFile | null {
  const byId = scan.byEntityId.get(note.entityId);
  if (byId !== undefined) return byId;

  const path = entry?.vaultPath;
  if (path === undefined) return null;

  const byPath = scan.byPath.get(path);
  if (byPath === undefined) return null;
  // The path is now occupied by somebody else's note. Ours is gone, not this.
  if (byPath.identity !== null && byPath.identity.entityId !== note.entityId) return null;
  return byPath;
}

interface DecisionInput {
  readonly note: DesiredNote;
  readonly entry: LedgerEntry | null;
  readonly file: ScannedFile | null;
  readonly syncMode: ObsidianSyncMode;
  readonly conflictPolicy: ObsidianConflictPolicy;
  readonly takenPaths: ReadonlySet<string>;
}

function decide(input: DecisionInput): PlanItem {
  const { note, entry, file, syncMode, conflictPolicy } = input;

  const base = {
    entityType: note.entityType,
    entityId: note.entityId,
    canonicalHash: note.canonicalHash,
    ledgerId: entry?.id ?? null,
    previousPath:
      entry !== null && file !== null && entry.vaultPath !== file.vaultPath
        ? entry.vaultPath
        : null,
  } as const;

  // ---------------------------------------------------------------- the note is not there
  if (file === null) {
    const vaultPath = freePath(note, entry, input.takenPaths);
    return {
      ...base,
      action: 'create',
      vaultPath,
      reason:
        entry === null
          ? 'no note exists for this entity yet'
          : 'the note recorded for this entity is no longer in the vault',
      content: note.render(null),
      fileHash: null,
      fileMtime: null,
      resolution: null,
      backupRequired: false,
      import: null,
      error: null,
    };
  }

  // ------------------------------------------------------- the note is there but unreadable
  if (file.problem !== null || file.hash === null || file.note === null) {
    return {
      ...base,
      action: 'error',
      vaultPath: file.vaultPath,
      reason: 'the note could not be read, so it will not be overwritten',
      content: null,
      fileHash: file.hash,
      fileMtime: file.mtime,
      resolution: null,
      backupRequired: false,
      import: null,
      error: file.problem ?? 'unreadable',
    };
  }

  const rendered = note.render(file.note);
  const renderedHash = noteHash(rendered);

  const mcChanged = entry === null || entry.mcHash !== note.canonicalHash;
  const vaultChanged = entry === null || entry.vaultHash !== file.hash;
  const importable = note.parseImport !== undefined && syncMode === 'two_way';

  const common = {
    ...base,
    vaultPath: file.vaultPath,
    fileHash: file.hash,
    fileMtime: file.mtime,
  } as const;

  // The file already *is* our projection (first adoption of a hand-made note, or a rewrite
  // that changes nothing). Nothing to write in either direction; only the ledger moves.
  if (renderedHash === file.hash) {
    return {
      ...common,
      action: 'in_sync',
      reason: entry === null ? 'an existing note already matches this entity' : 'unchanged',
      content: null,
      resolution: null,
      backupRequired: false,
      import: null,
      error: null,
    };
  }

  if (!mcChanged && !vaultChanged) {
    // Both hashes match the ledger yet the render differs: the projection changed shape
    // (a Mission Control upgrade). Treat it as a push — nothing in the vault is at risk,
    // because the vault copy is byte-for-byte what we last wrote.
    return {
      ...common,
      action: 'update',
      reason: 'the note format changed on the Mission Control side',
      content: rendered,
      resolution: null,
      backupRequired: false,
      import: null,
      error: null,
    };
  }

  if (mcChanged && !vaultChanged) {
    return {
      ...common,
      action: 'update',
      reason: 'the entity changed in Mission Control; the vault copy is untouched',
      content: rendered,
      resolution: null,
      backupRequired: false,
      import: null,
      error: null,
    };
  }

  if (!mcChanged && vaultChanged) {
    if (!importable) {
      return {
        ...common,
        action: 'pending_pull',
        reason:
          syncMode === 'one_way'
            ? 'the vault copy was edited; one-way mode never imports'
            : 'the vault copy was edited; this note type is export-only in V1',
        content: null,
        resolution: null,
        backupRequired: false,
        import: null,
        error: null,
      };
    }

    const imported = note.parseImport?.(file.note) ?? null;
    if (imported === null) {
      return {
        ...common,
        action: 'pending_pull',
        reason: 'the vault copy changed but no importable field did',
        content: null,
        resolution: null,
        backupRequired: false,
        import: null,
        error: null,
      };
    }

    return {
      ...common,
      action: 'import',
      reason: 'the vault copy was edited and Mission Control has no competing change',
      content: null,
      resolution: null,
      backupRequired: false,
      import: imported,
      error: null,
    };
  }

  // --------------------------------------------------------- changed on BOTH sides: conflict
  return resolveConflict({
    common,
    note,
    file,
    rendered,
    importable,
    conflictPolicy,
  });
}

interface ResolveInput {
  readonly common: Omit<
    PlanItem,
    'action' | 'reason' | 'content' | 'resolution' | 'backupRequired' | 'import' | 'error'
  >;
  readonly note: DesiredNote;
  readonly file: ScannedFile;
  readonly rendered: string;
  readonly importable: boolean;
  readonly conflictPolicy: ObsidianConflictPolicy;
}

/**
 * Apply the operator's conflict policy — and, whichever way it goes, keep the loser.
 *
 * - **Mission Control wins** → the vault file is copied to `…conflict-<stamp>.md` *before* it
 *   is overwritten (`backupRequired`), so the operator's version is still in their vault and
 *   still indexed by Obsidian's search.
 * - **Obsidian wins** and the type is importable → the database row is overwritten, and the
 *   version it replaced is written to `audit_log_entries.before` by the applier.
 * - **Obsidian wins** and the type is *not* importable → nothing is written at all. The item
 *   stays `conflict` and reappears every run until the operator acts, which is the honest
 *   outcome for "the vault won but Mission Control cannot represent that".
 * - **Manual** → nothing is written on either side, ever.
 */
function resolveConflict(input: ResolveInput): PlanItem {
  const { common, note, file, rendered, importable, conflictPolicy } = input;

  const missionControlWins = (resolution: ConflictResolution, reason: string): PlanItem => ({
    ...common,
    action: 'conflict',
    reason,
    content: rendered,
    resolution,
    backupRequired: true,
    import: null,
    error: null,
  });

  const obsidianWins = (resolution: ConflictResolution, reason: string): PlanItem => {
    const imported = importable ? (note.parseImport?.(file.note as ParsedNote) ?? null) : null;
    return {
      ...common,
      action: 'conflict',
      reason:
        imported === null
          ? `${reason}; this note type cannot be imported, so nothing was written`
          : reason,
      content: null,
      resolution,
      backupRequired: false,
      import: imported,
      error: null,
    };
  };

  switch (conflictPolicy) {
    case 'manual':
      return {
        ...common,
        action: 'conflict',
        reason: 'both sides changed; the conflict policy is manual, so nothing was written',
        content: null,
        resolution: 'manual_pending',
        backupRequired: false,
        import: null,
        error: null,
      };

    case 'mission_control_wins':
      return missionControlWins(
        'mission_control_wins',
        'both sides changed; Mission Control wins by policy',
      );

    case 'obsidian_wins':
      return obsidianWins('obsidian_wins', 'both sides changed; the vault wins by policy');

    case 'newer_wins': {
      // The two clocks are not the same clock. `mtime` comes from the filesystem and
      // `updated_at` from PostgreSQL, and on Windows they routinely disagree by a few
      // milliseconds for writes that happened in a definite order — measured, not assumed
      // (a file written *before* a row update came back 2 ms *newer*).
      //
      // So "newer" needs a margin, and the margin has a direction: inside it, Mission Control
      // wins. Not because it is more likely to be right, but because that branch takes a
      // conflict copy of the vault file — the operator's version survives in their own vault
      // either way, which is not true of the other direction, where the loser is only in the
      // audit log. Ties go to the recoverable outcome.
      const vaultIsNewer = file.mtime.getTime() > note.updatedAt.getTime() + CLOCK_SKEW_MS;
      return vaultIsNewer
        ? obsidianWins('newer_wins', 'both sides changed; the vault copy is clearly newer')
        : missionControlWins(
            'newer_wins',
            'both sides changed; the Mission Control row is newer (or within clock skew)',
          );
    }
  }
}

/** A path no other note occupies. Deterministic in the entity id (see `disambiguatePath`). */
function freePath(
  note: DesiredNote,
  entry: LedgerEntry | null,
  taken: ReadonlySet<string>,
): string {
  const remembered = entry?.vaultPath;
  if (remembered !== undefined && !taken.has(remembered)) return remembered;
  if (!taken.has(note.idealPath)) return note.idealPath;

  const disambiguated = disambiguatePath(note.idealPath, note.entityId);
  if (!taken.has(disambiguated)) return disambiguated;

  return disambiguatePath(note.idealPath, `${note.entityId}-${note.canonicalHash}`);
}

function count(items: readonly PlanItem[]): PlanCounts {
  const counts = {
    create: 0,
    update: 0,
    import: 0,
    inSync: 0,
    conflict: 0,
    pendingPull: 0,
    error: 0,
  };

  for (const item of items) {
    switch (item.action) {
      case 'create':
        counts.create += 1;
        break;
      case 'update':
        counts.update += 1;
        break;
      case 'import':
        counts.import += 1;
        break;
      case 'in_sync':
        counts.inSync += 1;
        break;
      case 'conflict':
        counts.conflict += 1;
        break;
      case 'pending_pull':
        counts.pendingPull += 1;
        break;
      case 'error':
        counts.error += 1;
        break;
    }
  }

  return counts;
}
