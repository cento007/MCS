import { eq } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import { normalizeSetting, settingKey } from '../settings/registry.js';
import type {
  ObsidianConflictPolicy,
  ObsidianSettings,
  ObsidianSyncMode,
} from '../settings/types.js';

/**
 * `integrations.obsidian.*`, read from the database (TDS 04 §7.2, §7.6).
 *
 * It lives in `@mc/shared` rather than in `apps/backend/src/settings/` because the **Sync
 * Worker** is the process that needs it most, and a worker may not import a Backend module
 * (F2.2). The Backend's own `integrations.ts` reads a different slice (the three integrations
 * the schedule read model needs, without `conflictPolicy`); both go through the same key
 * registry, so the storage coordinates and defaults cannot drift.
 *
 * Every value is repaired through the registry's `normalize` on the way out: a `settings` row
 * is `jsonb` behind a `value_type` CHECK and nothing more, so a hand-edited row must degrade
 * to a documented default rather than take the worker down.
 */

const KEYS = Object.freeze({
  vaultPath: settingKey('integrations.obsidian.vaultPath'),
  syncMode: settingKey('integrations.obsidian.syncMode'),
  syncIntervalMinutes: settingKey('integrations.obsidian.syncIntervalMinutes'),
  conflictPolicy: settingKey('integrations.obsidian.conflictPolicy'),
});

/** The `ObsidianSettings` document (TDS 04 §7.2). No secrets — Obsidian has none. */
export type ObsidianSyncSettings = ObsidianSettings;

export function parseObsidianSettings(values: ReadonlyMap<string, unknown>): ObsidianSyncSettings {
  return {
    vaultPath: normalizeSetting<string | null>(
      'integrations.obsidian.vaultPath',
      values.get(KEYS.vaultPath),
    ),
    syncMode: normalizeSetting<ObsidianSyncMode>(
      'integrations.obsidian.syncMode',
      values.get(KEYS.syncMode),
    ),
    syncIntervalMinutes: normalizeSetting<number>(
      'integrations.obsidian.syncIntervalMinutes',
      values.get(KEYS.syncIntervalMinutes),
    ),
    conflictPolicy: normalizeSetting<ObsidianConflictPolicy>(
      'integrations.obsidian.conflictPolicy',
      values.get(KEYS.conflictPolicy),
    ),
  };
}

export async function readObsidianSettings(db: Db | DbTransaction): Promise<ObsidianSyncSettings> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.category, 'integrations'));

  return parseObsidianSettings(new Map(rows.map((row) => [row.key, row.value])));
}

/**
 * Is a sync possible right now, and if not, why?
 *
 * `POST /sync-runs` turns a `reason` into `INTEGRATION_NOT_CONFIGURED` (TDS 04 §10) and the
 * scheduler tick simply does not fire. Both consult this one function so the API and the
 * worker can never disagree about whether the vault is syncable.
 */
export type SyncBlockedReason = 'vault_path_missing' | 'sync_paused';

export function syncBlockedReason(settings: ObsidianSyncSettings): SyncBlockedReason | null {
  if (settings.vaultPath === null || settings.vaultPath.trim().length === 0) {
    return 'vault_path_missing';
  }
  if (settings.syncMode === 'paused') return 'sync_paused';
  return null;
}

/** Is a scheduled run due? `syncIntervalMinutes = 0` means "manual only" (§7.7). */
export function isScheduledSyncDue(input: {
  readonly settings: ObsidianSyncSettings;
  readonly lastRunAt: Date | null;
  readonly now: Date;
}): boolean {
  const { settings, lastRunAt, now } = input;
  if (syncBlockedReason(settings) !== null) return false;
  if (settings.syncIntervalMinutes <= 0) return false;
  if (lastRunAt === null) return true;
  return now.getTime() >= lastRunAt.getTime() + settings.syncIntervalMinutes * 60_000;
}
