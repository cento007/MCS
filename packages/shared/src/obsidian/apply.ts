import { stat } from 'node:fs/promises';
import {
  type AtomicWriteOptions,
  copyFileExclusive,
  describe,
  vaultAbsolutePath,
  writeFileAtomic,
} from './fs.js';
import { conflictCopyPath } from './layout.js';
import { noteHash } from './note.js';
import type { PlanItem } from './plan.js';

/**
 * The filesystem half of a run: take one planned intention and make it true.
 *
 * **The guarantee this file exists to keep:** a vault file is never replaced without its
 * previous bytes still being in the vault afterwards. Concretely, `backupRequired` items copy
 * the file to `<name>.conflict-<UTC stamp>.md` *before* the overwrite, and if that copy fails
 * for any reason the overwrite does not happen. There is no code path here that writes over a
 * version it did not first preserve, and no ordering in which the copy is best-effort.
 *
 * The database half (imports, ledger, audit) is the engine's; this module knows nothing about
 * PostgreSQL, which is what lets `dryRun` be a single early return rather than a mode that has
 * to be threaded through a transaction.
 */

export type ApplyOutcome =
  /** Bytes were written to the vault. */
  | 'written'
  /** Nothing needed doing on disk (in_sync, pending_pull, an import, a manual conflict). */
  | 'unchanged'
  /** A dry run: this is what *would* have happened. */
  | 'planned'
  /** The write failed. The vault is as it was; the ledger records why. */
  | 'failed';

export interface AppliedItem {
  readonly item: PlanItem;
  readonly outcome: ApplyOutcome;
  /** Where the losing vault version was preserved, when one was. */
  readonly backupPath: string | null;
  /** Hash of the file as it now stands — the new `obsidian_sync_states.vault_hash`. */
  readonly vaultHash: string | null;
  readonly vaultMtime: Date | null;
  readonly error: string | null;
}

export interface ApplyOptions {
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  /** Forwarded to `writeFileAtomic` — the crash-between-write-and-rename test seam. */
  readonly write?: AtomicWriteOptions;
}

export async function applyPlanItem(
  vaultPath: string,
  item: PlanItem,
  options: ApplyOptions = {},
): Promise<AppliedItem> {
  const now = options.now ?? (() => new Date());

  const unchanged = (outcome: ApplyOutcome = 'unchanged'): AppliedItem => ({
    item,
    outcome,
    backupPath: null,
    vaultHash: item.fileHash,
    vaultMtime: item.fileMtime,
    error: null,
  });

  // Nothing to write: an import, an untouched note, a deferred pull, an unreadable file, or a
  // conflict the policy resolved in the vault's favour.
  if (item.content === null) return unchanged();
  if (options.dryRun === true) {
    return { ...unchanged('planned'), vaultHash: null, vaultMtime: null };
  }

  const absolute = vaultAbsolutePath(vaultPath, item.vaultPath);
  let backupPath: string | null = null;

  try {
    if (item.backupRequired) {
      // MUST precede the write, and MUST throw on failure. A conflict copy taken afterwards
      // copies the winner; a best-effort one loses the operator's version on the first EBUSY.
      backupPath = conflictCopyPath(item.vaultPath, now());
      await copyFileExclusive(absolute, vaultAbsolutePath(vaultPath, backupPath));
    }

    await writeFileAtomic(absolute, item.content, options.write ?? {});

    const stats = await stat(absolute);
    return {
      item,
      outcome: 'written',
      backupPath,
      vaultHash: noteHash(item.content),
      vaultMtime: stats.mtime,
      error: null,
    };
  } catch (error) {
    return {
      item,
      outcome: 'failed',
      backupPath,
      vaultHash: item.fileHash,
      vaultMtime: item.fileMtime,
      error: describe(error),
    };
  }
}
