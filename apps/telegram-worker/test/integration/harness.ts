import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { decodeEncryptionKey, encryptSecret, newId, type PgBossQueue, schema } from '@mc/shared';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../../src/db.js';
import { createWorkerQueue } from '../../src/queue.js';
import { createDenyingTelegramHttp, type TelegramHttpPort } from '../../src/telegram/http.js';

/**
 * Integration support for the Telegram Worker (TDS 07 §3, §12).
 *
 * Two rules this file exists to keep:
 *
 *  - **No test may reach api.telegram.org.** `denyingHttp()` is the default port in every
 *    factory here, and it *throws*. Accepting an override and forgetting to forward it is the
 *    exact defect that once let the Backend's integration suite call api.github.com for real;
 *    a denying default turns that mistake into an immediate, local failure.
 *  - **No real credential is used.** The `MC_ENCRYPTION_KEY` is generated per run and the only
 *    "bot token" in the repository is an obviously-fake constant sealed with it.
 */

/** Shaped like a Bot API token so redaction assertions are realistic. Not a credential. */
export const FAKE_BOT_TOKEN = '8123456789:AAF-mission-control-test-token-000000';
export const TEST_CHAT_ID = '-1001234567890';

let currentDatabaseUrl: string | null = null;
let currentDatabase: DatabaseHandle | null = null;
let currentQueue: PgBossQueue | null = null;
let currentEncryptionKey: string | null = null;
const queueErrors: Error[] = [];

export function setTestDatabaseUrl(url: string): void {
  currentDatabaseUrl = url;
}

export function testDatabaseUrl(): string {
  if (currentDatabaseUrl === null) {
    throw new Error('No test database — is this file running under the integration config?');
  }
  return currentDatabaseUrl;
}

export function testDatabase(): DatabaseHandle {
  currentDatabase ??= createDatabase({ connectionString: testDatabaseUrl(), maxConnections: 6 });
  return currentDatabase;
}

/** A per-run `MC_ENCRYPTION_KEY` (F8.2). Never read from `.env`; never written anywhere. */
export function testEncryptionKey(): string {
  currentEncryptionKey ??= randomBytes(32).toString('base64');
  return currentEncryptionKey;
}

/**
 * The real pg-boss queue over the run database, with the polling floor dropped to 250 ms so no
 * case waits out a 2-second poll. Maintenance and cron are off to keep runs quiet.
 */
export async function testQueue(): Promise<PgBossQueue> {
  if (currentQueue !== null) return currentQueue;

  const queue = createWorkerQueue({
    connectionString: testDatabaseUrl(),
    pollingIntervalSeconds: 0.25,
    supervise: false,
    schedule: false,
    onError: (error) => {
      queueErrors.push(error);
    },
  });

  await queue.start();
  currentQueue = queue;
  return queue;
}

export function reportedQueueErrors(): readonly Error[] {
  return queueErrors;
}

export async function closeTestResources(): Promise<void> {
  if (currentQueue !== null) {
    await currentQueue.stop();
    currentQueue = null;
  }
  if (currentDatabase !== null) {
    await currentDatabase.close();
    currentDatabase = null;
  }
}

/** Per-case reset (TDS 07 §3.1). `RESTART IDENTITY CASCADE` over the app tables. */
export async function truncateAll(): Promise<void> {
  const tables = [
    'notifications',
    'adrs',
    'commits',
    'pull_requests',
    'messages',
    'session_events',
    'transcript_tail_states',
    'sessions',
    'repositories',
    'projects',
    'workspaces',
    'sync_runs',
    'service_heartbeats',
    'users',
    'settings',
    'secret_items',
  ];
  const list = tables.map((name) => `public."${name}"`).join(', ');
  await testDatabase().db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
  await truncateQueue();
}

/**
 * Drop every queued job without touching the queue definitions: a job left over from the
 * previous case would be delivered to this one's consumer (TDS 07 §11.3).
 */
export async function truncateQueue(): Promise<void> {
  const exists = await testDatabase().db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
  );
  if (exists.rows[0]?.present !== true) return;
  await testDatabase().db.execute(sql.raw('TRUNCATE TABLE pgboss.job'));
}

// ------------------------------------------------------------------------------- the ports

/** The default outbound port everywhere in this tier: it refuses to make a request. */
export function denyingHttp(): TelegramHttpPort {
  return createDenyingTelegramHttp('the telegram-worker integration harness');
}

export interface RecordingHttp {
  readonly port: TelegramHttpPort;
  readonly requests: { url: string; body: Record<string, unknown> }[];
}

/**
 * A stub that answers with the given outcomes in order (repeating the last), recording every
 * request. This — not the network — is what every delivery test sends through.
 */
export function recordingHttp(
  ...outcomes: readonly Awaited<ReturnType<TelegramHttpPort>>[]
): RecordingHttp {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let index = 0;

  return {
    requests,
    port: async (request) => {
      requests.push({ url: request.url, body: request.body });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome === undefined) throw new Error('recordingHttp ran out of outcomes');
      return outcome;
    },
  };
}

export function okResponse(messageId = 42): Awaited<ReturnType<TelegramHttpPort>> {
  return {
    kind: 'response',
    status: 200,
    body: JSON.stringify({ ok: true, result: { message_id: messageId } }),
  };
}

export function errorResponse(
  status: number,
  body: Record<string, unknown>,
): Awaited<ReturnType<TelegramHttpPort>> {
  return { kind: 'response', status, body: JSON.stringify(body) };
}

// -------------------------------------------------------------------------------- factories

/** The single local account (F4.1) — the FK target every Notification needs. */
export async function seedUser(username = 'operator'): Promise<string> {
  const id = newId();
  await testDatabase().db.insert(schema.users).values({
    id,
    username,
    // Not a credential: no code path verifies against it and this account cannot log in.
    passwordHash: 'not-a-credential:this-account-cannot-log-in',
  });
  return id;
}

export type SettingsCategory =
  | 'general'
  | 'integrations'
  | 'notifications'
  | 'memory'
  | 'agents'
  | 'security';

/** Write a `settings` row directly, using the WS2 §7.6 storage coordinates. */
export async function setSetting(
  category: SettingsCategory,
  key: string,
  value: unknown,
): Promise<void> {
  const valueType = Array.isArray(value)
    ? 'array'
    : value !== null && typeof value === 'object'
      ? 'object'
      : (typeof value as 'string' | 'number' | 'boolean');

  await testDatabase()
    .db.insert(schema.settings)
    .values({ id: newId(), category, key, value, valueType })
    .onConflictDoUpdate({
      target: [schema.settings.category, schema.settings.key],
      set: { value, valueType },
    });
}

/**
 * Seal the fake bot token with this run's `MC_ENCRYPTION_KEY`, through the real crypto path —
 * so the worker's unseal is genuinely exercised rather than stubbed.
 */
export async function setBotToken(token: string = FAKE_BOT_TOKEN): Promise<void> {
  const sealed = encryptSecret(
    token,
    { category: 'integrations', key: 'telegram_bot_token' },
    decodeEncryptionKey(testEncryptionKey()),
  );

  await testDatabase()
    .db.insert(schema.secretItems)
    .values({
      id: newId(),
      category: 'integrations',
      key: 'telegram_bot_token',
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
    })
    .onConflictDoUpdate({
      target: [schema.secretItems.category, schema.secretItems.key],
      set: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyVersion: sealed.keyVersion },
    });
}

/** A `secret_items` row whose bytes were sealed with a DIFFERENT key — the restore scenario. */
export async function setUnreadableBotToken(): Promise<void> {
  const other = randomBytes(32);
  const sealed = encryptSecret(
    'whatever',
    { category: 'integrations', key: 'telegram_bot_token' },
    other,
  );

  await testDatabase()
    .db.insert(schema.secretItems)
    .values({
      id: newId(),
      category: 'integrations',
      key: 'telegram_bot_token',
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
    })
    .onConflictDoUpdate({
      target: [schema.secretItems.category, schema.secretItems.key],
      set: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyVersion: sealed.keyVersion },
    });
}

/** Telegram fully configured: master switch on, chat id set, a sealed (fake) token. */
export async function configureTelegram(): Promise<void> {
  await setSetting('integrations', 'telegram_enabled', true);
  await setSetting('integrations', 'telegram_chat_id', TEST_CHAT_ID);
  await setBotToken();
}

export interface SeedNotificationInput {
  readonly userId: string;
  readonly type?: string;
  readonly title?: string;
  readonly body?: string;
  readonly payload?: Record<string, unknown> | null;
  readonly telegramStatus?: 'skipped' | 'pending' | 'sent' | 'failed';
  readonly createdAt?: Date;
}

export async function seedNotification(input: SeedNotificationInput): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.notifications)
    .values({
      id,
      userId: input.userId,
      type: input.type ?? 'session_completed',
      severity: 'info',
      title: input.title ?? 'Session completed — Refactor the queue port',
      body: input.body ?? 'Project: Mission Control\nCommits: 3',
      payload: input.payload ?? null,
      telegramStatus: input.telegramStatus ?? 'pending',
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  return id;
}

export async function notificationRow(
  id: string,
): Promise<typeof schema.notifications.$inferSelect> {
  const rows = await testDatabase()
    .db.select()
    .from(schema.notifications)
    .where(sql`${schema.notifications.id} = ${id}`)
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw new Error(`No notification ${id}`);
  return row;
}

/** Jobs currently on a queue, oldest first. Reads pg-boss's vendored table (tests only). */
export async function jobsOn(
  name: string,
): Promise<{ id: string; data: Record<string, unknown>; start_after: Date }[]> {
  const result = await testDatabase().db.execute<{
    id: string;
    data: Record<string, unknown>;
    start_after: Date;
  }>(sql`SELECT id, data, start_after FROM pgboss.job WHERE name = ${name} ORDER BY created_on`);
  return result.rows;
}

/** Envelopes of one F6 type currently on the `events` queue. */
export async function eventsOfType(type: string): Promise<Record<string, unknown>[]> {
  const result = await testDatabase().db.execute<{ data: Record<string, unknown> }>(
    sql`SELECT data FROM pgboss.job WHERE name = 'events' AND data->>'type' = ${type}
        ORDER BY created_on`,
  );
  return result.rows.map((row) => row.data);
}

export function bufferOf(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill);
}
