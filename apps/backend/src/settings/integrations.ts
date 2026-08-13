import { type Db, normalizeSetting, type ObsidianSyncMode, settingKey } from '@mc/shared';
import { readCategoryValues, readSecretKeys } from './values.js';

/**
 * The `integrations.obsidian` / `.github` / `.telegram` fields the schedule read model needs
 * (TDS 04 §7.7). Grouped in one file because §7.7 reads all three in one request and each
 * contributes two or three fields; `claude-code.ts` stays separate because the Session domain
 * consumes it on a different path.
 *
 * Storage coordinates and defaults come from the key registry (§7.6) — `integrations` is one
 * DB category holding every integration, key prefixed with the integration name:
 *
 *   `integrations.obsidian.vaultPath`          -> `('integrations', 'obsidian_vault_path')`
 *   `integrations.obsidian.syncMode`           -> `('integrations', 'obsidian_sync_mode')`
 *   `integrations.obsidian.syncIntervalMinutes`-> `('integrations', 'obsidian_sync_interval_minutes')`
 *   `integrations.github.syncIntervalMinutes`  -> `('integrations', 'github_sync_interval_minutes')`
 *   `integrations.github.token`                -> `secret_items('integrations', 'github_token')`
 *   `integrations.telegram.enabled`            -> `('integrations', 'telegram_enabled')`
 *   `integrations.telegram.chatId`             -> `('integrations', 'telegram_chat_id')`
 *   `integrations.telegram.botToken`           -> `secret_items('integrations', 'telegram_bot_token')`
 *
 * **Absent interval rows default to `0`, not to the value the Settings form pre-fills.** §7.7
 * reads `syncIntervalMinutes > 0` as "scheduled" and `0` as "manual only", so an unwritten row
 * has to mean "never configured" — inventing 15 minutes here would make the Dashboard promise a
 * sync that no worker has been told to run.
 */

export type { ObsidianSyncMode };

export const INTEGRATION_SETTING_KEYS = Object.freeze({
  obsidianVaultPath: settingKey('integrations.obsidian.vaultPath'),
  obsidianSyncMode: settingKey('integrations.obsidian.syncMode'),
  obsidianSyncIntervalMinutes: settingKey('integrations.obsidian.syncIntervalMinutes'),
  githubSyncIntervalMinutes: settingKey('integrations.github.syncIntervalMinutes'),
  githubToken: settingKey('integrations.github.token'),
  telegramEnabled: settingKey('integrations.telegram.enabled'),
  telegramBotToken: settingKey('integrations.telegram.botToken'),
  telegramChatId: settingKey('integrations.telegram.chatId'),
} as const);

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

/**
 * The Telegram fields no consumer of this module is allowed to see the token through.
 *
 * `botTokenIsSet` / `chatIdIsSet` are presence only (§7.1 `{ isSet }`): the schedule read model
 * needs to know whether delivery is *possible*, and the Notification producer needs to decide
 * between `pending` and a terminal `skipped` — neither needs the credential, so neither is
 * given a shape that could carry it.
 */
export interface TelegramScheduleSettings {
  readonly enabled: boolean;
  readonly botTokenIsSet: boolean;
  readonly chatIdIsSet: boolean;
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
      vaultPath: normalizeSetting<string | null>(
        'integrations.obsidian.vaultPath',
        values.get(INTEGRATION_SETTING_KEYS.obsidianVaultPath),
      ),
      syncMode: normalizeSetting<ObsidianSyncMode>(
        'integrations.obsidian.syncMode',
        values.get(INTEGRATION_SETTING_KEYS.obsidianSyncMode),
      ),
      syncIntervalMinutes: normalizeSetting<number>(
        'integrations.obsidian.syncIntervalMinutes',
        values.get(INTEGRATION_SETTING_KEYS.obsidianSyncIntervalMinutes),
      ),
    },
    github: {
      tokenIsSet: secretKeys.has(INTEGRATION_SETTING_KEYS.githubToken),
      syncIntervalMinutes: normalizeSetting<number>(
        'integrations.github.syncIntervalMinutes',
        values.get(INTEGRATION_SETTING_KEYS.githubSyncIntervalMinutes),
      ),
    },
    telegram: {
      enabled: normalizeSetting<boolean>(
        'integrations.telegram.enabled',
        values.get(INTEGRATION_SETTING_KEYS.telegramEnabled),
      ),
      botTokenIsSet: secretKeys.has(INTEGRATION_SETTING_KEYS.telegramBotToken),
      chatIdIsSet:
        normalizeSetting<string | null>(
          'integrations.telegram.chatId',
          values.get(INTEGRATION_SETTING_KEYS.telegramChatId),
        ) !== null,
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
