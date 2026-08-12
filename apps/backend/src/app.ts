import type { AppConfig, LogLevel } from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health/index.js';
import { generateRequestId, registerHttpConventions } from './http/index.js';

/**
 * Builds the Fastify 5 application without listening (TDS 02 §2).
 *
 * Exported separately from `main.ts` so integration tests can drive it through
 * `app.inject()` with no socket and no database (TDS 07 §2.1).
 *
 * SCAFFOLD STATE: request-id, the F5.4 error envelope and `GET /api/v1/health` are wired.
 * The database pool, queue, auth, WebSocket hub, domain routes and static SPA serving are
 * registered here by their owning workstreams.
 */
export interface BuildAppOptions {
  readonly config?: AppConfig;
  readonly logLevel?: LogLevel;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
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
  registerHealthRoutes(app);

  return app;
}
