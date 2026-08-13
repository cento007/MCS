import type { Buffer } from 'node:buffer';
import {
  CryptoError,
  CURRENT_KEY_VERSION,
  type DailyReportSettings,
  type Db,
  decodeEncryptionKey,
  decryptSecret,
  type NotificationEventToggles,
  normalizeSetting,
  type QuietHoursSettings,
  schema,
  settingKey,
  type TelegramConfiguration,
} from '@mc/shared';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Everything the worker reads out of Settings (TDS 04 §7.2, F8.2), and the **only** place it
 * unseals the bot token.
 *
 * Two rules, and the types enforce the first:
 *
 *  1. **`TelegramDeliverySettings` has no token field.** Nothing that returns configuration can
 *     carry the credential, so no caller can log, serialize or audit one by handing the settings
 *     object to a formatter. The plaintext is reachable only through `readBotToken`, which
 *     returns it inside a discriminated union and hands it straight to the one consumer that
 *     must have it — the request URL.
 *  2. **"Not configured" is a distinguishable answer, not a failure.** A missing secret row is
 *     `not_configured` and settles the delivery as `skipped`; a row this process cannot decrypt
 *     is `unreadable` with an operator-actionable sentence. Collapsing the two would send an
 *     operator to re-issue a token they never saved.
 *
 * Settings are read **per operation** rather than cached. This is a single-user system: the
 * three reads here are index lookups on tables with a handful of rows, and a cache would buy
 * microseconds in exchange for the one bug that actually hurts — delivering with the settings
 * an operator changed five minutes ago. `setting.updated` therefore needs no cache
 * invalidation in this process.
 */

export const TELEGRAM_KEYS = Object.freeze({
  enabled: settingKey('integrations.telegram.enabled'),
  chatId: settingKey('integrations.telegram.chatId'),
  botToken: settingKey('integrations.telegram.botToken'),
} as const);

export const NOTIFICATION_KEYS = Object.freeze({
  events: settingKey('notifications.events'),
  dailyReport: settingKey('notifications.dailyReport'),
  quietHours: settingKey('notifications.quietHours'),
} as const);

export const GENERAL_KEYS = Object.freeze({
  timezone: settingKey('general.timezone'),
} as const);

export interface TelegramDeliverySettings extends TelegramConfiguration {
  readonly enabled: boolean;
  readonly chatId: string | null;
  readonly botTokenIsSet: boolean;
  readonly chatIdIsSet: boolean;
}

export interface WorkerNotificationSettings {
  readonly events: NotificationEventToggles;
  readonly dailyReport: DailyReportSettings;
  readonly quietHours: QuietHoursSettings;
}

export async function readTelegramSettings(db: Db): Promise<TelegramDeliverySettings> {
  const [values, secrets] = await Promise.all([
    readCategory(db, 'integrations'),
    readSecretKeys(db, 'integrations'),
  ]);

  const chatId = normalizeSetting<string | null>(
    'integrations.telegram.chatId',
    values.get(TELEGRAM_KEYS.chatId),
  );

  return {
    enabled: normalizeSetting<boolean>(
      'integrations.telegram.enabled',
      values.get(TELEGRAM_KEYS.enabled),
    ),
    chatId,
    chatIdIsSet: chatId !== null,
    botTokenIsSet: secrets.has(TELEGRAM_KEYS.botToken),
  };
}

export async function readNotificationSettings(db: Db): Promise<WorkerNotificationSettings> {
  const values = await readCategory(db, 'notifications');

  return {
    events: normalizeSetting<NotificationEventToggles>(
      'notifications.events',
      values.get(NOTIFICATION_KEYS.events),
    ),
    dailyReport: normalizeSetting<DailyReportSettings>(
      'notifications.dailyReport',
      values.get(NOTIFICATION_KEYS.dailyReport),
    ),
    quietHours: normalizeSetting<QuietHoursSettings>(
      'notifications.quietHours',
      values.get(NOTIFICATION_KEYS.quietHours),
    ),
  };
}

/** `general.timezone`, or `UTC` when unset or unparseable (TDS 04 §7.8's rule). */
export async function readTimezone(db: Db): Promise<string> {
  const values = await readCategory(db, 'general');
  return normalizeSetting<string>('general.timezone', values.get(GENERAL_KEYS.timezone));
}

/**
 * The single local account (F4.1) — `notifications.user_id` is NOT NULL with an FK, so the
 * daily report needs a recipient before it can write a row.
 */
export async function readNotificationRecipientId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
    .limit(1);

  return rows[0]?.id ?? null;
}

// ------------------------------------------------------------------------------- the token

export type BotTokenRead =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'unreadable'; readonly message: string };

export interface BotTokenReaderOptions {
  /** Base64 `MC_ENCRYPTION_KEY` (F8.2). */
  readonly encryptionKey: string;
}

/**
 * Unseal `secret_items('integrations', 'telegram_bot_token')`.
 *
 * AES-256-GCM under `MC_ENCRYPTION_KEY` with AAD `"integrations/telegram_bot_token"` — the
 * shared crypto module, so the bytes the Backend sealed are the bytes this process opens
 * (TDS 03 §3.13). Nothing in this function logs, and its error paths carry no ciphertext, no
 * key material and no plaintext: the realistic cause of a failure is a database restored
 * alongside a different `MC_ENCRYPTION_KEY`, and the message says exactly that.
 */
export function createBotTokenReader(
  options: BotTokenReaderOptions,
): (db: Db) => Promise<BotTokenRead> {
  let key: Buffer | null = null;
  let keyError: string | null = null;

  try {
    key = decodeEncryptionKey(options.encryptionKey);
  } catch (error) {
    /* c8 ignore next 3 — unreachable through the loader, which validates the key length */
    keyError =
      error instanceof CryptoError ? error.message : 'MC_ENCRYPTION_KEY could not be decoded';
  }

  return async (db) => {
    if (key === null) {
      return { kind: 'unreadable', message: keyError ?? 'MC_ENCRYPTION_KEY is not configured' };
    }

    const rows = await db
      .select({
        ciphertext: schema.secretItems.ciphertext,
        nonce: schema.secretItems.nonce,
        keyVersion: schema.secretItems.keyVersion,
      })
      .from(schema.secretItems)
      .where(
        and(
          eq(schema.secretItems.category, 'integrations'),
          eq(schema.secretItems.key, TELEGRAM_KEYS.botToken),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return { kind: 'not_configured' };

    if (row.keyVersion !== CURRENT_KEY_VERSION) {
      return {
        kind: 'unreadable',
        message:
          `The stored Telegram bot token was sealed under key_version ${row.keyVersion}; ` +
          `this process holds ${CURRENT_KEY_VERSION}. Re-enter it in Settings to re-seal it.`,
      };
    }

    try {
      return {
        kind: 'token',
        token: decryptSecret(
          { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion },
          { category: 'integrations', key: TELEGRAM_KEYS.botToken },
          key,
        ),
      };
    } catch {
      return {
        kind: 'unreadable',
        message:
          'The stored Telegram bot token could not be decrypted. It was sealed with a different ' +
          'MC_ENCRYPTION_KEY, or the row was tampered with. Re-enter it in Settings to re-seal it.',
      };
    }
  };
}

// ---------------------------------------------------------------------------------- reads

async function readCategory(
  db: Db,
  category: 'general' | 'integrations' | 'notifications',
): Promise<ReadonlyMap<string, unknown>> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.category, category));

  return new Map(rows.map((row) => [row.key, row.value]));
}

/** Presence only — this function cannot return ciphertext, let alone plaintext. */
async function readSecretKeys(db: Db, category: 'integrations'): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ key: schema.secretItems.key })
    .from(schema.secretItems)
    .where(eq(schema.secretItems.category, category));

  return new Set(rows.map((row) => row.key));
}
