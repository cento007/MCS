import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppConfig, loadConfig, newId, schema } from '@mc/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type BuildAppOptions, buildAppWithServices } from '../../src/app.js';
import type { AuthService } from '../../src/auth/index.js';
import { bootstrapLocalUser } from '../../src/auth/index.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/index.js';

/**
 * Integration test support layer (TDS 07 §3.1, §12).
 *
 * Everything a `*.int.test.ts` file needs to reach a real, migrated, private database and a
 * real Fastify app: the per-file database created by `setup.ts`, an app built over it, table
 * truncation between cases, and the few factories the auth tier uses.
 *
 * Two rules this file exists to keep:
 *   - **Tests never write or modify `.env`** (TDS 07 §3): bootstrap config is injected
 *     through the real loader with `skipEnvFile: true`, so a developer's root `.env` is
 *     irrelevant to a test run.
 *   - **No secrets in tests**: the `MC_ENCRYPTION_KEY` used here is generated per run.
 */

let currentDatabaseUrl: string | null = null;
let currentDatabase: DatabaseHandle | null = null;
let currentDataDir: string | null = null;
const openApps: FastifyInstance[] = [];

/** Called by `setup.ts` once the per-file clone exists. */
export function setTestDatabaseUrl(url: string): void {
  currentDatabaseUrl = url;
}

export function testDatabaseUrl(): string {
  if (currentDatabaseUrl === null) {
    throw new Error('No test database — is this file running under the integration config?');
  }
  return currentDatabaseUrl;
}

/** The shared pool for this test file. Created lazily, closed by `setup.ts`. */
export function testDatabase(): DatabaseHandle {
  currentDatabase ??= createDatabase({
    connectionString: testDatabaseUrl(),
    maxConnections: 4,
  });
  return currentDatabase;
}

/**
 * Bootstrap config for a test app. Built through the real loader (`skipEnvFile: true`) so the
 * production code path is the one under test, with a per-run encryption key and a temp
 * `MC_DATA_DIR`.
 */
export function testConfig(): AppConfig {
  currentDataDir ??= mkdtempSync(join(tmpdir(), 'mc-int-'));

  return loadConfig({
    skipEnvFile: true,
    env: {
      DATABASE_URL: testDatabaseUrl(),
      MC_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      MC_DATA_DIR: currentDataDir,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    },
  });
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly auth: AuthService;
}

/** Build the real app over the per-file database. Closed automatically after the file. */
export function createTestApp(
  options: Omit<BuildAppOptions, 'db' | 'config'> & Partial<Pick<BuildAppOptions, 'db'>> = {},
): TestApp {
  const { app, auth } = buildAppWithServices({
    config: testConfig(),
    logLevel: 'silent',
    db: options.db ?? testDatabase().db,
    ...(options.cookieSecure === undefined ? {} : { cookieSecure: options.cookieSecure }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.loginRateLimiter === undefined
      ? {}
      : { loginRateLimiter: options.loginRateLimiter }),
  });

  openApps.push(app);
  return { app, auth };
}

/** Release everything this file opened. Called from `setup.ts`'s `afterAll`. */
export async function closeTestResources(): Promise<void> {
  for (const app of openApps.splice(0)) await app.close();
  if (currentDatabase !== null) {
    await currentDatabase.close();
    currentDatabase = null;
  }
  if (currentDataDir !== null) {
    rmSync(currentDataDir, { recursive: true, force: true });
    currentDataDir = null;
  }
}

/**
 * Per-test reset (TDS 07 §3.1: fresh template copy per file, truncation per case).
 * `RESTART IDENTITY CASCADE` over the app tables; the migration journal is left alone.
 */
export async function truncateAll(): Promise<void> {
  const tables = [
    'audit_log_entries',
    'api_tokens',
    'auth_sessions',
    'users',
    'settings',
    'secret_items',
  ];
  const list = tables.map((name) => `public."${name}"`).join(', ');
  await testDatabase().db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
}

export interface SeededUser {
  readonly id: string;
  readonly username: string;
  readonly password: string;
}

/** The single local account, created through the real bootstrap path (F4.1). */
export async function seedUser(
  overrides: { username?: string; password?: string } = {},
): Promise<SeededUser> {
  const username = overrides.username ?? 'operator';
  // Not a secret: a per-call random passphrase for a database that lives for one test file.
  const password = overrides.password ?? `pw-${randomBytes(12).toString('hex')}`;

  const result = await bootstrapLocalUser(testDatabase().db, { username, password });
  return { id: result.userId, username, password };
}

/** Write a `settings` row directly — stands in for the settings service (TDS 04 §7). */
export async function setSecuritySetting(key: string, value: number): Promise<void> {
  await testDatabase()
    .db.insert(schema.settings)
    .values({ id: newId(), category: 'security', key, value, valueType: 'number' });
}

/** Extract a cookie value from a `Set-Cookie` header. Throws when the cookie is absent. */
export function cookieValueFrom(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];

  for (const header of headers) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`No ${name} cookie in Set-Cookie: ${JSON.stringify(headers)}`);
}
