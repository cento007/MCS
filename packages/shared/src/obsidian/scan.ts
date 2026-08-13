import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, errorCode, readTextFile, vaultAbsolutePath } from './fs.js';
import { isConflictCopyPath, MANAGED_FOLDERS } from './layout.js';
import { type NoteIdentity, noteHash, noteIdentity, type ParsedNote, parseNote } from './note.js';

/**
 * The bounded read of the operator's vault.
 *
 * Modelled on the repository discovery scan (`apps/backend/src/github/discovery.ts`), for the
 * same reason it was bounded there: the root is operator-supplied, and an operator can point
 * this at a vault that has been syncing to three devices for four years. A scan that walks it
 * unbounded is a worker that never heartbeats and a preview request that never returns.
 *
 * **Bounded on four axes:** depth, entries per directory, total files, and a wall-clock
 * deadline — plus a fifth that the discovery scan does not need, a cap on total bytes read,
 * because unlike discovery this scan reads file *contents* (it has to: the hash and the
 * `mcId` are both in the bytes).
 *
 * ## A truncated scan fails the run, and that is deliberate
 *
 * Every decision the planner makes is of the form "does a note for this entity already exist".
 * If the scan stopped early, the honest answer is "unknown", and the two ways of guessing are
 * both bad: assume yes and the note never gets written, assume no and a **second copy** of
 * every note appears in the vault. So `truncated` is surfaced and the caller fails the run
 * with a reason the operator can act on, rather than making half the vault up.
 */

export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_FILES = 5_000;
export const DEFAULT_MAX_ENTRIES_PER_DIRECTORY = 2_000;
export const DEFAULT_SCAN_DEADLINE_MS = 30_000;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** A single note larger than this is recorded, not read: it is not one of ours. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ScanBounds {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly maxEntriesPerDirectory?: number;
  readonly deadlineMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
  /** Injectable clock so the deadline is testable without waiting for one. */
  readonly now?: () => number;
}

export interface ScannedFile {
  /** Vault-relative, forward slashes — the `obsidian_sync_states.vault_path` value. */
  readonly vaultPath: string;
  readonly mtime: Date;
  readonly size: number;
  /** `null` when the file was too large to read; `text`/`note`/`hash` are then null too. */
  readonly text: string | null;
  readonly note: ParsedNote | null;
  readonly identity: NoteIdentity | null;
  readonly hash: string | null;
  /** Set when this specific file could not be read; the scan continues regardless. */
  readonly problem: string | null;
}

export interface VaultScan {
  readonly files: readonly ScannedFile[];
  /** By `mcId`. A duplicated id keeps the first file in scan order and lists the rest. */
  readonly byEntityId: ReadonlyMap<string, ScannedFile>;
  readonly byPath: ReadonlyMap<string, ScannedFile>;
  /** Files carrying no `mcId` — never touched, never imported, counted so the UI can say so. */
  readonly unmanagedCount: number;
  /** Files claiming an `mcId` another file already claimed (a copy-paste, a restored backup). */
  readonly duplicateIdPaths: readonly string[];
  readonly truncated: boolean;
  readonly truncatedReason: string | null;
}

export async function scanVault(
  vaultPath: string,
  bounds: ScanBounds = {},
  folders: readonly string[] = MANAGED_FOLDERS,
): Promise<VaultScan> {
  const now = bounds.now ?? (() => Date.now());
  const maxDepth = bounds.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = bounds.maxFiles ?? DEFAULT_MAX_FILES;
  const maxEntries = bounds.maxEntriesPerDirectory ?? DEFAULT_MAX_ENTRIES_PER_DIRECTORY;
  const maxTotalBytes = bounds.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFileBytes = bounds.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const deadline = now() + (bounds.deadlineMs ?? DEFAULT_SCAN_DEADLINE_MS);

  const files: ScannedFile[] = [];
  const byEntityId = new Map<string, ScannedFile>();
  const byPath = new Map<string, ScannedFile>();
  const duplicateIdPaths: string[] = [];

  let unmanagedCount = 0;
  let totalBytes = 0;
  let truncatedReason: string | null = null;

  const walk = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (truncatedReason !== null) return;
    if (depth > maxDepth) {
      truncatedReason = `directory nesting exceeded ${maxDepth} levels at ${relativeDirectory}`;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(vaultAbsolutePath(vaultPath, relativeDirectory), {
        withFileTypes: true,
      });
    } catch (error) {
      // A managed folder that does not exist yet is the normal first-sync state, not a fault.
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }

    if (entries.length > maxEntries) {
      truncatedReason = `${relativeDirectory} holds more than ${maxEntries} entries`;
      return;
    }

    // Sorted so a truncated scan truncates the *same* way twice and so plan output is stable.
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      if (truncatedReason !== null) return;
      if (now() > deadline) {
        truncatedReason = 'the scan deadline elapsed';
        return;
      }
      // `.obsidian`, `.trash`, and our own `.mc-tmp-*` leftovers.
      if (entry.name.startsWith('.')) continue;

      const relative = `${relativeDirectory}/${entry.name}`;

      // `isDirectory()` is false for a directory symlink — deliberately, as in the discovery
      // scan: following them turns a bounded walk into a cycle.
      if (entry.isDirectory()) {
        await walk(relative, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (isConflictCopyPath(relative)) continue;

      if (files.length >= maxFiles) {
        truncatedReason = `the vault holds more than ${maxFiles} notes under ${MANAGED_FOLDERS.join(', ')}`;
        return;
      }

      const scanned = await readNote(vaultPath, relative, maxFileBytes);
      totalBytes += scanned.size;
      if (totalBytes > maxTotalBytes) {
        truncatedReason = `reading the vault exceeded ${maxTotalBytes} bytes`;
        return;
      }

      files.push(scanned);
      byPath.set(scanned.vaultPath, scanned);

      if (scanned.identity === null) {
        unmanagedCount += 1;
        continue;
      }
      if (byEntityId.has(scanned.identity.entityId)) {
        duplicateIdPaths.push(scanned.vaultPath);
        continue;
      }
      byEntityId.set(scanned.identity.entityId, scanned);
    }
  };

  for (const folder of folders) await walk(folder, 1);

  return {
    files,
    byEntityId,
    byPath,
    unmanagedCount,
    duplicateIdPaths,
    truncated: truncatedReason !== null,
    truncatedReason,
  };
}

async function readNote(
  vaultPath: string,
  relative: string,
  maxFileBytes: number,
): Promise<ScannedFile> {
  const absolute = vaultAbsolutePath(vaultPath, relative);

  try {
    const stats = await stat(absolute);

    if (stats.size > maxFileBytes) {
      return {
        vaultPath: relative,
        mtime: stats.mtime,
        size: stats.size,
        text: null,
        note: null,
        identity: null,
        hash: null,
        problem: `file is larger than ${maxFileBytes} bytes and was not read`,
      };
    }

    const text = await readTextFile(absolute);
    const note = parseNote(text);

    return {
      vaultPath: relative,
      mtime: stats.mtime,
      size: stats.size,
      text,
      note,
      identity: noteIdentity(note),
      hash: noteHash(text),
      problem: null,
    };
  } catch (error) {
    // One unreadable note (a lock, a permission, a broken symlink) is a per-file fact, not a
    // reason to abandon the vault.
    return {
      vaultPath: relative,
      mtime: new Date(0),
      size: 0,
      text: null,
      note: null,
      identity: null,
      hash: null,
      problem: describe(error),
    };
  }
}

/** Absolute path of a scanned file. Exported so callers never rebuild it by hand. */
export function scannedFilePath(vaultPath: string, file: ScannedFile): string {
  return join(vaultAbsolutePath(vaultPath, file.vaultPath));
}
