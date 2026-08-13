import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerHttpConventions } from '../http/index.js';
import {
  type BackendSelfReport,
  collectServiceHealth,
  type HeartbeatProbeRow,
  registerServiceHealthRoutes,
  type ServiceHealthProbes,
  type ServiceHealthReadModel,
  type ServiceHealthRow,
  ServiceHealthService,
} from './services.js';

/**
 * `GET /api/v1/services/health` (TDS 04 §7.5) — the derivation and, crucially, the failure
 * behaviour. No database: every probe is injected, which is the whole reason `ServiceHealthProbes`
 * exists as a port.
 *
 * The property under test throughout: **a broken dependency is a reported `down`, never a
 * thrown error.** A panel that 500s when PostgreSQL is unreachable withholds exactly the fact
 * the operator opened it to find.
 */

const NOW = new Date('2026-08-12T12:00:00.000Z');

const BACKEND: BackendSelfReport = {
  version: '0.1.0',
  uptimeSeconds: 4242,
  startedAt: '2026-08-12T10:49:18.000Z',
  wsConnections: 2,
  activeSessions: 1,
  maxConcurrentSessions: 3,
};

function heartbeat(service: string, ageMs: number): HeartbeatProbeRow {
  return {
    service,
    lastHeartbeatAt: new Date(NOW.getTime() - ageMs),
    startedAt: new Date(NOW.getTime() - 86_400_000),
    hostname: 'mc-dev',
    pid: 4242,
    version: '0.1.0',
    stats: { jobsProcessed: 12, jobsFailed: 0 },
  };
}

function probes(overrides: Partial<ServiceHealthProbes> = {}): ServiceHealthProbes {
  return {
    backend: () => BACKEND,
    database: async () => ({ latencyMs: 4, serverVersion: '16.3' }),
    queue: async () => ({
      queues: [{ queue: 'events', ready: 2, active: 0, failed: 0 }],
      oldestJobAgeSeconds: 7,
    }),
    heartbeats: async () => [],
    ...overrides,
  };
}

async function collect(
  overrides: Partial<ServiceHealthProbes> = {},
): Promise<ServiceHealthReadModel> {
  return collectServiceHealth(probes(overrides), { now: () => NOW, timeoutMs: 50 });
}

function rowOf(model: ServiceHealthReadModel, name: string): ServiceHealthRow {
  const row = model.services.find((service) => service.name === name);
  if (row === undefined) throw new Error(`No health row for ${name}`);
  return row;
}

describe('service list and shape (§7.5)', () => {
  it('returns every contract service, in contract order, with the F2.1 queue label', async () => {
    const model = await collect();

    expect(model.services.map((service) => service.name)).toEqual([
      'backend',
      'postgresql',
      'queue',
      'telegram-worker',
      'sync-worker',
      'qdrant',
      'ollama',
    ]);
    // Per F2.1 the queue row reads "Queue (PostgreSQL)" — Redis does not exist in this system.
    expect(rowOf(model, 'queue').label).toBe('Queue (PostgreSQL)');
  });

  it('gives every row the §7.5 keys and an ISO 8601 UTC checkedAt', async () => {
    const model = await collect();

    for (const service of model.services) {
      expect(Object.keys(service).sort()).toEqual([
        'checkedAt',
        'detail',
        'label',
        'meta',
        'name',
        'status',
      ]);
      expect(service.checkedAt).toBe(NOW.toISOString());
    }
  });

  it('reports Qdrant and Ollama as disabled when the memory probes are not wired', async () => {
    const model = await collect();

    expect(rowOf(model, 'qdrant').status).toBe('disabled');
    expect(rowOf(model, 'ollama').status).toBe('disabled');
  });
});

/**
 * The Phase 3 memory rows.
 *
 * `memory/health.ts` owns the *classification* (down vs degraded vs disabled — it needs the
 * memory layer's vocabulary to tell "the model is a chat model" from "the collection's stamp
 * disagrees"). What this file still owns, and what these tests cover, is the same thing it owns
 * for every other dependency: the bound, and the guarantee that a probe which throws or stalls
 * becomes a row rather than taking out the page.
 */
describe('the memory rows (Phase 3)', () => {
  it('renders whatever the memory probes classified', async () => {
    const model = await collect({
      qdrant: async () => ({
        status: 'healthy',
        detail: '42 points, stamped nomic-embed-text (768d)',
        meta: { collection: 'mc_memory', pointCount: 42 },
      }),
      ollama: async () => ({
        status: 'down',
        detail: 'Ollama has no model named "nomic-embed-text"',
        meta: { reason: 'model_missing' },
      }),
    });

    expect(rowOf(model, 'qdrant')).toMatchObject({
      status: 'healthy',
      label: 'Qdrant',
      detail: '42 points, stamped nomic-embed-text (768d)',
      meta: { pointCount: 42 },
    });
    expect(rowOf(model, 'ollama')).toMatchObject({
      status: 'down',
      meta: { reason: 'model_missing' },
    });
  });

  it('turns a memory probe that throws into a row, not a failed request', async () => {
    const model = await collect({
      qdrant: () => Promise.reject(new Error('the probe itself is broken')),
    });

    // `unknown`, not `down`: what failed is the *check*, and blaming Qdrant for a bug in this
    // process would send the operator to the wrong machine.
    expect(rowOf(model, 'qdrant')).toMatchObject({ status: 'unknown' });
    expect(rowOf(model, 'qdrant').detail).toContain('the probe itself is broken');
    // And the rest of the page is unaffected.
    expect(rowOf(model, 'postgresql').status).toBe('healthy');
  });

  it('bounds a memory probe that never settles', async () => {
    const model = await collect({
      qdrant: () => new Promise(() => undefined),
    });

    expect(rowOf(model, 'qdrant')).toMatchObject({ status: 'unknown' });
    expect(rowOf(model, 'qdrant').detail).toContain('timed out');
    expect(rowOf(model, 'backend').status).toBe('healthy');
  });

  it('self-reports the Backend with uptime, WS clients and session slots (TDS 02 §7.1)', async () => {
    const model = await collect();
    const backend = rowOf(model, 'backend');

    expect(backend.status).toBe('healthy');
    expect(backend.meta).toMatchObject({
      version: '0.1.0',
      uptimeSeconds: 4242,
      wsConnections: 2,
      activeSessions: 1,
      maxConcurrentSessions: 3,
    });
  });
});

/**
 * The worker -> hub event relay (TDS 04 §15.1) has no probe of its own: its failure is the
 * *absence* of events, which no check can observe. It is therefore reported by the Backend's own
 * row, and this is the test that keeps it visible.
 */
describe('event relay visibility', () => {
  const relay = {
    state: 'listening' as const,
    channel: 'mc_events',
    listeningSince: '2026-08-12T11:00:00.000Z',
    reconnects: 0,
    gaps: 0,
    relayed: 17,
    lastError: null,
  };

  it('stays healthy while the relay is listening, and shows its counters', async () => {
    const row = rowOf(
      await collect({ backend: () => ({ ...BACKEND, eventRelay: relay }) }),
      'backend',
    );

    expect(row.status).toBe('healthy');
    expect(row.meta).toMatchObject({ eventRelay: { state: 'listening', relayed: 17 } });
  });

  it('reports degraded — with the reason — when the relay is not connected', async () => {
    const row = rowOf(
      await collect({
        backend: () => ({
          ...BACKEND,
          eventRelay: {
            ...relay,
            state: 'reconnecting' as const,
            listeningSince: null,
            reconnects: 3,
            lastError: 'connection terminated unexpectedly',
          },
        }),
      }),
      'backend',
    );

    // The operator-facing point: "worker events are not reaching browsers" must be readable in
    // the Services panel, not inferred from a sync row that stopped updating.
    expect(row.status).toBe('degraded');
    expect(row.detail).toContain('reconnecting');
    expect(row.detail).toContain('connection terminated unexpectedly');
  });

  it('stays healthy when no relay is wired at all', async () => {
    // An app built with no database URL (or a test) has no relay; absence is not degradation.
    expect(rowOf(await collect(), 'backend').status).toBe('healthy');
  });
});

describe('PostgreSQL check', () => {
  it('is healthy under the 250 ms threshold and carries the latency', async () => {
    const row = rowOf(await collect(), 'postgresql');

    expect(row.status).toBe('healthy');
    expect(row.meta).toMatchObject({ latencyMs: 4, serverVersion: '16.3' });
  });

  it('is degraded at or over 250 ms — a working database worth complaining about', async () => {
    const row = rowOf(
      await collect({ database: async () => ({ latencyMs: 250, serverVersion: '16.3' }) }),
      'postgresql',
    );

    expect(row.status).toBe('degraded');
    expect(row.detail).toContain('250 ms');
  });

  it('reports a failed check as down instead of throwing', async () => {
    const model = await collect({
      database: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432');
      },
    });

    const row = rowOf(model, 'postgresql');
    expect(row.status).toBe('down');
    expect(row.detail).toContain('ECONNREFUSED');
  });

  it('bounds a hung check so one stuck dependency cannot hang the endpoint', async () => {
    const model = await collect({
      // Never settles. Without the per-probe ceiling this test would time out.
      database: () => new Promise(() => undefined),
    });

    const row = rowOf(model, 'postgresql');
    expect(row.status).toBe('down');
    expect(row.detail).toContain('timed out');
  });

  it('does not let one broken dependency take the other rows with it', async () => {
    const model = await collect({
      database: async () => {
        throw new Error('down');
      },
    });

    expect(rowOf(model, 'postgresql').status).toBe('down');
    expect(rowOf(model, 'queue').status).toBe('healthy');
    expect(rowOf(model, 'backend').status).toBe('healthy');
  });
});

describe('queue check', () => {
  it('is healthy with no retained failures and reports depth + oldest job age', async () => {
    const row = rowOf(await collect(), 'queue');

    expect(row.status).toBe('healthy');
    expect(row.meta).toMatchObject({ depth: 2, failed: 0, oldestJobAgeSeconds: 7 });
  });

  it('sums ready and active across queues for the reported depth', async () => {
    const row = rowOf(
      await collect({
        queue: async () => ({
          queues: [
            { queue: 'events', ready: 2, active: 1, failed: 0 },
            { queue: 'session.launch', ready: 3, active: 0, failed: 0 },
          ],
          oldestJobAgeSeconds: null,
        }),
      }),
      'queue',
    );

    expect(row.meta).toMatchObject({ depth: 6, failed: 0 });
  });

  it('is degraded when a failed job is retained — pg-boss has already exhausted its retries', async () => {
    const row = rowOf(
      await collect({
        queue: async () => ({
          queues: [{ queue: 'events', ready: 0, active: 0, failed: 1 }],
          oldestJobAgeSeconds: null,
        }),
      }),
      'queue',
    );

    expect(row.status).toBe('degraded');
    expect(row.detail).toContain('1 failed job');
  });

  it('is unknown — not healthy — when the driver reports no depth (the no-op queue)', async () => {
    const row = rowOf(await collect({ queue: async () => null }), 'queue');

    expect(row.status).toBe('unknown');
    expect(row.detail).toContain('no-op queue');
  });

  it('reports an unreachable queue as down', async () => {
    const row = rowOf(
      await collect({
        queue: async () => {
          throw new Error('relation "pgboss.job" does not exist');
        },
      }),
      'queue',
    );

    expect(row.status).toBe('down');
  });
});

describe('worker heartbeats (TDS 02 §7.2 bands, WS5 §5.7.12 vocabulary)', () => {
  it('is healthy for a fresh heartbeat (< 90 s)', async () => {
    const row = rowOf(
      await collect({ heartbeats: async () => [heartbeat('telegram_worker', 30_000)] }),
      'telegram-worker',
    );

    expect(row.status).toBe('healthy');
    expect(row.detail).toBe('Last heartbeat 30s ago');
    expect(row.meta).toMatchObject({
      heartbeatStatus: 'healthy',
      ageSeconds: 30,
      lastHeartbeatAt: new Date(NOW.getTime() - 30_000).toISOString(),
      hostname: 'mc-dev',
      version: '0.1.0',
    });
  });

  it('maps a stale heartbeat (90 s – 5 min) to degraded, keeping the raw band in meta', async () => {
    const row = rowOf(
      await collect({ heartbeats: async () => [heartbeat('sync_worker', 134_000)] }),
      'sync-worker',
    );

    // WS5 §5.7.12: "`stale` (heartbeat older than 90 s) → `▲ degraded`, subtext 'last seen 2 m ago'".
    expect(row.status).toBe('degraded');
    expect(row.meta).toMatchObject({ heartbeatStatus: 'stale' });
    expect(row.detail).toBe('Last heartbeat 2m 14s ago');
  });

  it('treats exactly 90 s as stale and exactly 5 min as down (band edges)', async () => {
    const stale = rowOf(
      await collect({ heartbeats: async () => [heartbeat('sync_worker', 90_000)] }),
      'sync-worker',
    );
    const down = rowOf(
      await collect({ heartbeats: async () => [heartbeat('sync_worker', 300_000)] }),
      'sync-worker',
    );

    expect(stale.status).toBe('degraded');
    expect(down.status).toBe('down');
  });

  it('reports a worker that has never run as disabled, not down', async () => {
    // Heartbeat rows are upserted and persist, so no row means the worker has never started
    // — it has not *stopped*. In Phase 1 both workers are unbuilt, and reporting `down` would
    // leave two permanently red rows in the Services panel and two standing entries in the
    // Needs Attention widget for an install behaving exactly as designed. A panel that always
    // shows failures is one operators stop reading.
    const row = rowOf(await collect({ heartbeats: async () => [] }), 'telegram-worker');

    expect(row.status).toBe('disabled');
    expect(row.detail).toBe('Not deployed — this worker ships in Phase 2');
    expect(row.meta).toMatchObject({ lastHeartbeatAt: null, heartbeatStatus: 'never_reported' });
  });

  it('still reports a worker that once ran and went silent as down', async () => {
    // The distinction that makes the case above safe: a crash leaves a row behind, and that
    // row ages through `degraded` into `down`. Never-ran and stopped-running stay separable.
    const row = rowOf(
      await collect({ heartbeats: async () => [heartbeat('telegram_worker', 600_000)] }),
      'telegram-worker',
    );

    expect(row.status).toBe('down');
  });

  it('reports unknown — not down — when the heartbeat read itself fails', async () => {
    // The failed check is the DATABASE, not the worker: claiming the worker is down would
    // attribute the outage to the wrong service.
    const model = await collect({
      heartbeats: async () => {
        throw new Error('connection terminated');
      },
    });

    expect(rowOf(model, 'telegram-worker').status).toBe('unknown');
    expect(rowOf(model, 'sync-worker').status).toBe('unknown');
    expect(rowOf(model, 'telegram-worker').detail).toContain('Heartbeat unreadable');
  });

  it('keys each worker row to its own heartbeat row', async () => {
    const model = await collect({
      heartbeats: async () => [heartbeat('telegram_worker', 10_000)],
    });

    // One worker reporting must not vouch for the other: telegram has a fresh row, sync has
    // none at all, and they land on different statuses.
    expect(rowOf(model, 'telegram-worker').status).toBe('healthy');
    expect(rowOf(model, 'sync-worker').status).toBe('disabled');
  });
});

describe('ServiceHealthService caching (TDS 02 §7.1 "cached ~5 s")', () => {
  it('serves a cached snapshot inside the TTL and re-probes after it', async () => {
    const database = vi.fn(async () => ({ latencyMs: 1, serverVersion: '16.3' }));
    let clock = NOW.getTime();

    const service = new ServiceHealthService({
      probes: probes({ database }),
      cacheMs: 5_000,
      now: () => new Date(clock),
    });

    await service.read();
    await service.read();
    expect(database).toHaveBeenCalledTimes(1);

    clock += 5_001;
    await service.read();
    expect(database).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent reads onto one round of probes', async () => {
    const database = vi.fn(async () => ({ latencyMs: 1, serverVersion: '16.3' }));
    const service = new ServiceHealthService({ probes: probes({ database }), now: () => NOW });

    await Promise.all([service.read(), service.read(), service.read()]);

    expect(database).toHaveBeenCalledTimes(1);
  });
});

describe('the route (§7.5)', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  /** Routes only — no auth guard, no database. The guard is covered by the integration tier. */
  function buildRouteApp(overrides: Partial<ServiceHealthProbes> = {}): FastifyInstance {
    const instance = Fastify({ logger: false });
    registerHttpConventions(instance);
    registerServiceHealthRoutes(instance, { probes: probes(overrides), timeoutMs: 50 });
    return instance;
  }

  it('answers 200 with `{ data: { services } }` and no meta', async () => {
    app = buildRouteApp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/services/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: ServiceHealthReadModel }>();
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.services).toHaveLength(7);
  });

  it('answers 200 with `down` when every dependency is broken — never 500', async () => {
    app = buildRouteApp({
      database: async () => {
        throw new Error('ECONNREFUSED');
      },
      queue: async () => {
        throw new Error('ECONNREFUSED');
      },
      heartbeats: () => new Promise(() => undefined),
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/services/health' });

    expect(response.statusCode).toBe(200);
    const services = response.json<{ data: ServiceHealthReadModel }>().data.services;
    expect(services.find((service) => service.name === 'postgresql')?.status).toBe('down');
    expect(services.find((service) => service.name === 'queue')?.status).toBe('down');
    expect(services.find((service) => service.name === 'sync-worker')?.status).toBe('unknown');
  });
});
