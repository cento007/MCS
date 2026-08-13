import {
  type AppConfig,
  createNoopQueue,
  type Db,
  type LogLevel,
  type Queue,
  type ScanBounds,
} from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { type AdrModule, registerAdrs } from './adrs/index.js';
import { registerAuditLog } from './audit/index.js';
import { type AuthService, type FixedWindowRateLimiter, registerAuth } from './auth/index.js';
import { registerCommits } from './commits/index.js';
import {
  createEventBus,
  createPgRelayClient,
  type EventBus,
  EventRelay,
  Outbox,
} from './events/index.js';
import {
  type GithubHttpPort,
  type GithubModule,
  registerGithub,
  type SyncLimits,
} from './github/index.js';
import {
  buildHealthReport,
  createServiceHealthProbes,
  registerHealthRoutes,
  registerServiceHealthRoutes,
  type ServiceHealthService,
} from './health/index.js';
import { generateRequestId, registerHttpConventions } from './http/index.js';
import {
  type MemoryClients,
  type MemoryConfig,
  type MemoryModule,
  registerMemory,
} from './memory/index.js';
import { type NotificationsModule, registerNotifications } from './notifications/index.js';
import { type ObsidianModule, registerObsidian } from './obsidian/index.js';
import { registerProjects } from './projects/index.js';
import { registerPullRequests } from './pull-requests/index.js';
import { registerRepositories } from './repositories/index.js';
import { registerSchedule, type ScheduleService } from './schedule/index.js';
import { registerSearch, type SearchModule } from './search/index.js';
import {
  type AgentRuntimePort,
  registerSessions,
  type SessionModule,
  type SessionRuntimePort,
} from './sessions/index.js';
import { type ObservedIngestModule, registerObservedIngest } from './sessions/observed/index.js';
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './settings/claude-code.js';
import { registerSettings, SecretVault, type SettingsModule } from './settings/index.js';
import type { ExecutorDeps } from './settings/test-connection/executors.js';
import { registerSpend } from './spend/index.js';
import {
  type EventBusPort,
  type PromptPort,
  registerWebSocketHub,
  type WebSocketHub,
  WS_CLOSE,
} from './ws/index.js';

/**
 * Builds the Fastify 5 application without listening (TDS 02 §2).
 *
 * Exported separately from `main.ts` so integration tests can drive it through
 * `app.inject()` with no socket (TDS 07 §2.1). A `db` handle is required because
 * authentication is DB-backed (F5.5) and the guard covers every route: an app built without
 * one could serve nothing.
 *
 * SCAFFOLD STATE: request-id, the F5.4 error envelope, `GET /api/v1/health`, `auth/`, the
 * `ws/` hub, the `events/` bus + transactional outbox, and the `sessions/` domain are wired.
 * The Agent SDK wrapper behind `SessionRuntimePort`, observed-session ingest, GitHub, settings
 * and static SPA serving are registered here by their owning workstreams.
 */
export interface BuildAppOptions {
  readonly config?: AppConfig;
  readonly logLevel?: LogLevel;
  readonly db: Db;
  /**
   * The F3 queue. **Omitting it substitutes the no-op queue**, which persists nothing: F6
   * events are constructed and dropped, and no `session.launch` job survives the process.
   * That is fine for a test that does not exercise delivery and wrong for anything else, so
   * the app says so in its log when it happens.
   */
  readonly queue?: Queue | undefined;
  /** Defaults to `createUnavailableRuntimePort()`; wins over `agentRuntime` when both are given. */
  readonly runtime?: SessionRuntimePort | undefined;
  /**
   * The Claude Code runtime behind the managed wrapper (F1.5). Supplying it builds
   * `sessions/managed/` — controllers, `POST /sessions/{id}/prompts`, and the hub's
   * `PromptPort`. `main.ts` passes the Agent SDK adapter; tests pass the WS6 §5.2 mock.
   */
  readonly agentRuntime?: AgentRuntimePort | undefined;
  /** `integrations.claudeCode.maxConcurrentSessions` (§7.2), read from settings by `main.ts`. */
  readonly maxConcurrentSessions?: number | undefined;
  /**
   * How long to wait for the runtime to confirm spawn before timing out (§6.3). Tests use a
   * short timeout (100ms) to avoid waiting 30s when testing the timeout itself.
   */
  readonly spawnTimeoutMs?: number | undefined;
  /** How long to wait when disposing a controller. Tests use short timeouts. */
  readonly disposeTimeoutMs?: number | undefined;
  /**
   * `Secure` on the session cookie. Defaults to "derive from the request scheme", which under
   * sanctioned deviation D10 (loopback HTTP, no TLS in V1) means off in a dev/loopback
   * deployment and on the moment the same server is fronted by TLS.
   */
  readonly cookieSecure?: boolean | undefined;
  /** Injectable clock for the auth layer — expiry tests move time instead of sleeping. */
  readonly now?: (() => Date) | undefined;
  readonly loginRateLimiter?: FixedWindowRateLimiter | undefined;
  /**
   * Override the in-process F6 fan-out the WebSocket hub subscribes to (F3.2). The default is
   * the `events/` bus built here, which is also the one the outbox publishes to post-commit —
   * so events reach the hub and the Session registry without any further wiring.
   */
  readonly eventBus?: EventBusPort | undefined;
  /**
   * The worker -> hub event relay (TDS 04 §15.1): a dedicated `LISTEN mc_events` connection
   * whose envelopes are injected into the in-process bus above.
   *
   * On by default whenever a connection string is resolvable — `main.ts` supplies `config`, so
   * production gets it with no extra wiring and cannot forget it. `false` builds an app with no
   * relay at all, which is what the integration harness passes: an extra dedicated PostgreSQL
   * connection per test app buys nothing for a suite that never publishes a worker event, and
   * `events/relay.int.test.ts` opts back in explicitly.
   */
  readonly eventRelay?: EventRelayWiring | false | undefined;
  /** Prompt submission (§6.4). Supplied by the wrapper workstream; until then frames are refused. */
  readonly prompts?: PromptPort | undefined;
  /**
   * The network / filesystem / child-process edges of Test Connection (§7.4). Supplying them
   * is how a test exercises the executors without touching api.github.com; the default is the
   * real, bounded ports.
   */
  readonly testConnectionDeps?: ExecutorDeps | undefined;
  /**
   * The GitHub integration's one outbound network edge (`github/http.ts`). Supplying it is how
   * a test exercises discovery, sync and the poller **without** an outbound request; the
   * default is the real, bounded port.
   *
   * The integration harness installs a port that *throws* rather than one that answers, so a
   * suite that reaches api.github.com fails locally and loudly. That is the direct remedy for
   * the earlier defect where a dependency override was accepted but never forwarded and the
   * harness silently made real calls.
   */
  readonly githubHttp?: GithubHttpPort | undefined;
  /** Point the GitHub client somewhere other than api.github.com (tests only). */
  readonly githubBaseUrl?: string | undefined;
  /** Shrink the per-sync page and detail budgets (tests only). */
  readonly githubLimits?: SyncLimits | undefined;
  /**
   * `statement_timeout` for `GET /api/v1/search` (TDS 04 §11). Defaults to
   * `DEFAULT_SEARCH_TIMEOUT_MS`; a test drops it to 1ms to prove the bound is enforced by
   * PostgreSQL rather than merely written down.
   */
  readonly searchTimeoutMs?: number | undefined;
  /**
   * Bounds for the dry-run preview's vault walk (`GET /sync-runs/preview`). Tests shrink them
   * to prove the scan stops rather than waiting for a real 15-second deadline.
   */
  readonly obsidianScanBounds?: ScanBounds | undefined;
  /**
   * The Phase 3 memory layer's two outbound edges (Ollama and Qdrant), as one factory.
   *
   * Supplying it is how a test exercises the Services health rows and the startup verification
   * with `createFakeEmbedder` / `createInMemoryVectorStore` instead of two locally-installed
   * services. The default builds the real, bounded adapters — and they are only ever *used*
   * once an embedding model is configured, so an install that has never opened the Memory
   * settings makes no outbound call at all.
   */
  readonly memoryClients?: ((config: MemoryConfig) => MemoryClients) | undefined;
  /** Shrink the memory health probes' bound (tests only). */
  readonly memoryProbeTimeoutMs?: number | undefined;
  /**
   * Sources per memory backfill slice (TDS 04 §13.1 / `backfill.ts`). Tests shrink it so a
   * sweep provably takes more than one slice — resumability is not demonstrable in one batch.
   */
  readonly memoryBackfillBatchSize?: number | undefined;
}

/** Overrides for the relay, all optional. Tests use them; `main.ts` uses none of them. */
export interface EventRelayWiring {
  /** Defaults to `config.databaseUrl`. */
  readonly connectionString?: string | undefined;
  readonly channel?: string | undefined;
  readonly reconnectDelayMs?: number | undefined;
  readonly maxReconnectDelayMs?: number | undefined;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly auth: AuthService;
  readonly hub: WebSocketHub;
  readonly bus: EventBus;
  readonly outbox: Outbox;
  /**
   * `null` when no relay was wired (no connection string, or explicitly disabled). Worker-
   * produced events then reach nothing in this process, which is the pre-Phase-2 behaviour.
   */
  readonly eventRelay: EventRelay | null;
  readonly sessions: SessionModule;
  /** Observed-session ingest: `POST /hook-events` + the transcript tailer (TDS 02 §6). */
  readonly observed: ObservedIngestModule;
  /** The four Phase 1 read models (TDS 04 §7.5, §7.7, §7.8, §8). */
  readonly serviceHealth: ServiceHealthService;
  readonly schedule: ScheduleService;
  /** The §8 read surface plus the Phase 2 producer that writes the rows (`produce.ts`). */
  readonly notifications: NotificationsModule;
  /** Settings read/write, secrets and Test Connection (TDS 04 §7.1–§7.4). */
  readonly settings: SettingsModule;
  /** Repository discovery, commit/PR sync and the polling producer (TDS 04 §5, PRD §4.3). */
  readonly github: GithubModule;
  /** Phase 2 keyword search across the five TDS 03 §4.6 branches (TDS 04 §11). */
  readonly search: SearchModule;
  /** ADR CRUD + `generate-adr` (TDS 04 §9, PRD §7.3). */
  readonly adrs: AdrModule;
  /** Obsidian sync runs, the dry-run preview, and nothing that writes a vault (TDS 04 §10). */
  readonly obsidian: ObsidianModule;
  /**
   * Phase 3 memory (PRD §6): the Services health probes, the startup collection verification,
   * the `memory.index` producer/consumer and `POST /memory-items/search`. The Memory UI is the
   * follow-up.
   */
  readonly memory: MemoryModule;
}

/** Build the app and return it together with the services tests need to reach into. */
export function buildAppWithServices(options: BuildAppOptions): BuiltApp {
  const level = options.logLevel ?? options.config?.logLevel ?? 'info';

  const app = Fastify({
    // UUIDv7 request ids (F4.2); an inbound X-Request-Id is honoured so a correlation id
    // survives across a hook POST or CLI client.
    genReqId: (req) => generateRequestId(req.headers['x-request-id']),
    requestIdHeader: false,
    logger: {
      level,
      // JSON to stdout only (TDS 02 §9.4). No pretty transport, no log files.
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: { level: (label: string) => ({ level: label }) },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    // 1 MiB default body limit; the prompt route drops to 256 KiB (TDS 04 §1.3).
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  registerHttpConventions(app);

  const queue = options.queue ?? createNoopQueue();
  if (options.queue === undefined) {
    app.log.warn(
      'No queue supplied: using the in-memory no-op queue. F6 events will not be delivered.',
    );
  }

  const bus = createEventBus({
    onListenerError: (error) => {
      app.log.error({ err: error }, 'event bus listener failed');
    },
  });

  const outbox = new Outbox({
    db: options.db,
    queue,
    bus,
    source: 'backend',
    onPublishError: (error) => {
      app.log.error({ err: error }, 'event relay failed');
    },
  });

  // Registered before any route so the guard's onRequest hook covers all of them, including
  // the ones later workstreams add (TDS 04 §1.4: authenticated by default).
  const auth = registerAuth(app, {
    db: options.db,
    cookieSecure: options.cookieSecure,
    now: options.now,
    loginRateLimiter: options.loginRateLimiter,
  });

  registerHealthRoutes(app);

  const sessions = registerSessions(app, {
    db: options.db,
    outbox,
    bus,
    queue,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.agentRuntime === undefined ? {} : { agentRuntime: options.agentRuntime }),
    maxConcurrentSessions: options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
    ...(options.spawnTimeoutMs === undefined ? {} : { spawnTimeoutMs: options.spawnTimeoutMs }),
    ...(options.disposeTimeoutMs === undefined
      ? {}
      : { disposeTimeoutMs: options.disposeTimeoutMs }),
    onError: (error, sessionId) => {
      app.log.error({ err: error, sessionId }, 'session runtime error');
    },
  });

  // Observed-session ingest (TDS 02 §6): the hook endpoint and the transcript tailer. It
  // consumes the Session domain's MessageService and state machine rather than duplicating
  // either — one ordinal assigner, one state writer.
  const observed = registerObservedIngest(app, {
    db: options.db,
    outbox,
    bus,
    messages: sessions.messages,
    stateMachine: sessions.stateMachine,
    onError: (error, sessionId) => {
      app.log.error({ err: error, sessionId }, 'observed ingest error');
    },
  });

  // The Project and Repository domains (TDS 04 §4/§5.1). Registered after the Session domain
  // and before the hub purely for readability — both are plain CRUD over their own tables and
  // depend on nothing here except the db handle (and, for `repository.discovered`, the outbox).
  registerProjects(app, { db: options.db });
  registerRepositories(app, { db: options.db, outbox });

  // The Commit and PullRequest read models (§5.2/§5.3). Registered next to `repositories/`
  // because every one of their routes hangs off a Repository, and read-only by construction:
  // `github/` writes both tables, these two modules only serve them.
  registerCommits(app, { db: options.db });
  registerPullRequests(app, { db: options.db });

  // After `registerAuth`, and that ordering is load-bearing: the guard's instance-level
  // `onRequest` hook must already be in place so it authenticates the upgrade before the
  // route's own Origin check runs (TDS 04 §14.1–§14.2, and the ordering note in `ws/index.ts`).
  const { hub } = registerWebSocketHub(app, {
    config: options.config,
    db: options.db,
    auth,
    bus: options.eventBus ?? bus,
    // §14.4's `prompt` frame is transport-equivalent to §6.4, so it delegates to the same
    // service the REST route does. Without a managed runtime there is nothing to delegate to
    // and the hub answers `OPERATION_NOT_SUPPORTED`, which is the truth.
    prompts: options.prompts ?? sessions.managed?.prompts,
  });

  // Ephemeral streaming deltas (§14.5) go straight to the hub, which exists only now — see
  // `createDeltaRelay` for why this is a late attach rather than a constructor argument.
  sessions.managed?.deltas.attach(hub);

  // The worker -> hub relay (TDS 04 §15.1). Built after the hub because its gap policy needs it,
  // and it publishes onto `bus` — the same bus the outbox publishes to post-commit — so a
  // relayed `sync.completed` is indistinguishable from an in-process one everywhere downstream.
  const eventRelay = buildEventRelay(app, options, bus, hub);

  // The one vault in this process. Built here rather than inside `registerSettings` because the
  // memory layer below needs to read `integrations.qdrant.apiKey`, and it is wired into the
  // health probes *before* settings registration happens — see `registerSettings`'s `vault`.
  const vault = new SecretVault({ encryptionKey: options.config?.encryptionKey ?? null });

  // Phase 3 memory (PRD §6): the Services rows, `POST /memory-items/search`, and the
  // `memory.index` producer whose single consumer `main.ts` starts once the queue is up.
  //
  // Registered before the read models below because `serviceHealth` consumes `memory.probes`,
  // and after `sessions`/`adrs` in *effect* rather than in order: its event triggers attach to
  // the same post-commit bus every domain publishes on, so subscription order does not matter.
  const memory = registerMemory(app, {
    db: options.db,
    vault,
    queue,
    outbox,
    bus,
    ...(options.memoryClients === undefined ? {} : { build: options.memoryClients }),
    ...(options.memoryProbeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.memoryProbeTimeoutMs }),
    ...(options.memoryBackfillBatchSize === undefined
      ? {}
      : { backfillBatchSize: options.memoryBackfillBatchSize }),
    ...(options.now === undefined ? {} : { now: options.now }),
    onError: (error, context) => {
      app.log.error({ err: error, context }, 'memory indexing error');
    },
  });

  // The read models the Dashboard and Settings pages are built on: Services health (§7.5),
  // schedule (§7.7), spend (§7.8) and notifications (§8). Health is registered last because it
  // self-reports the hub's connection count and the registry's slot usage (TDS 02 §7.1), and
  // both of those exist only now.
  const serviceHealth = registerServiceHealthRoutes(app, {
    probes: createServiceHealthProbes({
      db: options.db,
      queue,
      memory: memory.probes,
      backend: () => {
        const report = buildHealthReport();
        return {
          version: report.version,
          uptimeSeconds: report.uptimeSeconds,
          startedAt: report.startedAt,
          wsConnections: hub.connectionCount,
          activeSessions: sessions.registry.slotsInUse,
          maxConcurrentSessions: sessions.registry.maxConcurrentSessions,
          // A dead relay is invisible by nature — worker events simply stop arriving — so its
          // state is reported where an operator already looks (Settings -> Services).
          ...(eventRelay === null ? {} : { eventRelay: eventRelay.status }),
        };
      },
    }),
  });

  const schedule = registerSchedule(app, { db: options.db });

  registerSpend(app, {
    db: options.db,
    onTimezoneRejected: (timezone, error) => {
      app.log.warn(
        { err: error, timezone },
        'general.timezone was rejected by PostgreSQL — spend fell back to UTC',
      );
    },
  });

  // The Notification producer subscribes to the same in-process bus the outbox publishes to
  // after commit, so `session.completed` becomes a Notification (and its Telegram delivery
  // job) only once the Session's own transaction is durable (TDS 04 §8, §15.2).
  const notifications = registerNotifications(app, {
    db: options.db,
    outbox,
    queue,
    bus,
  });
  app.addHook('onClose', async () => {
    notifications.stop();
  });

  // Settings (§7.1–§7.4) and the audit-log read (§12). Registered after the read models
  // because a settings write is what makes them change: `setting.updated` goes out through the
  // same outbox every other domain uses, which is how the WS hub invalidates the origin
  // allowlist and how the Phase 2 workers will refresh their config without a restart.
  const settings = registerSettings(app, {
    db: options.db,
    outbox,
    config: options.config,
    vault,
    testConnectionDeps: options.testConnectionDeps,
  });

  registerAuditLog(app, { db: options.db });

  // GitHub (TDS 02 §2, TDS 04 §5.1). Registered after `settings` because it reads the token
  // through that module's vault and re-primes its poll chain on `setting.updated`, which is the
  // event the settings service publishes on this same bus.
  const github = registerGithub(app, {
    db: options.db,
    outbox,
    queue,
    bus,
    vault: settings.vault,
    ...(options.githubHttp === undefined ? {} : { http: options.githubHttp }),
    ...(options.githubBaseUrl === undefined ? {} : { baseUrl: options.githubBaseUrl }),
    ...(options.githubLimits === undefined ? {} : { limits: options.githubLimits }),
    ...(options.now === undefined ? {} : { now: options.now }),
    onError: (error, context) => {
      app.log.error({ err: error, context }, 'github integration error');
    },
  });

  // Keyword search (TDS 04 §11). Registered last and depending on nothing but the db handle:
  // it owns no table, reads five it does not write, and the generated `search_tsv` columns it
  // queries are maintained by PostgreSQL inside each of those writes (TDS 03 §4.6).
  const search = registerSearch(app, {
    db: options.db,
    ...(options.searchTimeoutMs === undefined ? {} : { searchTimeoutMs: options.searchTimeoutMs }),
    onTimeout: (q, timeoutMs) => {
      app.log.warn({ queryLength: q.length, timeoutMs }, 'search exceeded its statement timeout');
    },
  });

  // Knowledge (Phase 2): the Adr domain (TDS 04 §9) and the Obsidian sync surface (§10).
  //
  // Both are producers only — `adrs` writes its own table and enqueues `adr.generate`;
  // `obsidian` inserts a `sync_runs` row and enqueues `obsidian.sync`. Neither touches the
  // vault: that happens in the Sync Worker, which is the single writer (F2.2). The one
  // exception is the dry-run preview, which *reads* the vault and writes nothing anywhere.
  const adrs = registerAdrs(app, { db: options.db, outbox, queue });
  const obsidian = registerObsidian(app, {
    db: options.db,
    outbox,
    queue,
    scanBounds: options.obsidianScanBounds,
  });

  return {
    app,
    auth,
    hub,
    bus,
    outbox,
    eventRelay,
    sessions,
    observed,
    serviceHealth,
    schedule,
    notifications,
    settings,
    github,
    adrs,
    obsidian,
    search,
    memory,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  return buildAppWithServices(options).app;
}

/**
 * Construct and wire the worker event relay, or return `null` when there is nothing to connect
 * to (`eventRelay: false`, or an app built without `config`).
 *
 * Lifecycle deliberately hangs off Fastify rather than off `main.ts`: `onReady` means every
 * caller that boots the app — including `app.inject()` in a test — gets a live relay, and
 * `onClose` means nobody has to remember to stop it. A failed first connect does not reject;
 * the relay schedules a retry, because a database that is still coming up must not stop the
 * Backend from serving `/health`.
 */
function buildEventRelay(
  app: FastifyInstance,
  options: BuildAppOptions,
  bus: EventBus,
  hub: WebSocketHub,
): EventRelay | null {
  if (options.eventRelay === false) return null;

  const wiring = options.eventRelay ?? {};
  const connectionString = wiring.connectionString ?? options.config?.databaseUrl;
  if (connectionString === undefined) return null;

  const relay = new EventRelay({
    bus,
    log: app.log,
    newClient: () => createPgRelayClient(connectionString),
    ...(wiring.channel === undefined ? {} : { channel: wiring.channel }),
    ...(wiring.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: wiring.reconnectDelayMs }),
    ...(wiring.maxReconnectDelayMs === undefined
      ? {}
      : { maxReconnectDelayMs: wiring.maxReconnectDelayMs }),
    /**
     * The gap policy, stated at the wiring site rather than buried in the relay.
     *
     * `NOTIFY` has no backlog: whatever a worker raised while the listener was down is gone,
     * and F6.3 forbids the hub keeping a replay buffer that could serve it. §14.7 already
     * defines the recovery — reconnect, re-subscribe, refetch per channel — so the server
     * invokes it. Closing every connection is a blunt instrument for a rare event (a database
     * restart, a network blip), and the alternative is a browser that looks live while its
     * sync row and notification list quietly diverge from the truth.
     */
    onGap: ({ downForMs }) => {
      const affected = hub.connectionCount;
      if (affected === 0) return;
      app.log.warn(
        { downForMs, connections: affected },
        'closing websocket connections after an event relay gap so clients refetch (§14.7)',
      );
      hub.closeAll(WS_CLOSE.RELAY_GAP, 'event relay gap; reconnect and refetch');
    },
  });

  app.addHook('onReady', async () => {
    await relay.start();
  });
  app.addHook('onClose', async () => {
    await relay.stop();
  });

  return relay;
}
