import type { Db } from '@mc/shared';
import {
  booleanValue,
  enumValue,
  integerValue,
  readCategoryValues,
  readSecretKeys,
  stringValue,
} from './values.js';

/**
 * The `integrations.obsidian` / `.github` / `.telegram` fields the schedule read model needs
 * (TDS 04 §7.7). Grouped in one file because §7.7 reads all three in one request and each
 * contributes two or three fields; `claude-code.ts` stays separate because the Session domain
 * consumes it on a different path.
 *
 * Storage coordinates per the §7.6 derivation rule (`integrations` is one DB category holding
 * every integration, key prefixed with the integration name):
 *
 *   `integrations.obsidian.vaultPath`          -> `('integrations', 'obsidian_vault_path')`
 *   `integrations.obsidian.syncMode`           -> `('integrations', 'obsidian_sync_mode')`
 *   `integrations.obsidian.syncIntervalMinutes`-> `('integrations', 'obsidian_sync_interval_minutes')`
 *   `integrations.github.syncIntervalMinutes`  -> `('integrations', 'github_sync_interval_minutes')`
 *   `integrations.github.token`                -> `secret_items('integrations', 'github_token')`
 *   `integrations.telegram.enabled`            -> `('integrations', 'telegram_enabled')`
 *   `integrations.telegram.botToken`           -> `secret_items('integrations', 'telegram_bot_token')`
 *
 * **Absent interval rows default to `0`, not to the value the Settings form pre-fills.** §7.7
 * reads `syncIntervalMinutes > 0` as "scheduled" and `0` as "manual only", so an unwritten row
 * has to mean "never configured" — inventing 15 minutes here would make the Dashboard promise a
 * sync that no worker has been told to run.
 */

export const INTEGRATION_SETTING_KEYS = Object.freeze({
  obsidianVaultPath: 'obsidian_vault_path',
  obsidianSyncMode: 'obsidian_sync_mode',
  obsidianSyncIntervalMinutes: 'obsidian_sync_interval_minutes',
  githubSyncIntervalMinutes: 'github_sync_interval_minutes',
  githubToken: 'github_token',
  telegramEnabled: 'telegram_enabled',
  telegramBotToken: 'telegram_bot_token',
} as const);

/** A schedule interval nobody sane configures beyond this; a larger row is corrupt. */
const MAX_INTERVAL_MINUTES = 60 * 24 * 365;

const OBSIDIAN_SYNC_MODES = ['two_way', 'one_way', 'paused'] as const;
export type ObsidianSyncMode = (typeof OBSIDIAN_SYNC_MODES)[number];

export interface ObsidianScheduleSettings {
  /** Absolute native path (F8.1), or `null` when no vault is configured. */
  readonly vaultPath: string | null;
  readonly syncMode: ObsidianSyncMode;
  readonly syncIntervalMinutes: number;
}

export interface GithubScheduleSettings {
  /** `secret_items` presence only — §7.1 `{ isSet }`, never the PAT itself. */
  readonly tokenIsSet: boolean;
  readonly syncIntervalMinutes: number;
}

export interface TelegramScheduleSettings {
  readonly enabled: boolean;
  readonly botTokenIsSet: boolean;
}

export interface ScheduleIntegrationSettings {
  readonly obsidian: ObsidianScheduleSettings;
  readonly github: GithubScheduleSettings;
  readonly telegram: TelegramScheduleSettings;
}

export function parseScheduleIntegrationSettings(
  values: ReadonlyMap<string, unknown>,
  secretKeys: ReadonlySet<string>,
): ScheduleIntegrationSettings {
  return {
    obsidian: {
      vaultPath: stringValue(values.get(INTEGRATION_SETTING_KEYS.obsidianVaultPath)),
      syncMode: enumValue(
        values.get(INTEGRATION_SETTING_KEYS.obsidianSyncMode),
        OBSIDIAN_SYNC_MODES,
        'two_way',
      ),
      syncIntervalMinutes: integerValue(
        values.get(INTEGRATION_SETTING_KEYS.obsidianSyncIntervalMinutes),
        0,
        { min: 0, max: MAX_INTERVAL_MINUTES },
      ),
    },
    github: {
      tokenIsSet: secretKeys.has(INTEGRATION_SETTING_KEYS.githubToken),
      syncIntervalMinutes: integerValue(
        values.get(INTEGRATION_SETTING_KEYS.githubSyncIntervalMinutes),
        0,
        { min: 0, max: MAX_INTERVAL_MINUTES },
      ),
    },
    telegram: {
      enabled: booleanValue(values.get(INTEGRATION_SETTING_KEYS.telegramEnabled), false),
      botTokenIsSet: secretKeys.has(INTEGRATION_SETTING_KEYS.telegramBotToken),
    },
  };
}

/** One `settings` read plus one `secret_items` read — both bounded by category. */
export async function readScheduleIntegrationSettings(
  db: Db,
): Promise<ScheduleIntegrationSettings> {
  const [values, secretKeys] = await Promise.all([
    readCategoryValues(db, 'integrations'),
    readSecretKeys(db, 'integrations'),
  ]);
  return parseScheduleIntegrationSettings(values, secretKeys);
}
