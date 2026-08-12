import type { AppConfig, Db, LogLevel } from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { type AuthService, type FixedWindowRateLimiter, registerAuth } from './auth/index.js';
import { registerHealthRoutes } from './health/index.js';
import { generateRequestId, registerHttpConventions } from './http/index.js';

/**
 * Builds the Fastify 5 application without listening (TDS 02 §2).
 *
 * Exported separately from `main.ts` so integration tests can drive it through
 * `app.inject()` with no socket (TDS 07 §2.1). A `db` handle is required because
 * authentication is DB-backed (F5.5) and the guard covers every route: an app built without
 * one could serve nothing.
 *
 * SCAFFOLD STATE: request-id, the F5.4 error envelope, `GET /api/v1/health` and `auth/` are
 * wired. The queue, WebSocket hub, remaining domain routes and static SPA serving are
 * registered here by their owning workstreams.
 */
export interface BuildAppOptions {
  readonly config?: AppConfig;
  readonly logLevel?: LogLevel;
  readonly db: Db;
  /**
   * `Secure` on the session cookie. Defaults to "derive from the request scheme", which under
   * sanctioned deviation D10 (loopback HTTP, no TLS in V1) means off in a dev/loopback
   * deployment and on the moment the same server is fronted by TLS.
   */
  readonly cookieSecure?: boolean | undefined;
  /** Injectable clock for the auth layer — expiry tests move time instead of sleeping. */
  readonly now?: (() => Date) | undefined;
  readonly loginRateLimiter?: FixedWindowRateLimiter | undefined;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly auth: AuthService;
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

  // Registered before any route so the guard's onRequest hook covers all of them, including
  // the ones later workstreams add (TDS 04 §1.4: authenticated by default).
  const auth = registerAuth(app, {
    db: options.db,
    cookieSecure: options.cookieSecure,
    now: options.now,
    loginRateLimiter: options.loginRateLimiter,
  });

  registerHealthRoutes(app);

  return { app, auth };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  return buildAppWithServices(options).app;
}
