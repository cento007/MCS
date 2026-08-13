import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Every filesystem operation this engine performs on an operator's vault.
 *
 * Three rules, and they are the reason this file exists rather than `fs/promises` calls
 * scattered through the planner:
 *
 *  1. **Writes are atomic.** Content goes to a temp file in the *same directory* (same volume,
 *     so `rename` is atomic), is flushed, and is then renamed over the target. A crash, a
 *     `SIGTERM`, or a full disk therefore leaves either the old note or the new one — never a
 *     truncated one. Obsidian polls the folder; a half-written note is a note the operator
 *     reads, panics about, and possibly saves over.
 *  2. **The temp file never outlives the attempt.** It is removed in `finally`, and it is
 *     named `.mc-tmp-*` so `scan.ts` skips it even if a hard kill leaves one behind.
 *  3. **Every path is confined to the vault.** `vaultAbsolutePath` refuses to resolve outside
 *     the configured root, so a `vault_path` that somehow acquired a `..` cannot make this
 *     engine write to the operator's home directory.
 */

/** Windows and some sync clients hold a file open briefly after an editor saves it. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 4;
const RENAME_RETRY_BASE_MS = 25;

export type VaultProblemKind =
  | 'missing'
  | 'not_a_directory'
  | 'not_absolute'
  | 'unreadable'
  | 'not_writable';

export interface VaultProblem {
  readonly kind: VaultProblemKind;
  readonly detail: string;
}

export type VaultInspection = { readonly ok: true } | ({ readonly ok: false } & VaultProblem);

/**
 * Is this path a directory we can read, and (when `requireWritable`) write?
 *
 * Returns a problem **as data**. A vault that has been deleted, renamed, unplugged with its
 * USB drive, or made read-only is an ordinary Tuesday for a self-hosted tool; it is reported
 * on the SyncRun row, and nothing throws.
 *
 * Writability is probed with `access(W_OK)` and no file is created. On Windows that check does
 * not see every ACL, so a write can still fail later — which is why each individual write also
 * degrades to a per-file `error` in the ledger rather than aborting the run.
 */
export async function inspectVault(
  vaultPath: string,
  options: { readonly requireWritable?: boolean } = {},
): Promise<VaultInspection> {
  if (!isAbsolute(vaultPath)) {
    return { ok: false, kind: 'not_absolute', detail: 'Vault path must be absolute (F8.1)' };
  }

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(vaultPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, kind: 'missing', detail: 'Vault path does not exist on this machine' };
    }
    return { ok: false, kind: 'unreadable', detail: describe(error) };
  }

  if (!stats.isDirectory()) {
    return { ok: false, kind: 'not_a_directory', detail: 'Vault path is a file, not a directory' };
  }

  try {
    await access(vaultPath, constants.R_OK);
  } catch (error) {
    return { ok: false, kind: 'unreadable', detail: describe(error) };
  }

  if (options.requireWritable === true) {
    try {
      await access(vaultPath, constants.W_OK);
    } catch (error) {
      return { ok: false, kind: 'not_writable', detail: describe(error) };
    }
  }

  return { ok: true };
}

/**
 * Resolve a vault-relative path against the vault root, refusing anything that escapes it.
 *
 * @throws {Error} when the result would land outside the vault.
 */
export function vaultAbsolutePath(vaultPath: string, relative: string): string {
  const root = resolve(vaultPath);
  const absolute = resolve(join(root, ...relative.split('/')));
  const prefix = root.endsWith(sep) ? root : root + sep;

  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`Refusing to touch a path outside the vault: ${relative}`);
  }
  return absolute;
}

export async function readTextFile(absolutePath: string): Promise<string> {
  return readFile(absolutePath, 'utf8');
}

export async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export interface AtomicWriteOptions {
  /**
   * Test seam: invoked after the temp file is written and flushed, before the rename.
   *
   * Throwing from it simulates the process dying at the one moment where a naive writer would
   * have left a truncated file — which is exactly the property `writeFileAtomic` claims and
   * therefore exactly the property that has to be tested rather than asserted in a comment.
   */
  readonly onBeforeRename?: (temporaryPath: string) => void | Promise<void>;
}

/**
 * Write `content` to `absolutePath` atomically. Creates the parent directory if needed.
 *
 * On failure the target is left exactly as it was and no temp file survives.
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = join(directory, `.mc-tmp-${randomBytes(8).toString('hex')}`);
  let renamed = false;

  try {
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      // Flush before the rename: without it a power loss can leave the *renamed* file with
      // zero length on some filesystems, which is the truncated note we are avoiding.
      await handle.sync();
    } finally {
      await handle.close();
    }

    await options.onBeforeRename?.(temporaryPath);
    await renameWithRetry(temporaryPath, absolutePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(temporaryPath).catch(() => {
        /* nothing to clean up, or someone else already did */
      });
    }
  }
}

/**
 * Copy a file, refusing to overwrite an existing destination.
 *
 * Used for conflict copies: `COPYFILE_EXCL` guarantees a second run in the same second cannot
 * overwrite the copy the first one just took, which would destroy the very version being
 * preserved.
 */
export async function copyFileExclusive(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to, constants.COPYFILE_EXCL);
}

export async function ensureDirectory(absolutePath: string): Promise<void> {
  await mkdir(absolutePath, { recursive: true });
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RENAME_RETRY_CODES.has(code)) {
        throw error;
      }
      await delay(RENAME_RETRY_BASE_MS * attempt);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** A message safe to store in `obsidian_sync_states.last_error` / `sync_runs.error`. */
export function describe(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined) return code;
  return error instanceof Error ? error.message : String(error);
}
