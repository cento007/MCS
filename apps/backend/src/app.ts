import { type AppConfig, createNoopQueue, type Db, type LogLevel, type Queue } from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { type AuthService, type FixedWindowRateLimiter, registerAuth } from './auth/index.js';
import { createEventBus, type EventBus, Outbox } from './events/index.js';
import { registerHealthRoutes } from './health/index.js';
import { generateRequestId, registerHttpConventions } from './http/index.js';
import {
  type AgentRuntimePort,
  registerSessions,
  type SessionModule,
  type SessionRuntimePort,
} from './sessions/index.js';
import { type ObservedIngestModule, registerObservedIngest } from './sessions/observed/index.js';
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './settings/claude-code.js';
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

  return { app, auth, hub, bus, outbox, sessions, observed };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  return buildAppWithServices(options).app;
}
