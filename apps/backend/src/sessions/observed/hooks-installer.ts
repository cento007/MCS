import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HOOK_EVENT_NAMES, type HookEventName } from './hook-events.js';
import { type ClaudePathOptions, claudeConfigDir } from './paths.js';

/**
 * The hooks installer / settings-writer (TDS 02 §6.2).
 *
 * It writes Mission Control's hook profile into a `.claude/settings.json` — user scope by
 * default (observes every session on the machine) or project scope per repository — and it does
 * so **surgically**:
 *
 *   - only entries Mission Control owns are added, replaced or removed, identified by the
 *     ingest URL (§6.2's own identity rule). Every other key, every operator hook and every
 *     unrecognised structure is preserved verbatim, including things this code does not
 *     understand;
 *   - a pre-write **backup** of the existing file is kept under `MC_DATA_DIR/hooks/backups/`;
 *   - installed locations and the hook token are recorded in `MC_DATA_DIR/hooks/state.json`, so
 *     uninstall is exact rather than a guess and Test Connection has something to verify;
 *   - a settings file that does not parse is **never** written to. Clobbering an operator's
 *     configuration because we could not read it is the one outcome that is worse than not
 *     installing.
 *
 * `mergeHookProfile` / `removeHookProfile` are pure and exported for their own tests: the merge
 * is the part that can destroy somebody's work, so it is provable without touching a disk.
 */

/** Every Mission Control ingest URL ends in this path, whatever the host and port (§6.8). */
export const HOOK_INGEST_PATH = '/api/v1/hook-events';

/** `MC_DATA_DIR/hooks/` (TDS 02 §1.2 reserves the directory for exactly this). */
export const HOOKS_DIR = 'hooks';
export const HOOKS_STATE_FILE = 'state.json';
export const HOOKS_BACKUP_DIR = 'backups';

/** Bumped only if the on-disk state shape changes incompatibly. */
export const HOOKS_STATE_VERSION = 1;

/** Owner-only. The file holds a bearer token (see `HookInstallRecord.hookToken`). */
const SECRET_FILE_MODE = 0o600;

export type HookScope = 'user' | 'project';

/** One Claude Code hook entry, as written into `settings.json`. */
export interface HookEntry {
  readonly type: 'http';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: unknown[];
  readonly [key: string]: unknown;
}

export interface HookInstallRecord {
  readonly scope: HookScope;
  readonly settingsPath: string;
  readonly ingestUrl: string;
  /** First 8 characters of the token — what the UI shows (TDS 03 §3.3). */
  readonly tokenPrefix: string;
  /**
   * The ingest token, as installed.
   *
   * TDS 02 §6.2 records it here so Test Connection can verify an install and uninstall is
   * clean. It is not an additional exposure: the identical value is necessarily in plaintext in
   * the `settings.json` we just wrote, because that is the only way the runtime can present it.
   * Both files are written `0600` where the platform honours it.
   */
  readonly hookToken: string;
  readonly events: readonly HookEventName[];
  readonly backupPath: string | null;
  readonly installedAt: string;
}

export interface HooksState {
  readonly version: number;
  readonly updatedAt: string;
  readonly installs: readonly HookInstallRecord[];
}

export interface ResolveSettingsPathOptions extends ClaudePathOptions {
  readonly scope: HookScope;
  /** Required for `scope: 'project'` — the repository root that owns `.claude/settings.json`. */
  readonly projectRoot?: string;
}

/**
 * Where the profile goes.
 *
 * User scope honours `CLAUDE_CONFIG_DIR` and `%USERPROFILE%\.claude` (F8.1); project scope is
 * always `<projectRoot>/.claude/settings.json`, which is the file the runtime reads for a
 * session started in that tree.
 */
export function resolveSettingsPath(options: ResolveSettingsPathOptions): string {
  if (options.scope === 'project') {
    if (options.projectRoot === undefined || options.projectRoot.length === 0) {
      throw new Error('projectRoot is required to install a project-scoped hook profile');
    }
    return join(options.projectRoot, '.claude', 'settings.json');
  }
  return join(claudeConfigDir(options), 'settings.json');
}

export function hooksStatePath(dataDir: string): string {
  return join(dataDir, HOOKS_DIR, HOOKS_STATE_FILE);
}

/**
 * The hook entry Mission Control installs.
 *
 * An **HTTP** hook, per the spike (§4: *"Hooks can be HTTP type posting JSON … to a local
 * backend endpoint — this is the natural push channel"*) and TDS 02 §6.1's "HTTP hook POSTs"
 * with the token "embedded in the hook URL/header". The token rides in the `Authorization`
 * header rather than the URL because a URL is logged by everything that touches it.
 */
export function buildHookEntry(ingestUrl: string, token: string): HookEntry {
  return {
    type: 'http',
    url: ingestUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * Is this entry ours?
 *
 * URL-based, exactly as §6.2 specifies ("identifiable by the MC ingest URL"), and matched on the
 * *path* so an install survives the operator changing `MC_HOST`/`MC_PORT` — otherwise a port
 * change would orphan the old entries and every session would fire two hooks.
 */
export function isMissionControlHookEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const url = (entry as { url?: unknown }).url;
  if (typeof url !== 'string') return false;

  const withoutQuery = url.split('?')[0] ?? url;
  return withoutQuery.endsWith(HOOK_INGEST_PATH);
}

export interface MergeResult {
  readonly settings: Record<string, unknown>;
  /** Mission Control entries removed before ours were written (a re-install or a URL change). */
  readonly replaced: number;
}

/**
 * Merge the Mission Control profile into an existing settings object. **Pure.**
 *
 * The invariant, and the only one that matters: every key, every hook group and every entry
 * that is not ours comes out the far side byte-identical — including shapes this function does
 * not recognise, which are copied through untouched rather than normalised.
 */
export function mergeHookProfile(
  existing: unknown,
  input: {
    readonly entry: HookEntry;
    readonly events?: readonly HookEventName[];
  },
): MergeResult {
  const events = input.events ?? HOOK_EVENT_NAMES;
  const base = asRecord(existing) ?? {};
  const hooks: Record<string, unknown> = { ...(asRecord(base['hooks']) ?? {}) };

  let replaced = 0;

  for (const event of events) {
    const stripped = stripMissionControl(hooks[event]);
    replaced += stripped.removed;
    stripped.groups.push(groupFor(event, input.entry));
    hooks[event] = stripped.groups;
  }

  return { settings: { ...base, hooks }, replaced };
}

export interface RemoveResult {
  readonly settings: Record<string, unknown>;
  readonly removed: number;
}

/** Remove every Mission Control entry, leaving everything else exactly as it was. **Pure.** */
export function removeHookProfile(existing: unknown): RemoveResult {
  const base = asRecord(existing);
  if (base === null) return { settings: {}, removed: 0 };

  const originalHooks = asRecord(base['hooks']);
  if (originalHooks === null) return { settings: { ...base }, removed: 0 };

  const hooks: Record<string, unknown> = {};
  let removed = 0;

  for (const [event, value] of Object.entries(originalHooks)) {
    const stripped = stripMissionControl(value);
    removed += stripped.removed;

    if (stripped.removed === 0) {
      // Untouched: copy the ORIGINAL value, not our reconstruction, so a shape we did not
      // recognise cannot be silently rewritten by an uninstall.
      hooks[event] = value;
      continue;
    }
    // An event that exists only because we installed it goes away with us.
    if (stripped.groups.length > 0) hooks[event] = stripped.groups;
  }

  const settings: Record<string, unknown> = { ...base };
  if (Object.keys(hooks).length === 0 && Object.keys(originalHooks).length > 0) {
    delete settings['hooks'];
  } else {
    settings['hooks'] = hooks;
  }

  return { settings, removed };
}

/**
 * `matcher` is only meaningful for the tool hooks. Emitting it on `SessionStart` or `Stop`
 * would add a field the runtime does not read to a file the operator does.
 */
function groupFor(event: HookEventName, entry: HookEntry): HookGroup {
  return event === 'PostToolUse' ? { matcher: '*', hooks: [entry] } : { hooks: [entry] };
}

function stripMissionControl(value: unknown): { groups: unknown[]; removed: number } {
  if (value === undefined) return { groups: [], removed: 0 };
  if (!Array.isArray(value)) {
    // Not the array the runtime documents. Preserve it verbatim and append beside it: this is
    // an operator's file, and "I did not understand it" is not a licence to rewrite it.
    return { groups: [value], removed: 0 };
  }

  const groups: unknown[] = [];
  let removed = 0;

  for (const group of value) {
    const record = asRecord(group);
    if (record === null || !Array.isArray(record['hooks'])) {
      groups.push(group);
      continue;
    }

    const entries = record['hooks'] as unknown[];
    const kept = entries.filter((entry) => !isMissionControlHookEntry(entry));
    removed += entries.length - kept.length;

    if (kept.length === entries.length) {
      groups.push(group);
      continue;
    }
    // A group that held only our entry disappears with it; a mixed group keeps its own.
    if (kept.length > 0) groups.push({ ...record, hooks: kept });
  }

  return { groups, removed };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------------------------ disk I/O

export interface InstallHookProfileOptions {
  readonly ingestUrl: string;
  readonly token: string;
  readonly scope: HookScope;
  readonly settingsPath: string;
  /** `MC_DATA_DIR` — the backup and state file live under `<dataDir>/hooks/`. */
  readonly dataDir: string;
  readonly events?: readonly HookEventName[];
  readonly now?: () => Date;
}

export interface InstallHookProfileResult {
  readonly settingsPath: string;
  readonly backupPath: string | null;
  readonly statePath: string;
  readonly events: readonly HookEventName[];
  readonly replaced: number;
  /** `true` when the settings file did not exist and was created by this install. */
  readonly createdSettingsFile: boolean;
}

export async function installHookProfile(
  options: InstallHookProfileOptions,
): Promise<InstallHookProfileResult> {
  const now = options.now ?? (() => new Date());
  const events = options.events ?? HOOK_EVENT_NAMES;

  const existing = await readSettingsFile(options.settingsPath);
  const backupPath =
    existing.present === true
      ? await backupSettings(options.dataDir, options.scope, options.settingsPath, now())
      : null;

  const merged = mergeHookProfile(existing.settings, {
    entry: buildHookEntry(options.ingestUrl, options.token),
    events,
  });

  await writeJsonFile(options.settingsPath, merged.settings);

  const record: HookInstallRecord = {
    scope: options.scope,
    settingsPath: options.settingsPath,
    ingestUrl: options.ingestUrl,
    tokenPrefix: options.token.slice(0, 8),
    hookToken: options.token,
    events: [...events],
    backupPath,
    installedAt: now().toISOString(),
  };

  const statePath = await recordInstall(options.dataDir, record, now());

  return {
    settingsPath: options.settingsPath,
    backupPath,
    statePath,
    events,
    replaced: merged.replaced,
    createdSettingsFile: existing.present !== true,
  };
}

export interface UninstallHookProfileOptions {
  readonly dataDir: string;
  /** Limit the uninstall to one settings file; default is every recorded install. */
  readonly settingsPath?: string;
  readonly now?: () => Date;
}

export interface UninstallHookProfileResult {
  readonly removedFrom: readonly string[];
  readonly entriesRemoved: number;
  readonly missing: readonly string[];
}

/**
 * Remove the profile from every recorded install (or one named file).
 *
 * Deliberately **not** "restore the backup": the backup is a snapshot from install time, and
 * restoring it would throw away every change the operator made to their own settings since.
 * Surgical removal is the only reversal that respects the file's other owner.
 */
export async function uninstallHookProfile(
  options: UninstallHookProfileOptions,
): Promise<UninstallHookProfileResult> {
  const now = options.now ?? (() => new Date());
  const state = await readInstallState(options.dataDir);

  const targets =
    options.settingsPath === undefined
      ? state.installs
      : state.installs.filter((install) => install.settingsPath === options.settingsPath);

  const removedFrom: string[] = [];
  const missing: string[] = [];
  let entriesRemoved = 0;

  for (const install of targets) {
    const existing = await readSettingsFile(install.settingsPath);
    if (existing.present !== true) {
      missing.push(install.settingsPath);
      continue;
    }

    const result = removeHookProfile(existing.settings);
    if (result.removed === 0) {
      missing.push(install.settingsPath);
      continue;
    }

    await writeJsonFile(install.settingsPath, result.settings);
    entriesRemoved += result.removed;
    removedFrom.push(install.settingsPath);
  }

  const remaining = state.installs.filter(
    (install) => !targets.some((target) => target.settingsPath === install.settingsPath),
  );
  await writeState(options.dataDir, {
    version: HOOKS_STATE_VERSION,
    updatedAt: now().toISOString(),
    installs: remaining,
  });

  return { removedFrom, entriesRemoved, missing };
}

export async function readInstallState(dataDir: string): Promise<HooksState> {
  const raw = await readFile(hooksStatePath(dataDir), 'utf8').catch(() => null);
  if (raw === null) {
    return { version: HOOKS_STATE_VERSION, updatedAt: new Date(0).toISOString(), installs: [] };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<HooksState>;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : HOOKS_STATE_VERSION,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      installs: Array.isArray(parsed.installs) ? parsed.installs : [],
    };
  } catch {
    // A corrupt state file must not block an uninstall of the settings files themselves; the
    // caller can still name one explicitly.
    return { version: HOOKS_STATE_VERSION, updatedAt: new Date(0).toISOString(), installs: [] };
  }
}

interface ReadSettingsResult {
  readonly present: boolean;
  readonly settings: unknown;
}

/**
 * Read a settings file. A file that exists but does not parse throws — see the module header:
 * we do not overwrite what we could not read.
 */
async function readSettingsFile(settingsPath: string): Promise<ReadSettingsResult> {
  const raw = await readFile(settingsPath, 'utf8').catch(() => null);
  if (raw === null) return { present: false, settings: {} };
  if (raw.trim().length === 0) return { present: true, settings: {} };

  try {
    return { present: true, settings: JSON.parse(raw) };
  } catch (error) {
    throw new Error(
      `Refusing to write ${settingsPath}: it exists but is not valid JSON ` +
        `(${error instanceof Error ? error.message : 'parse failed'}). ` +
        'Fix or move the file and run the installer again.',
    );
  }
}

async function backupSettings(
  dataDir: string,
  scope: HookScope,
  settingsPath: string,
  at: Date,
): Promise<string> {
  const directory = join(dataDir, HOOKS_DIR, HOOKS_BACKUP_DIR);
  await mkdir(directory, { recursive: true });

  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const backupPath = join(directory, `settings-${scope}-${stamp}.json`);
  await copyFile(settingsPath, backupPath, constants.COPYFILE_EXCL).catch(
    async (error: unknown) => {
      // Same millisecond, same scope: fall back to an unsuffixed copy rather than failing an
      // install over a backup filename.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    },
  );

  return backupPath;
}

async function recordInstall(
  dataDir: string,
  record: HookInstallRecord,
  at: Date,
): Promise<string> {
  const state = await readInstallState(dataDir);
  const installs = [
    ...state.installs.filter((install) => install.settingsPath !== record.settingsPath),
    record,
  ];

  return writeState(dataDir, {
    version: HOOKS_STATE_VERSION,
    updatedAt: at.toISOString(),
    installs,
  });
}

async function writeState(dataDir: string, state: HooksState): Promise<string> {
  const path = hooksStatePath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECRET_FILE_MODE,
  });
  return path;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECRET_FILE_MODE,
  });
}
