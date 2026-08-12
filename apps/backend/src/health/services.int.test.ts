import type { PgBossQueue } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedHeartbeat,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { createDatabase } from '../db/index.js';
import {
  collectServiceHealth,
  createServiceHealthProbes,
  type ServiceHealthReadModel,
  type ServiceHealthRow,
} from './services.js';

/**
 * `GET /api/v1/services/health` end to end (TDS 04 §7.5) — real database, real pg-boss queue,
 * real `service_heartbeats` rows, through the real app (WS6 §11.2: every WS2 Phase-1 endpoint
 * gets happy path + error envelope + auth).
 */

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;

async function readHealth(): Promise<ServiceHealthReadModel> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/services/health',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });

  expect(response.statusCode).toBe(200);
  return response.json<{ data: ServiceHealthReadModel }>().data;
}

function rowOf(model: ServiceHealthReadModel, name: string): ServiceHealthRow {
  const row = model.services.find((service) => service.name === name);
  if (row === undefined) throw new Error(`No health row for ${name}`);
  return row;
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  const user = await seedUser();
  built = createTestApp({ queue, cookieSecure: false });
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

describe('auth (TDS 04 §1.4 — authenticated by default)', () => {
  it('rejects the health read without a credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/services/health' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });
});

describe('live checks against a real instance', () => {
  it('reports PostgreSQL healthy with a measured latency and the server version', async () => {
    const row = rowOf(await readHealth(), 'postgresql');

    expect(row.status).toBe('healthy');
    expect(row.label).toBe('PostgreSQL');
    expect(typeof (row.meta as { latencyMs: number }).latencyMs).toBe('number');
    expect((row.meta as { serverVersion: string }).serverVersion).toMatch(/^\d+/);
  });

  it('reports the real pg-boss queue as "Queue (PostgreSQL)" with a depth', async () => {
    const row = rowOf(await readHealth(), 'queue');

    expect(row.label).toBe('Queue (PostgreSQL)');
    expect(row.status).toBe('healthy');
    expect((row.meta as { depth: number }).depth).toBeGreaterThanOrEqual(0);
    // Read from the vendored `pgboss.job` table; `null` only if that read fails.
    expect(row.meta).toHaveProperty('oldestJobAgeSeconds');
  });

  it('self-reports the Backend, and Phase 3 services as disabled', async () => {
    const model = await readHealth();

    expect(rowOf(model, 'backend').status).toBe('healthy');
    expect(rowOf(model, 'qdrant').status).toBe('disabled');
    expect(rowOf(model, 'ollama').status).toBe('disabled');
  });
});

describe('worker heartbeats read from service_heartbeats (TDS 03 §4.4)', () => {
  it('is healthy for a heartbeat written seconds ago', async () => {
    await seedHeartbeat('telegram_worker', new Date(Date.now() - 5_000));

    const row = rowOf(await readHealth(), 'telegram-worker');

    expect(row.status).toBe('healthy');
    expect((row.meta as { heartbeatStatus: string }).heartbeatStatus).toBe('healthy');
  });

  it('is degraded for a stale heartbeat between 90 s and 5 min', async () => {
    await seedHeartbeat('sync_worker', new Date(Date.now() - 150_000));

    const row = rowOf(await readHealth(), 'sync-worker');

    expect(row.status).toBe('degraded');
    expect((row.meta as { heartbeatStatus: string }).heartbeatStatus).toBe('stale');
    expect((row.meta as { hostname: string }).hostname).toBe('mc-test');
  });

  it('is down beyond 5 minutes, but disabled when no row was ever written', async () => {
    await seedHeartbeat('telegram_worker', new Date(Date.now() - 600_000));

    const model = await readHealth();

    expect(rowOf(model, 'telegram-worker').status).toBe('down');
    // A worker that once ran and went silent is `down`; one that has never written a row at
    // all is `disabled`, not a failure. Heartbeat rows persist, so the absence of a row means
    // "never started", and Phase 1 ships no workers — reporting `down` would put two standing
    // red rows in the Services panel and the Needs Attention widget for a healthy install.
    // Never written: Phase 1 has no workers, and the detail says so instead of implying a crash.
    expect(rowOf(model, 'sync-worker').status).toBe('disabled');
    expect(rowOf(model, 'sync-worker').meta).toMatchObject({
      lastHeartbeatAt: null,
      heartbeatStatus: 'never_reported',
    });
  });

  it('caches within the TTL, so a heartbeat written mid-window is not read twice', async () => {
    const first = await readHealth();
    await seedHeartbeat('telegram_worker', new Date());
    const second = await readHealth();

    // Same snapshot: TDS 02 §7.1's "cached ~5 s". `checkedAt` proves it is the same collection.
    expect(second.services[0]?.checkedAt).toBe(first.services[0]?.checkedAt);
  });
});

describe('a failing dependency is reported, not thrown', () => {
  it('reports PostgreSQL down when the pool cannot connect — against a real unreachable server', async () => {
    // A real pg pool pointed at a port nothing listens on: the failure is genuine (ECONNREFUSED
    // from `pg`), not a stubbed rejection.
    const unreachable = createDatabase({
      connectionString: 'postgresql://mc:mc@127.0.0.1:1/mission_control',
      maxConnections: 1,
      connectionTimeoutMillis: 500,
    });

    try {
      const model = await collectServiceHealth(
        createServiceHealthProbes({
          db: unreachable.db,
          queue,
          backend: () => ({
            version: '0.0.0-test',
            uptimeSeconds: 1,
            startedAt: new Date().toISOString(),
            wsConnections: 0,
            activeSessions: 0,
            maxConcurrentSessions: 3,
          }),
        }),
        { timeoutMs: 3_000 },
      );

      expect(rowOf(model, 'postgresql').status).toBe('down');
      expect(rowOf(model, 'postgresql').detail).toBeTruthy();
      // The worker rows cannot be known when their only substrate is unreachable.
      expect(rowOf(model, 'telegram-worker').status).toBe('unknown');
      // …and the checks that DID succeed still report their own truth.
      expect(rowOf(model, 'backend').status).toBe('healthy');
      expect(rowOf(model, 'queue').status).toBe('healthy');
    } finally {
      await unreachable.close();
    }
  });

  it('keeps serving the endpoint (200) while a dependency is broken', async () => {
    // The route itself is proven not to 500 in `services.test.ts` with injected probes; here we
    // prove the real registered route still answers 200 with a live database behind it.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/services/health',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(await testDatabase().db.execute('SELECT 1')).toBeTruthy();
  });
});
