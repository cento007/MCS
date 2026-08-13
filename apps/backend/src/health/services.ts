import {
  type Db,
  HEARTBEAT_HEALTHY_MS,
  HEARTBEAT_STALE_MS,
  heartbeatStatus,
  type QueueDepth,
  type ServiceStatus,
  schema,
} from '@mc/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';

/**
 * `GET /api/v1/services/health` — the operator-facing read model behind Settings → Services
 * (TDS 04 §7.5, model in TDS 02 §7, PRD §4.4.7).
 *
 * **The rule this file is built around: a broken dependency is DATA, never an error.** The
 * panel exists to tell the operator which dependency is down; answering `500` because
 * PostgreSQL is unreachable would withhold exactly the fact the request was asking for. Every
 * probe is therefore bounded by a timeout and wrapped, and a failure becomes a row with
 * `status: 'down'` and the reason in `detail`.
 *
 * Status derivation (TDS 02 §7.1–§7.2):
 *
 *   | Service            | Method                              | Healthy means                   |
 *   |--------------------|-------------------------------------|---------------------------------|
 *   | Backend            | self-report                         | it answered                     |
 *   | PostgreSQL         | `SELECT 1` + latency on the pool    | reply < 250 ms                  |
 *   | Queue (PostgreSQL) | pg-boss depth/active/failed         | reachable, no retained failures |
 *   | Telegram Worker    | `service_heartbeats` row age        | < 90 s (F2.2 workers, Phase 2)  |
 *   | Sync Worker        | `service_heartbeats` row age        | < 90 s                          |
 *   | Qdrant / Ollama    | none                                | Phase 3+ placeholder            |
 *
 * **Vocabulary reconciliation.** TDS 02 §7.2's heartbeat bands are `healthy` / `stale` /
 * `down`; §7.5's response enum has no `stale`. WS5 §5.7.12 already arbitrated the mapping —
 * "`stale` (heartbeat older than 90 s) → `▲ degraded`, subtext 'last seen 2 m ago'" — so a
 * stale heartbeat is reported as `degraded` with the raw band echoed in
 * `meta.heartbeatStatus`. Neither document's vocabulary is bent.
 *
 * **No `services:health` WebSocket channel exists** (TDS 04 §14.3): health changes ride the
 * `settings` channel, and the Dashboard/Settings panels poll this endpoint on a 10 s interval
 * deliberately (WS5 §5.2 — "health must remain observable when the socket is the sick
 * component"). This module therefore publishes nothing.
 */

export const SERVICE_NAMES = [
  'backend',
  'postgresql',
  'queue',
  'telegram-worker',
  'sync-worker',
  'qdrant',
  'ollama',
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** TDS 04 §7.5. `disabled` is WS5's `◌ not configured / disabled`. */
/** Re-exported for local consumers; the single declaration lives in `@mc/shared` (F4.1). */
export type { ServiceStatus };

export interface ServiceHealthRow {
  readonly name: ServiceName;
  /** Per F2.1 the queue row reads "Queue (PostgreSQL)" — Redis does not exist here. */
  readonly label: string;
  readonly status: ServiceStatus;
  readonly checkedAt: string;
  readonly detail: string | null;
  readonly meta: Record<string, unknown> | null;
}

export interface ServiceHealthReadModel {
  readonly services: readonly ServiceHealthRow[];
}

/** TDS 02 §7.1: "reply < 250 ms". Slower is a working database worth complaining about. */
export const POSTGRES_SLOW_MS = 250;

/**
 * Per-probe ceiling. A hung dependency must not be able to hold the request open: one blocked
 * socket would otherwise take out the page whose entire job is to report that block.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/** TDS 02 §7.1: "cached ~5 s". The panel polls every 10 s (WS5 §5.2), so this mostly protects bursts. */
export const SERVICE_HEALTH_CACHE_MS = 5_000;

/**
 * Any retained failed job is a dead-letter signal (TDS 03 §7.3 failure mode 6) — pg-boss has
 * already exhausted the retry policy by the time a job reaches `failed`.
 */
const QUEUE_FAILED_ALERT_THRESHOLD = 1;

const LABELS: Readonly<Record<ServiceName, string>> = {
  backend: 'Backend',
  postgresql: 'PostgreSQL',
  queue: 'Queue (PostgreSQL)',
  'telegram-worker': 'Telegram Worker',
  'sync-worker': 'Sync Worker',
  qdrant: 'Qdrant',
  ollama: 'Ollama',
};

/** DB `service_heartbeats.service` values (TDS 03 §4.4) -> §7.5 service names. */
const HEARTBEAT_SERVICES: readonly { readonly row: string; readonly name: ServiceName }[] = [
  { row: 'telegram_worker', name: 'telegram-worker' },
  { row: 'sync_worker', name: 'sync-worker' },
];

// ------------------------------------------------------------------------------- probe ports

/**
 * The worker -> hub event relay's own health (`events/relay.ts`).
 *
 * Structurally typed rather than imported so `health/` keeps depending on shapes instead of on
 * `events/`; `EventRelayStatus` satisfies it.
 */
export interface EventRelayReport {
  readonly state: 'stopped' | 'connecting' | 'listening' | 'reconnecting';
  readonly channel: string;
  readonly listeningSince: string | null;
  readonly reconnects: number;
  readonly gaps: number;
  readonly relayed: number;
  readonly lastError: string | null;
}

export interface BackendSelfReport {
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly startedAt: string;
  readonly wsConnections: number;
  readonly activeSessions: number;
  readonly maxConcurrentSessions: number;
  /**
   * Absent when no relay is wired (an app built without a database URL, or a test). Present and
   * not `listening` is a real, operator-visible degradation — see `backendRow`.
   */
  readonly eventRelay?: EventRelayReport | undefined;
}

export interface DatabaseProbeResult {
  readonly latencyMs: number;
  readonly serverVersion: string | null;
}

export interface QueueProbeResult {
  readonly queues: readonly QueueDepth[];
  /** Age of the oldest ready job, or `null` when it could not be read (best-effort). */
  readonly oldestJobAgeSeconds: number | null;
}

export interface HeartbeatProbeRow {
  /** `service_heartbeats.service` — `telegram_worker` | `sync_worker`. */
  readonly service: string;
  readonly lastHeartbeatAt: Date;
  readonly startedAt: Date;
  readonly hostname: string;
  readonly pid: number;
  readonly version: string | null;
  readonly stats: Record<string, unknown> | null;
}

/**
 * The four checks, injected. Splitting them out is what lets the failure behaviour be unit
 * tested with no database: a probe that throws, and a probe that never settles, are both
 * two lines in a test.
 */
export interface ServiceHealthProbes {
  backend(): BackendSelfReport;
  database(): Promise<DatabaseProbeResult>;
  /** `null` means the configured driver reports no depth (the no-op queue). */
  queue(): Promise<QueueProbeResult | null>;
  heartbeats(): Promise<readonly HeartbeatProbeRow[]>;
}

export interface CollectServiceHealthOptions {
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

// -------------------------------------------------------------------------------- collection

/**
 * Run every check and render the §7.5 read model. Never throws: each probe is bounded and
 * its failure is reported in the row it belongs to.
 */
export async function collectServiceHealth(
  probes: ServiceHealthProbes,
  options: CollectServiceHealthOptions = {},
): Promise<ServiceHealthReadModel> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const [backend, database, queue, heartbeats] = await Promise.all([
    settle(async () => probes.backend(), timeoutMs),
    settle(() => probes.database(), timeoutMs),
    settle(() => probes.queue(), timeoutMs),
    settle(() => probes.heartbeats(), timeoutMs),
  ]);

  const checkedAt = now().toISOString();
  const services: ServiceHealthRow[] = [
    backendRow(backend, checkedAt),
    postgresRow(database, checkedAt),
    queueRow(queue, checkedAt),
    ...HEARTBEAT_SERVICES.map((service) =>
      workerRow(service.name, service.row, heartbeats, checkedAt, now()),
    ),
    placeholderRow('qdrant', checkedAt, 'Not configured — vector store arrives in Phase 3'),
    placeholderRow('ollama', checkedAt, 'Not configured — optional local runtime, Phase 3+'),
  ];

  return { services };
}

function backendRow(result: Settled<BackendSelfReport>, checkedAt: string): ServiceHealthRow {
  // TDS 02 §7.1: "always (it answered)". A self-report that throws is a bug in this file,
  // not a service outage, and it is reported rather than hidden.
  if (!result.ok) return row('backend', 'down', checkedAt, describe(result.error), null);

  const relay = result.value.eventRelay;

  // §7.1's "healthy means it answered" is not the whole truth once the Backend owns a
  // background connection whose failure is silent. A dead `LISTEN` looks exactly like a quiet
  // system: worker events — `sync.*`, `notification.sent/failed` — simply stop reaching the
  // browser, with nothing anywhere saying why. The same reasoning already applies to the
  // `down`-on-throw branch above: this row reports what is *known* about the Backend, and
  // "its worker event relay is not connected" is known and actionable.
  if (relay !== undefined && relay.state !== 'listening') {
    return row(
      'backend',
      'degraded',
      checkedAt,
      `Worker event relay is ${relay.state} — worker-produced events are not reaching browsers${
        relay.lastError === null ? '' : ` (${relay.lastError.slice(0, 200)})`
      }`,
      { ...result.value },
    );
  }

  return row('backend', 'healthy', checkedAt, null, { ...result.value });
}

function postgresRow(result: Settled<DatabaseProbeResult>, checkedAt: string): ServiceHealthRow {
  if (!result.ok) {
    return row('postgresql', 'down', checkedAt, describe(result.error), { latencyMs: null });
  }

  const { latencyMs, serverVersion } = result.value;
  const meta = { latencyMs, serverVersion };

  if (latencyMs >= POSTGRES_SLOW_MS) {
    return row(
      'postgresql',
      'degraded',
      checkedAt,
      `Responding slowly — ${latencyMs} ms (threshold ${POSTGRES_SLOW_MS} ms)`,
      meta,
    );
  }
  return row('postgresql', 'healthy', checkedAt, `${latencyMs} ms`, meta);
}

function queueRow(result: Settled<QueueProbeResult | null>, checkedAt: string): ServiceHealthRow {
  if (!result.ok) return row('queue', 'down', checkedAt, describe(result.error), null);

  if (result.value === null) {
    // The no-op queue (`app.ts` substitutes it when none is supplied): nothing is persisted,
    // so there is no depth to report and claiming `healthy` would be a fiction.
    return row('queue', 'unknown', checkedAt, 'Queue driver reports no depth (no-op queue)', null);
  }

  const { queues, oldestJobAgeSeconds } = result.value;
  const depth = queues.reduce((total, queue) => total + queue.ready + queue.active, 0);
  const failed = queues.reduce((total, queue) => total + queue.failed, 0);
  const meta = {
    depth,
    oldestJobAgeSeconds,
    failed,
    queues: queues.map((queue) => ({ ...queue })),
  };

  if (failed >= QUEUE_FAILED_ALERT_THRESHOLD) {
    return row(
      'queue',
      'degraded',
      checkedAt,
      `depth ${depth} · ${failed} failed job${failed === 1 ? '' : 's'} retained`,
      meta,
    );
  }
  return row('queue', 'healthy', checkedAt, `depth ${depth} · 0 failed jobs`, meta);
}

function workerRow(
  name: ServiceName,
  heartbeatService: string,
  result: Settled<readonly HeartbeatProbeRow[]>,
  checkedAt: string,
  now: Date,
): ServiceHealthRow {
  if (!result.ok) {
    // The failed check is the DATABASE, not the worker — reporting the worker `down` would
    // attribute an outage to the wrong service. `unknown` says what is actually known.
    return row(name, 'unknown', checkedAt, `Heartbeat unreadable: ${describe(result.error)}`, {
      lastHeartbeatAt: null,
    });
  }

  const heartbeat = result.value.find((entry) => entry.service === heartbeatService);
  if (heartbeat === undefined) {
    // TDS 02 §7.2 reads "down (older **or no row**)", but those are two different facts and
    // only one of them is a failure. Heartbeat rows are upserted and persist, so the absence
    // of a row means the worker has *never* run — not that it stopped. In Phase 1 the workers
    // do not exist yet, and reporting `down` would put two permanently red rows in the
    // Services panel and two permanent entries in WS5's Needs Attention widget, for an
    // install that is behaving exactly as designed. A panel that always shows failures is a
    // panel operators learn to ignore, which costs more than the fidelity it buys.
    //
    // `disabled` is the same reading already given to Qdrant and Ollama: specified, not
    // deployed yet. A worker that has *ever* reported has a row, so its later silence still
    // ages through `degraded` into `down` below — a real crash is still a real crash.
    return row(name, 'disabled', checkedAt, 'Not deployed — this worker ships in Phase 2', {
      lastHeartbeatAt: null,
      heartbeatStatus: 'never_reported',
    });
  }

  const ageMs = Math.max(0, now.getTime() - heartbeat.lastHeartbeatAt.getTime());
  const band = heartbeatStatus(ageMs);
  const meta = {
    lastHeartbeatAt: heartbeat.lastHeartbeatAt.toISOString(),
    ageSeconds: Math.floor(ageMs / 1000),
    heartbeatStatus: band,
    hostname: heartbeat.hostname,
    pid: heartbeat.pid,
    version: heartbeat.version,
    startedAt: heartbeat.startedAt.toISOString(),
    stats: heartbeat.stats,
    thresholds: { healthyMs: HEARTBEAT_HEALTHY_MS, staleMs: HEARTBEAT_STALE_MS },
  };

  // WS5 §5.7.12 vocabulary mapping: healthy -> healthy, stale -> degraded, down -> down.
  const status: ServiceStatus = HEARTBEAT_BAND_STATUS[band];
  return row(name, status, checkedAt, `Last heartbeat ${formatAge(ageMs)} ago`, meta);
}

/** The WS5 §5.7.12 mapping, as a table so it cannot drift into an inline conditional. */
const HEARTBEAT_BAND_STATUS: Readonly<Record<'healthy' | 'stale' | 'down', ServiceStatus>> = {
  healthy: 'healthy',
  stale: 'degraded',
  down: 'down',
};

function placeholderRow(name: ServiceName, checkedAt: string, detail: string): ServiceHealthRow {
  // §7.5: "qdrant/ollama report `disabled` until Phase 3+".
  return row(name, 'disabled', checkedAt, detail, null);
}

function row(
  name: ServiceName,
  status: ServiceStatus,
  checkedAt: string,
  detail: string | null,
  meta: Record<string, unknown> | null,
): ServiceHealthRow {
  return { name, label: LABELS[name], status, checkedAt, detail, meta };
}

// ------------------------------------------------------------------------- bounded execution

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Run one probe with a hard ceiling and never reject.
 *
 * The underlying promise is not cancelled — a `pg` query cannot be — but the row is produced
 * on time regardless, and the abandoned promise's rejection is swallowed here so it cannot
 * surface as an unhandled rejection later.
 */
async function settle<T>(run: () => Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const work = (async () => run())();
    work.catch(() => {
      /* handled below or abandoned by the timeout; never unhandled */
    });

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Check timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });

    return { ok: true, value: await Promise.race([work, timeout]) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 500);
  return 'Check failed';
}

function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ------------------------------------------------------------------------------ real probes

export interface QueueDepthProbe {
  depth(): Promise<QueueDepth[]>;
}

/** Duck-typed: the pg-boss driver reports depth (TDS 02 §7.1); the no-op queue does not. */
export function asQueueDepthProbe(queue: unknown): QueueDepthProbe | null {
  if (typeof queue !== 'object' || queue === null) return null;
  const candidate = queue as Partial<QueueDepthProbe>;
  return typeof candidate.depth === 'function' ? (candidate as QueueDepthProbe) : null;
}

export interface CreateServiceHealthProbesOptions {
  readonly db: Db;
  readonly queue?: unknown;
  readonly backend: () => BackendSelfReport;
}

export function createServiceHealthProbes(
  options: CreateServiceHealthProbesOptions,
): ServiceHealthProbes {
  const { db } = options;
  const queueProbe = asQueueDepthProbe(options.queue);

  return {
    backend: options.backend,

    async database(): Promise<DatabaseProbeResult> {
      const startedAt = Date.now();
      const result = await db.execute<{ server_version: string | null }>(
        sql`SELECT 1 AS ok, current_setting('server_version', true) AS server_version`,
      );
      return {
        latencyMs: Date.now() - startedAt,
        serverVersion: result.rows[0]?.server_version ?? null,
      };
    },

    async queue(): Promise<QueueProbeResult | null> {
      if (queueProbe === null) return null;
      const queues = await queueProbe.depth();
      return { queues, oldestJobAgeSeconds: await readOldestReadyJobAge(db) };
    },

    async heartbeats(): Promise<readonly HeartbeatProbeRow[]> {
      const rows = await db
        .select({
          service: schema.serviceHeartbeats.service,
          lastHeartbeatAt: schema.serviceHeartbeats.lastHeartbeatAt,
          startedAt: schema.serviceHeartbeats.startedAt,
          hostname: schema.serviceHeartbeats.hostname,
          pid: schema.serviceHeartbeats.pid,
          version: schema.serviceHeartbeats.version,
          stats: schema.serviceHeartbeats.stats,
        })
        .from(schema.serviceHeartbeats);

      return rows.map((row) => ({
        service: row.service,
        lastHeartbeatAt: row.lastHeartbeatAt,
        startedAt: row.startedAt,
        hostname: row.hostname,
        pid: row.pid,
        version: row.version,
        stats: (row.stats ?? null) as Record<string, unknown> | null,
      }));
    },
  };
}

/**
 * `meta.oldestJobAgeSeconds` (§7.5's own example). Best-effort and deliberately isolated: it
 * reads pg-boss's vendored table directly, so a schema change there must degrade the *detail*
 * rather than turn a healthy queue into a reported outage.
 */
async function readOldestReadyJobAge(db: Db): Promise<number | null> {
  try {
    const result = await db.execute<{ age_seconds: string | number | null }>(sql`
      SELECT CASE WHEN to_regclass('pgboss.job') IS NULL THEN NULL
                  ELSE (SELECT extract(epoch FROM now() - min(created_on))
                          FROM pgboss.job
                         WHERE state IN ('created', 'retry') AND start_after <= now())
             END AS age_seconds
    `);
    const value = result.rows[0]?.age_seconds;
    return value === null || value === undefined ? null : Math.max(0, Math.floor(Number(value)));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------ the service

export interface ServiceHealthServiceOptions {
  readonly probes: ServiceHealthProbes;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * The §7.5 read model with the TDS 02 §7.1 "~5 s" cache in front of it.
 *
 * The cache is per-process and in-memory (F3.3 — there is no shared cache tier in V1) and it
 * also collapses concurrent calls onto one in-flight collection, so the Dashboard's Services
 * widget and the Settings panel open at the same moment cost one round of probes, not two.
 */
export class ServiceHealthService {
  readonly #probes: ServiceHealthProbes;
  readonly #cacheMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  #cached: { at: number; model: ServiceHealthReadModel } | null = null;
  #inFlight: Promise<ServiceHealthReadModel> | null = null;

  constructor(options: ServiceHealthServiceOptions) {
    this.#probes = options.probes;
    this.#cacheMs = options.cacheMs ?? SERVICE_HEALTH_CACHE_MS;
    this.#timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
  }

  async read(): Promise<ServiceHealthReadModel> {
    const now = this.#now().getTime();
    if (this.#cached !== null && now - this.#cached.at < this.#cacheMs) return this.#cached.model;
    if (this.#inFlight !== null) return this.#inFlight;

    const collection = collectServiceHealth(this.#probes, {
      now: this.#now,
      timeoutMs: this.#timeoutMs,
    })
      .then((model) => {
        this.#cached = { at: this.#now().getTime(), model };
        return model;
      })
      .finally(() => {
        this.#inFlight = null;
      });

    this.#inFlight = collection;
    return collection;
  }
}

export interface RegisterServiceHealthOptions extends ServiceHealthServiceOptions {}

export function registerServiceHealthRoutes(
  app: FastifyInstance,
  options: RegisterServiceHealthOptions,
): ServiceHealthService {
  const service = new ServiceHealthService(options);

  // Authenticated by default (TDS 04 §1.4) — this is operator observability, and the
  // dependency-free liveness probe next door (`GET /api/v1/health`) is the public one.
  app.get('/api/v1/services/health', async () => dataEnvelope(await service.read()));

  return service;
}
