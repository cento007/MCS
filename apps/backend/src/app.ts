import { type AppConfig, createNoopQueue, type Db, type LogLevel, type Queue } from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuditLog } from './audit/index.js';
import { type AuthService, type FixedWindowRateLimiter, registerAuth } from './auth/index.js';
import { createEventBus, type EventBus, Outbox } from './events/index.js';
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
import { type NotificationService, registerNotifications } from './notifications/index.js';
import { registerProjects } from './projects/index.js';
import { registerRepositories } from './repositories/index.js';
import { registerSchedule, type ScheduleService } from './schedule/index.js';
import {
  type AgentRuntimePort,
  registerSessions,
  type SessionModule,
  type SessionRuntimePort,
} from './sessions/index.js';
import { type ObservedIngestModule, registerObservedIngest } from './sessions/observed/index.js';
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './settings/claude-code.js';
import { registerSettings, type SettingsModule } from './settings/index.js';
import type { ExecutorDeps } from './settings/test-connection/executors.js';
import { registerSpend } from './spend/index.js';
import {
  type EventBusPort,
  type PromptPort,
  registerWebSocketHub,
  type WebSocketHub,
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
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly auth: AuthService;
  readonly hub: WebSocketHub;
  readonly bus: EventBus;
  readonly outbox: Outbox;
  readonly sessions: SessionModule;
  /** Observed-session ingest: `POST /hook-events` + the transcript tailer (TDS 02 §6). */
  readonly observed: ObservedIngestModule;
  /** The four Phase 1 read models (TDS 04 §7.5, §7.7, §7.8, §8). */
  readonly serviceHealth: ServiceHealthService;
  readonly schedule: ScheduleService;
  readonly notifications: NotificationService;
  /** Settings read/write, secrets and Test Connection (TDS 04 §7.1–§7.4). */
  readonly settings: SettingsModule;
  /** Repository discovery, commit/PR sync and the polling producer (TDS 04 §5, PRD §4.3). */
  readonly github: GithubModule;
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

  // The read models the Dashboard and Settings pages are built on: Services health (§7.5),
  // schedule (§7.7), spend (§7.8) and notifications (§8). Health is registered last because it
  // self-reports the hub's connection count and the registry's slot usage (TDS 02 §7.1), and
  // both of those exist only now.
  const serviceHealth = registerServiceHealthRoutes(app, {
    probes: createServiceHealthProbes({
      db: options.db,
      queue,
      backend: () => {
        const report = buildHealthReport();
        return {
          version: report.version,
          uptimeSeconds: report.uptimeSeconds,
          startedAt: report.startedAt,
          wsConnections: hub.connectionCount,
          activeSessions: sessions.registry.slotsInUse,
          maxConcurrentSessions: sessions.registry.maxConcurrentSessions,
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

  const notifications = registerNotifications(app, { db: options.db });

  // Settings (§7.1–§7.4) and the audit-log read (§12). Registered after the read models
  // because a settings write is what makes them change: `setting.updated` goes out through the
  // same outbox every other domain uses, which is how the WS hub invalidates the origin
  // allowlist and how the Phase 2 workers will refresh their config without a restart.
  const settings = registerSettings(app, {
    db: options.db,
    outbox,
    config: options.config,
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

  return {
    app,
    auth,
    hub,
    bus,
    outbox,
    sessions,
    observed,
    serviceHealth,
    schedule,
    notifications,
    settings,
    github,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  return buildAppWithServices(options).app;
}
