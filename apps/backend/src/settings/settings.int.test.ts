import {
  createFakeEmbedder,
  DEFAULT_MEMORY_COLLECTION,
  type EventEnvelope,
  type IntegrationsSettings,
  type MemoryCollectionInfo,
  type PgBossQueue,
  QUEUE_NAMES,
  schema,
  settingKey,
  type VectorStoreOutcome,
  type VectorStorePort,
} from '@mc/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { ExecutorDeps } from './test-connection/executors.js';

/**
 * The Settings API end to end (TDS 04 §7.1–§7.4, PRD §4.4) against real PostgreSQL.
 *
 * What only this tier can prove:
 *
 *  - the `ck_settings_value_matches_type` CHECK actually accepts what the registry writes;
 *  - a secret round-trips through `secret_items` and **never appears in a response, an audit
 *    row or an event payload** — asserted by scanning serialized output for the plaintext,
 *    which is the only assertion that stays true when someone adds a field later;
 *  - `setting.updated` and the audit rows commit in the same transaction as the change.
 */

const GITHUB_TOKEN = 'ghp_int_test_plaintext_value';
const TELEGRAM_TOKEN = '123456:int-test-bot-token';
const QDRANT_KEY = 'qdrant-int-test-api-key-plaintext';
const EMBEDDING_MODEL = 'nomic-embed-text';

/**
 * What the stubbed Qdrant answers, as a function of **the API key it was constructed with**.
 *
 * A function rather than a value so a test can prove the whole credential path in one
 * assertion: the key travels from `secret_items` through the vault into the adapter, the double
 * echoes the plaintext it received back as a failure reason, and the response must still not
 * contain it. Reset in `beforeEach`; the double reads it at call time.
 */
let qdrantAnswer: (apiKey: string | null) => VectorStoreOutcome<MemoryCollectionInfo>;

const HEALTHY_COLLECTION: VectorStoreOutcome<MemoryCollectionInfo> = {
  kind: 'ok',
  value: {
    name: DEFAULT_MEMORY_COLLECTION,
    exists: true,
    pointCount: 3,
    stamp: { model: EMBEDDING_MODEL, dimension: 768 },
    schemaVersion: 1,
    vectorSize: 768,
  },
};

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;

/** Stubbed edges: this suite never touches the network, the filesystem or a child process. */
const testConnectionDeps: ExecutorDeps = {
  http: async (request) => ({
    kind: 'response',
    status: 200,
    headers: { 'x-oauth-scopes': 'repo' },
    // Echo the URL back so a leaked Telegram token would show up in the assertions below.
    body: JSON.stringify({
      login: 'cento007',
      ok: true,
      result: { username: 'mc_bot' },
      url: request.url,
    }),
  }),
  path: async () => ({
    kind: 'stat',
    exists: true,
    isDirectory: true,
    readable: true,
    writable: true,
  }),
  command: async () => ({ kind: 'exit', code: 0, stdout: '2.1.4', stderr: '' }),
  memory: {
    // `@mc/shared`'s own fake, so this double tracks `EmbeddingPort` rather than freezing a
    // copy of last month's shape.
    embedder: (target) => createFakeEmbedder({ model: target.model, dimension: 768 }),
    store: (target): VectorStorePort => {
      // A Test Connection reads. Anything that would change the collection fails the suite
      // rather than the assertion, so the guarantee survives a future refactor of the executor.
      const refuse = (): never => {
        throw new Error('Test Connection must not write to Qdrant');
      };
      return {
        collection: DEFAULT_MEMORY_COLLECTION,
        describeCollection: async () => qdrantAnswer(target.apiKey),
        ensureCollection: refuse,
        resetCollection: refuse,
        upsert: refuse,
        search: refuse,
        deleteByFilter: refuse,
      };
    },
  },
};

function auth(): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
}

async function get<T>(url: string): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: auth() });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: T }>().data;
}

async function put<T>(url: string, payload: object, expectedStatus = 200): Promise<T> {
  const response = await app.inject({ method: 'PUT', url, headers: auth(), payload });
  expect(response.statusCode).toBe(expectedStatus);
  return response.json<{ data: T }>().data;
}

async function settingRows(): Promise<{ key: string; value: unknown; valueType: string }[]> {
  return testDatabase()
    .db.select({
      key: schema.settings.key,
      value: schema.settings.value,
      valueType: schema.settings.valueType,
    })
    .from(schema.settings);
}

/**
 * Settings-related audit rows only.
 *
 * `seedUser` + the login in `beforeEach` write their own entries (`auth.bootstrap`,
 * `auth.login`), and counting those here would make every assertion below depend on how the
 * test authenticated rather than on what it changed.
 */
async function auditRows(): Promise<(typeof schema.auditLogEntries.$inferSelect)[]> {
  const rows = await testDatabase()
    .db.select()
    .from(schema.auditLogEntries)
    .orderBy(schema.auditLogEntries.createdAt, schema.auditLogEntries.id);

  return rows.filter(
    (row) => row.action === 'setting.updated' || row.action === 'secret_item.updated',
  );
}

async function events(): Promise<EventEnvelope[]> {
  const result = await testDatabase().db.execute<{ data: EventEnvelope }>(
    sql`SELECT data FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS} ORDER BY created_on`,
  );
  return result.rows.map((row) => row.data);
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  qdrantAnswer = () => HEALTHY_COLLECTION;

  const user = await seedUser();
  userId = user.id;

  built = createTestApp({ queue, cookieSecure: false, testConnectionDeps });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

afterEach(async () => {
  await built?.sessions.registry.stop();
  await built?.app.close();
});

describe('reads on an empty database (§7.2)', () => {
  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings/general' });
    expect(response.statusCode).toBe(401);
  });

  it('serves registry defaults with no rows at all', async () => {
    expect(await settingRows()).toHaveLength(0);

    expect(await get('/api/v1/settings/general')).toEqual({
      instanceName: 'Mission Control',
      timezone: 'UTC',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
      theme: 'dark',
      defaultLandingPage: 'dashboard',
    });
  });

  it('serves all six integrations with their secrets unset', async () => {
    const integrations = await get<IntegrationsSettings>('/api/v1/settings/integrations');

    expect(Object.keys(integrations)).toEqual([
      'github',
      'claudeCode',
      'telegram',
      'obsidian',
      'qdrant',
      'ollama',
    ]);
    expect(integrations.github.token).toEqual({ isSet: false, updatedAt: null });
    expect(integrations.qdrant.apiKey).toEqual({ isSet: false, updatedAt: null });
  });

  it('serves the whole document, including the one Phase 4 field that has a consumer', async () => {
    const document = await get<Record<string, unknown>>('/api/v1/settings');

    expect(Object.keys(document)).toEqual([
      'general',
      'integrations',
      'notifications',
      'memory',
      'agents',
      'security',
    ]);
    // `agents` carries `defaultPermissionTemplate` and nothing else — `POST /agents` reads it,
    // and §7.2's other reserved key still has no reader. `memory` has both of its PRD §4.4
    // item 4 fields. All of it served from the registry on a database with no rows at all.
    expect(document['agents']).toEqual({ defaultPermissionTemplate: 'read_only' });
    expect(document['memory']).toEqual({
      indexedSources: {
        session: true,
        commit: true,
        adr: true,
        obsidianNote: true,
        pullRequest: true,
        document: true,
      },
      retentionDays: { session: 0, project: 0, global: 0 },
    });
  });
});

describe('full-category replace (§7.3, arbitration A14)', () => {
  it('persists what it was sent and answers with the stored document', async () => {
    const saved = await put<Record<string, unknown>>('/api/v1/settings/general', {
      instanceName: 'Mission Control — Home',
      timezone: 'Europe/Amsterdam',
      dateFormat: 'DD-MM-YYYY',
      timeFormat: '12h',
      theme: 'dark',
      defaultLandingPage: 'sessions',
    });

    expect(saved['timezone']).toBe('Europe/Amsterdam');
    expect(await get('/api/v1/settings/general')).toEqual(saved);
  });

  it('writes each value with the `value_type` its CHECK requires', async () => {
    await put('/api/v1/settings/security', {
      sessionTimeoutMinutes: 1440,
      auditLogRetentionDays: 90,
      allowedOrigins: ['https://mc.local'],
    });
    await put('/api/v1/settings/notifications', {
      events: { sessionComplete: false },
      dailyReport: { enabled: true, time: '07:30' },
      quietHours: { enabled: true, start: '22:00', end: '06:00' },
    });

    const byKey = new Map((await settingRows()).map((row) => [row.key, row]));
    expect(byKey.get('session_timeout_minutes')?.valueType).toBe('number');
    expect(byKey.get('allowed_origins')?.valueType).toBe('array');
    expect(byKey.get('events')?.valueType).toBe('object');
    expect(byKey.get('quiet_hours')?.value).toEqual({
      enabled: true,
      start: '22:00',
      end: '06:00',
    });
  });

  it('resets an omitted non-secret field to its default', async () => {
    await put('/api/v1/settings/general', { theme: 'light', timezone: 'Europe/Amsterdam' });

    // The second body omits `timezone` entirely: under a full replace that is an instruction,
    // not an oversight, and the field goes back to the registry default.
    const saved = await put<Record<string, unknown>>('/api/v1/settings/general', {
      theme: 'light',
    });

    expect(saved['timezone']).toBe('UTC');
    expect(saved['theme']).toBe('light');
  });

  it('stores a nullable field as row-absence, because `value_type` has no null', async () => {
    await put('/api/v1/settings/integrations/github', { account: 'cento007' });
    expect((await settingRows()).map((row) => row.key)).toContain('github_account');

    const cleared = await put<Record<string, unknown>>('/api/v1/settings/integrations/github', {
      account: null,
    });

    expect(cleared['account']).toBeNull();
    expect((await settingRows()).map((row) => row.key)).not.toContain('github_account');
  });

  it('rejects an unknown field by name instead of silently resetting the one meant', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/general',
      headers: auth(),
      payload: { instanceNam: 'typo' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('instanceNam');
    expect(await settingRows()).toHaveLength(0);
  });

  it('writes nothing and emits nothing when the body changes nothing', async () => {
    await put('/api/v1/settings/general', { theme: 'light' });
    const baseline = (await auditRows()).length;

    await put('/api/v1/settings/general', { theme: 'light' });

    expect((await auditRows()).length).toBe(baseline);
    expect((await events()).filter((event) => event.type === 'setting.updated')).toHaveLength(1);
  });
});

describe('secrets (§7.1)', () => {
  async function saveToken(token: string | null | undefined): Promise<Record<string, unknown>> {
    return put<Record<string, unknown>>('/api/v1/settings/integrations/github', {
      account: 'cento007',
      ...(token === undefined ? {} : { token }),
    });
  }

  it('seals a secret into `secret_items` and never into `settings`', async () => {
    await saveToken(GITHUB_TOKEN);

    const secrets = await testDatabase()
      .db.select()
      .from(schema.secretItems)
      .where(
        and(
          eq(schema.secretItems.category, 'integrations'),
          eq(schema.secretItems.key, settingKey('integrations.github.token')),
        ),
      );

    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.nonce.byteLength).toBe(12);
    expect(secrets[0]?.keyVersion).toBe(1);
    expect(secrets[0]?.ciphertext.toString('utf8')).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(await settingRows())).not.toContain(GITHUB_TOKEN);
  });

  it('answers a write with `{ isSet, updatedAt }` and never the value (A15)', async () => {
    const saved = await saveToken(GITHUB_TOKEN);
    const token = saved['token'] as { isSet: boolean; updatedAt: string };

    expect(token.isSet).toBe(true);
    expect(Number.isNaN(Date.parse(token.updatedAt))).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps an omitted secret and clears an explicit `null`', async () => {
    await saveToken(GITHUB_TOKEN);

    // Omitted: the client cannot resend what it may not read, so a plain save must not destroy
    // the credential — this is the one exception to full-category replace.
    const afterOmit = await saveToken(undefined);
    expect((afterOmit['token'] as { isSet: boolean }).isSet).toBe(true);

    const afterClear = await saveToken(null);
    expect(afterClear['token']).toEqual({ isSet: false, updatedAt: null });
    expect(await testDatabase().db.select().from(schema.secretItems)).toHaveLength(0);
  });

  it('never lets the plaintext reach ANY response, audit row or event payload', async () => {
    await saveToken(GITHUB_TOKEN);
    await put('/api/v1/settings/integrations/telegram', {
      enabled: true,
      chatId: '-100123',
      botToken: TELEGRAM_TOKEN,
    });

    const surfaces = [
      JSON.stringify(await get('/api/v1/settings')),
      JSON.stringify(await get('/api/v1/settings/integrations')),
      JSON.stringify(await auditRows()),
      JSON.stringify(await events()),
      JSON.stringify(
        await app
          .inject({ method: 'GET', url: '/api/v1/audit-log-entries', headers: auth() })
          .then((response) => response.json()),
      ),
    ];

    for (const surface of surfaces) {
      expect(surface).not.toContain(GITHUB_TOKEN);
      expect(surface).not.toContain(TELEGRAM_TOKEN);
    }
  });

  it('records that a secret changed, never what it changed to (TDS 03 §3.13)', async () => {
    await saveToken(GITHUB_TOKEN);

    const secretAudit = (await auditRows()).find((row) => row.action === 'secret_item.updated');

    expect(secretAudit?.entityType).toBe('secret_items');
    expect(secretAudit?.before).toEqual({ set: false });
    expect(secretAudit?.after).toMatchObject({ set: true, key: 'github_token' });
    expect(JSON.stringify(secretAudit)).not.toContain(GITHUB_TOKEN);
  });
});

describe('audit and events (§12, §15.2 event 21)', () => {
  it('writes an audit row with the actor and the changed keys, and emits `setting.updated`', async () => {
    await put('/api/v1/settings/general', { theme: 'light', timezone: 'Europe/Amsterdam' });

    const row = (await auditRows()).find((entry) => entry.action === 'setting.updated');
    expect(row).toMatchObject({
      actorType: 'user',
      actorId: userId,
      entityType: 'settings',
      entityId: null,
    });
    expect(row?.requestId).not.toBeNull();
    expect(row?.after).toMatchObject({
      category: 'general',
      integration: null,
      authMethod: 'cookie',
      values: { theme: 'light', timezone: 'Europe/Amsterdam' },
    });
    expect(row?.before).toMatchObject({ values: { theme: 'dark', timezone: 'UTC' } });

    const updated = (await events()).find((event) => event.type === 'setting.updated');
    expect(updated?.payload).toMatchObject({
      category: 'general',
      integration: null,
      actorId: userId,
    });
    // §7.6: DB keys, names only — never values.
    expect(updated?.payload['changedKeys']).toEqual(['timezone', 'theme']);
  });

  it('names the integration and emits `audit.entry_recorded` for every row written', async () => {
    await put('/api/v1/settings/integrations/github', {
      syncIntervalMinutes: 15,
      token: GITHUB_TOKEN,
    });

    const emitted = await events();
    const updated = emitted.find((event) => event.type === 'setting.updated');
    expect(updated?.payload).toMatchObject({ category: 'integrations', integration: 'github' });
    expect(updated?.payload['changedKeys']).toEqual([
      'github_sync_interval_minutes',
      'github_token',
    ]);

    const recorded = emitted.filter((event) => event.type === 'audit.entry_recorded');
    expect(recorded.map((event) => event.payload['action']).sort()).toEqual([
      'secret_item.updated',
      'setting.updated',
    ]);
    // Every `audit.entry_recorded` names a row that exists — same transaction, no dangling id.
    const ids = new Set((await auditRows()).map((row) => row.id));
    for (const event of recorded) {
      expect(ids.has(String(event.payload['auditLogEntryId']))).toBe(true);
    }
  });

  it('rolls the audit row and the job back with a rejected write', async () => {
    // The registry writes `session_timeout_minutes` as a number; a body that fails validation
    // never reaches the transaction, so nothing at all is recorded.
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/security',
      headers: auth(),
      payload: { sessionTimeoutMinutes: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(await auditRows()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });
});

describe('test connection (§7.4)', () => {
  it('refuses before it is configured, and answers once it is', async () => {
    const unconfigured = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/github/test-connection',
      headers: auth(),
    });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json<{ error: { code: string } }>().error.code).toBe(
      'INTEGRATION_NOT_CONFIGURED',
    );

    await put('/api/v1/settings/integrations/github', { token: GITHUB_TOKEN });

    const configured = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/github/test-connection',
      headers: auth(),
    });
    expect(configured.statusCode).toBe(200);
    const result = configured.json<{ data: { ok: boolean; message: string } }>().data;
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Authenticated as cento007');
  });

  it('unseals the stored secret rather than any value from the request', async () => {
    await put('/api/v1/settings/integrations/telegram', {
      enabled: true,
      botToken: TELEGRAM_TOKEN,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/telegram/test-connection',
      headers: auth(),
    });

    // The stub echoes the request URL — which carries the bot token — into its body. The
    // result must still not contain it, because the executor redacts before returning.
    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain(TELEGRAM_TOKEN);
    expect(response.json<{ data: { ok: boolean } }>().data.ok).toBe(true);
  });

  it('refuses Obsidian until a vault path is saved', async () => {
    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/obsidian/test-connection',
      headers: auth(),
    });
    expect(before.statusCode).toBe(409);

    await put('/api/v1/settings/integrations/obsidian', { vaultPath: 'D:\\Vaults\\Engineering' });

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/obsidian/test-connection',
      headers: auth(),
    });
    expect(after.json<{ data: { ok: boolean } }>().data.ok).toBe(true);
  });

  it('reports an undecryptable secret as a failed check, not as a 500', async () => {
    await put('/api/v1/settings/integrations/github', { token: GITHUB_TOKEN });

    // Simulate the realistic disaster: a database restored next to a different
    // MC_ENCRYPTION_KEY. The row survives; this process cannot read it.
    await testDatabase()
      .db.update(schema.secretItems)
      .set({ ciphertext: Buffer.alloc(48, 7) })
      .where(eq(schema.secretItems.key, settingKey('integrations.github.token')));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/github/test-connection',
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const result = response.json<{ data: { ok: boolean; message: string; detail: unknown } }>()
      .data;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('MC_ENCRYPTION_KEY');
    expect(result.detail).toMatchObject({ reason: 'secret_unreadable', keyVersion: 1 });
  });

  it('refuses Qdrant and Ollama until an embedding model is saved, then answers both', async () => {
    // The embedding model is what makes memory configured at all (`memory/settings.ts`), and it
    // is the same key for both cards — the model is stamped onto the Qdrant collection, and it
    // is Ollama that has to be able to produce vectors with it. So neither is testable without
    // it, and "Mission Control declined to ask" is a refused request, not a failed check.
    for (const slug of ['qdrant', 'ollama']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/settings/integrations/${slug}/test-connection`,
        headers: auth(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'INTEGRATION_NOT_CONFIGURED',
      );
      expect(response.json<{ error: { message: string } }>().error.message).toContain(
        'embedding model',
      );
    }

    await put('/api/v1/settings/integrations/qdrant', { embeddingModel: EMBEDDING_MODEL });

    const qdrant = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/qdrant/test-connection',
      headers: auth(),
    });
    const ollama = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/ollama/test-connection',
      headers: auth(),
    });

    expect(qdrant.statusCode).toBe(200);
    expect(qdrant.json<{ data: { ok: boolean; message: string } }>().data).toMatchObject({
      ok: true,
      message: expect.stringContaining('3 points stamped nomic-embed-text (768d)'),
    });
    expect(ollama.statusCode).toBe(200);
    expect(ollama.json<{ data: { ok: boolean; message: string } }>().data).toMatchObject({
      ok: true,
      message: expect.stringContaining('768 dimensions'),
    });
  });

  it('unseals the Qdrant API key for the adapter and never lets it back out', async () => {
    await put('/api/v1/settings/integrations/qdrant', {
      embeddingModel: EMBEDDING_MODEL,
      apiKey: QDRANT_KEY,
    });

    // The stub echoes back the plaintext it was constructed with — which it can only have if the
    // key came out of `secret_items` through the vault. The response must still not contain it.
    qdrantAnswer = (apiKey) => ({
      kind: 'unreachable',
      reason: `connect ECONNREFUSED 127.0.0.1:6333 (api-key ${String(apiKey)})`,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/qdrant/test-connection',
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain(QDRANT_KEY);
    const result = response.json<{ data: { ok: boolean; message: string } }>().data;
    expect(result.ok).toBe(false);
    // Present-and-redacted, not merely absent: the key really did reach the adapter.
    expect(result.message).toContain('«redacted»');
    expect(result.message).toContain('Is the Qdrant service running?');
  });
});

describe('bootstrap settings (F8.2)', () => {
  it('offers no route that could read or write one', async () => {
    // The F8.2 set is env-only. There is no category for it, no key for it, and no path.
    for (const name of ['bootstrap', 'env', 'database', 'server']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/settings/${name}`,
        headers: auth(),
      });
      expect(response.statusCode).toBe(404);
    }

    const document = JSON.stringify(await get('/api/v1/settings'));
    for (const variable of ['DATABASE_URL', 'MC_ENCRYPTION_KEY', 'MC_DATA_DIR', 'MC_PORT']) {
      expect(document).not.toContain(variable);
    }
  });
});
