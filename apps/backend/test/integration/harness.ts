import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppConfig, loadConfig, newId, type PgBossQueue, schema } from '@mc/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type BuildAppOptions, type BuiltApp, buildAppWithServices } from '../../src/app.js';
import type { AuthService } from '../../src/auth/index.js';
import { bootstrapLocalUser } from '../../src/auth/index.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { createDenyingGithubHttp } from '../../src/github/http.js';
import { createBackendQueue } from '../../src/queue/index.js';
import type { SessionModule } from '../../src/sessions/index.js';

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
let currentQueue: PgBossQueue | null = null;
const queueErrors: Error[] = [];
const openApps: FastifyInstance[] = [];
const openRegistries: SessionModule['registry'][] = [];
const tempDirectories: string[] = [];

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
    maxConnections: 6,
  });
  return currentDatabase;
}

/**
 * The real pg-boss queue over this file's database.
 *
 * pg-boss's schema is already in the template (`global-setup.ts`), so `start()` here only has
 * to verify the version and provision the queue rows. Maintenance and cron are off, and the
 * polling floor drops to 500 ms so no test waits out a 2-second poll.
 *
 * The floor is what these tests actually rely on: TDS 03 §7.2 makes polling the delivery
 * guarantee and NOTIFY an optimization, and the launch consumer's real wake-up trigger — a
 * freed concurrency slot — has no NOTIFY at all (see `pollingOptions` in `pg-boss.ts`).
 */
export async function testQueue(): Promise<PgBossQueue> {
  if (currentQueue !== null) return currentQueue;

  const queue = createBackendQueue({
    connectionString: testDatabaseUrl(),
    pollingIntervalSeconds: 0.5,
    supervise: false,
    schedule: false,
    // A queue error that nothing surfaces is a silent test failure waiting to happen: the
    // worker loop reports fetch and handler failures through this channel and nowhere else.
    onError: (error) => {
      queueErrors.push(error);
    },
  });
  await queue.start();
  currentQueue = queue;
  return queue;
}

/** Errors the queue reported since the last `truncateAll()`. Asserted by queue-facing tests. */
export function reportedQueueErrors(): readonly Error[] {
  return queueErrors;
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

/**
 * Everything `buildAppWithServices` hands back — the Fastify instance plus the services a
 * test needs to reach into. Declared as the full `BuiltApp` rather than a hand-maintained
 * subset so a service added there is available here the moment it exists.
 */
export interface TestApp extends BuiltApp {
  readonly app: FastifyInstance;
  readonly auth: AuthService;
}

/** Build the real app over the per-file database. Closed automatically after the file. */
export function createTestApp(
  options: Omit<BuildAppOptions, 'db' | 'config'> & Partial<Pick<BuildAppOptions, 'db'>> = {},
): TestApp {
  const built = buildAppWithServices({
    config: testConfig(),
    logLevel: 'silent',
    db: options.db ?? testDatabase().db,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.agentRuntime === undefined ? {} : { agentRuntime: options.agentRuntime }),
    ...(options.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrentSessions: options.maxConcurrentSessions }),
    ...(options.spawnTimeoutMs === undefined ? {} : { spawnTimeoutMs: options.spawnTimeoutMs }),
    ...(options.disposeTimeoutMs === undefined
      ? {}
      : { disposeTimeoutMs: options.disposeTimeoutMs }),
    ...(options.cookieSecure === undefined ? {} : { cookieSecure: options.cookieSecure }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.loginRateLimiter === undefined
      ? {}
      : { loginRateLimiter: options.loginRateLimiter }),
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
    // Test Connection's network / filesystem / child-process edges (§7.4). Forwarded so an
    // integration test can exercise the settings routes end to end **without** an outbound
    // request: a suite that quietly reaches api.github.com is a suite that fails on a train.
    ...(options.testConnectionDeps === undefined
      ? {}
      : { testConnectionDeps: options.testConnectionDeps }),
    // The GitHub integration's one outbound edge (`github/http.ts`).
    //
    // **The default is a port that throws, not the real one.** Forwarding an override is not
    // enough on its own: the defect this guards against is precisely an override that is
    // accepted at the call site and never reaches the module, in which case the *real* port is
    // constructed and the suite quietly talks to api.github.com. With a denying default, a test
    // that forgot to inject fails locally and loudly, and `github.int.test.ts` asserts it.
    githubHttp: options.githubHttp ?? createDenyingGithubHttp('the integration harness'),
    ...(options.githubBaseUrl === undefined ? {} : { githubBaseUrl: options.githubBaseUrl }),
    ...(options.githubLimits === undefined ? {} : { githubLimits: options.githubLimits }),
  });

  openApps.push(built.app);
  openRegistries.push(built.sessions.registry);
  return built;
}

/** Release everything this file opened. Called from `setup.ts`'s `afterAll`. */
export async function closeTestResources(): Promise<void> {
  for (const registry of openRegistries.splice(0)) await registry.stop();
  for (const app of openApps.splice(0)) await app.close();
  if (currentQueue !== null) {
    await currentQueue.stop();
    currentQueue = null;
  }
  if (currentDatabase !== null) {
    await currentDatabase.close();
    currentDatabase = null;
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
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
    'messages',
    'session_events',
    'transcript_tail_states',
    'commits',
    'pull_requests',
    'sessions',
    'repositories',
    'projects',
    'workspaces',
    'notifications',
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
 * Drop every queued job without touching the queue definitions.
 *
 * A job left over from the previous case would be delivered to this one's consumer — exactly
 * the shared mutable state TDS 07 §11.3 lists as a designed-out flake vector. The
 * `pgboss.queue` rows survive: `testQueue()` provisions them once and re-creating them per case
 * would be pure cost.
 */
export async function truncateQueue(): Promise<void> {
  const exists = await testDatabase().db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
  );
  if (exists.rows[0]?.present !== true) return;
  await testDatabase().db.execute(sql.raw('TRUNCATE TABLE pgboss.job'));
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

/**
 * A `users` row for tests that need the FK target and nothing else.
 *
 * `seedUser()` goes through the real bootstrap path and pays for Argon2id (19 MiB, t=2) on
 * every call, which is exactly right when authentication is the thing under test and pure cost
 * when the Session domain is. The stored value is a fixed, obviously-inert placeholder that no
 * code path verifies against — it is not a credential and there is nothing to leak.
 */
export async function seedOperatorRow(username = 'operator'): Promise<string> {
  const id = newId();
  await testDatabase().db.insert(schema.users).values({
    id,
    username,
    passwordHash: 'not-a-credential:this-account-cannot-log-in',
  });
  return id;
}

/** Write a `settings` row directly — stands in for the settings service (TDS 04 §7). */
export async function setSecuritySetting(key: string, value: number): Promise<void> {
  await testDatabase()
    .db.insert(schema.settings)
    .values({ id: newId(), category: 'security', key, value, valueType: 'number' });
}

/**
 * Write any `settings` row directly, using the WS2 §7.6 storage coordinates.
 *
 * Same stand-in as `setSecuritySetting` above, generalised for the read models that consume
 * `general` / `integrations` / `notifications`. `valueType` is derived from the value so the
 * `ck_settings_value_matches_type` CHECK is satisfied by construction rather than by the
 * caller remembering.
 */
export async function setSetting(
  category: 'general' | 'integrations' | 'notifications' | 'memory' | 'agents' | 'security',
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
    .values({ id: newId(), category, key, value, valueType });
}

/**
 * A `secret_items` row with inert bytes.
 *
 * The read models only ever ask whether a secret **exists** (§7.1 `{ isSet }`), so the
 * ciphertext here is deliberately not a real sealed value — nothing decrypts it, and there is
 * no secret in this repository to leak.
 */
export async function setSecretPresent(
  category: 'general' | 'integrations' | 'notifications' | 'memory' | 'agents' | 'security',
  key: string,
): Promise<void> {
  await testDatabase()
    .db.insert(schema.secretItems)
    .values({
      id: newId(),
      category,
      key,
      // `ck_secret_items_ciphertext` requires > 16 bytes; `ck_secret_items_nonce` requires 12.
      ciphertext: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(12, 2),
    });
}

/** A `service_heartbeats` row (TDS 03 §4.4) at a chosen age — the Services health input. */
export async function seedHeartbeat(
  service: 'telegram_worker' | 'sync_worker',
  lastHeartbeatAt: Date,
): Promise<void> {
  await testDatabase()
    .db.insert(schema.serviceHeartbeats)
    .values({
      id: newId(),
      service,
      hostname: 'mc-test',
      pid: 4242,
      version: '0.0.0-test',
      stats: { jobsProcessed: 1, jobsFailed: 0 },
      startedAt: new Date(lastHeartbeatAt.getTime() - 60_000),
      lastHeartbeatAt,
    });
}

export interface SeedNotificationInput {
  readonly userId: string;
  readonly type?: string;
  readonly severity?: 'info' | 'warning' | 'error';
  readonly title?: string;
  readonly body?: string;
  readonly payload?: Record<string, unknown> | null;
  readonly correlationId?: string;
  readonly readAt?: Date;
  readonly telegramStatus?: 'skipped' | 'pending' | 'sent' | 'failed';
  readonly telegramSentAt?: Date;
  readonly telegramError?: string;
  readonly createdAt?: Date;
}

/**
 * Insert a Notification row directly.
 *
 * Creation is system-only (TDS 04 §8) and its producers are Phase 2, so there is no API path
 * a test could drive instead — this factory stands in for the Backend's threshold evaluation
 * and the Telegram Worker until they exist.
 */
export async function seedNotification(input: SeedNotificationInput): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.notifications)
    .values({
      id,
      userId: input.userId,
      type: input.type ?? 'session_completed',
      severity: input.severity ?? 'info',
      title: input.title ?? 'Session completed',
      body: input.body ?? '',
      payload: input.payload ?? null,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.readAt === undefined ? {} : { readAt: input.readAt }),
      telegramStatus: input.telegramStatus ?? 'skipped',
      ...(input.telegramSentAt === undefined ? {} : { telegramSentAt: input.telegramSentAt }),
      ...(input.telegramError === undefined ? {} : { telegramError: input.telegramError }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  return id;
}

/** A `sync_runs` row (TDS 03 §4.5) — the `obsidian_sync` schedule row's `lastRunAt` source. */
export async function seedSyncRun(input: {
  state?: 'queued' | 'running' | 'completed' | 'failed';
  completedAt?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.syncRuns)
    .values({
      id,
      kind: 'obsidian',
      state: input.state ?? 'completed',
      trigger: 'schedule',
      ...(input.completedAt === undefined || input.completedAt === null
        ? {}
        : { completedAt: input.completedAt }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  return id;
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

// ------------------------------------------------------------------- entity factories (§12)

/**
 * A real directory, because `POST /sessions` validates that `workingDirectory` exists (§6.2)
 * and F8.1 requires absolute native paths. Created under the OS temp root, never
 * repo-relative, and removed in teardown (TDS 07 §4).
 */
export function testWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mc-session-'));
  tempDirectories.push(directory);
  return directory;
}

export interface SeededProject {
  readonly workspaceId: string;
  readonly projectId: string;
}

export async function seedProject(name = 'Mission Control'): Promise<SeededProject> {
  const workspaceId = newId();
  const projectId = newId();
  const db = testDatabase().db;

  await db.insert(schema.workspaces).values({ id: workspaceId, name: 'Default' });
  await db.insert(schema.projects).values({ id: projectId, workspaceId, name });

  return { workspaceId, projectId };
}

export async function seedRepository(
  projectId: string,
  overrides: { localPath?: string; lastSyncedAt?: Date } = {},
): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.repositories)
    .values({
      id,
      projectId,
      name: 'mcs',
      localPath: overrides.localPath ?? testWorkingDirectory(),
      ...(overrides.lastSyncedAt === undefined ? {} : { lastSyncedAt: overrides.lastSyncedAt }),
    });
  return id;
}

export interface SeedSessionInput {
  readonly projectId: string;
  readonly userId: string;
  readonly state?: string;
  readonly sessionType?: 'managed' | 'observed';
  readonly repositoryId?: string;
  readonly runtimeSessionId?: string | null;
  readonly workingDir?: string;
  readonly title?: string | null;
  readonly resumedFromSessionId?: string;
  readonly lineageKind?: 'resumed' | 'cloned';
  readonly startedAt?: Date;
}

/**
 * Insert a Session row directly, bypassing the API.
 *
 * `state` is a parameter here **only** because a test has to stand a Session up in an
 * arbitrary F7 state without walking it there. Production code cannot do this — see the
 * single-writer rule in `sessions/index.ts` — and `state-machine.guard.test.ts` scans `src/`
 * only, so this factory cannot weaken it.
 */
export async function seedSession(input: SeedSessionInput): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.sessions)
    .values({
      id,
      projectId: input.projectId,
      userId: input.userId,
      sessionType: input.sessionType ?? 'managed',
      state: input.state ?? 'created',
      workingDir: input.workingDir ?? testWorkingDirectory(),
      title: input.title ?? null,
      runtimeSessionId: input.runtimeSessionId ?? null,
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      ...(input.resumedFromSessionId === undefined
        ? {}
        : { resumedFromSessionId: input.resumedFromSessionId }),
      ...(input.lineageKind === undefined ? {} : { lineageKind: input.lineageKind }),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    });
  return id;
}
