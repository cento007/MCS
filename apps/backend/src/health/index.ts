import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import { PUBLIC_ROUTE } from '../auth/guard.js';
import { dataEnvelope } from '../http/errors.js';

/**
 * `health/` — process liveness plus the Services health aggregator.
 *
 * TWO DISTINCT SURFACES, do not merge them:
 *
 *  1. `GET /api/v1/health` (this file) — process liveness. No database, no auth, no
 *     downstream checks. It answers "this Node process is up and serving HTTP", which is
 *     what a console operator, a smoke test, or a future reverse proxy needs. It must stay
 *     dependency-free.
 *
 *  2. `GET /api/v1/services/health` (`services.ts`, TDS 04 §7.5) — the operator-facing read
 *     model behind Settings -> Services (PRD §4.4.7): PostgreSQL latency, Queue (PostgreSQL)
 *     depth, worker heartbeat ages (TDS 02 §7.2), Qdrant/Ollama placeholders. Authenticated,
 *     DB-dependent, cached ~5 s, and it reports a broken dependency as `down` rather than
 *     failing the request.
 *
 * NOTE FOR THE CONTRACT OWNER (WS2): `/api/v1/health` does not appear in the TDS 04 §2
 * resource catalog, and §1.4 says every route except `POST /auth/login` requires
 * authentication. This unauthenticated liveness probe is therefore a scaffold addition
 * that WS2 should either adopt into the catalog or replace. It is the ONLY route besides
 * `POST /api/v1/auth/login` that declares `PUBLIC_ROUTE` — a liveness probe that needs a
 * credential cannot answer the question it exists to answer.
 */

/** Set by the build; `0.0.0` in a dev console. */
const VERSION = process.env['MC_VERSION'] ?? '0.0.0';

export interface HealthReport {
  readonly status: 'ok';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly startedAt: string;
}

const STARTED_AT = new Date();

export function buildHealthReport(now: Date = new Date()): HealthReport {
  return {
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - STARTED_AT.getTime()) / 1000)),
    startedAt: STARTED_AT.toISOString(),
  };
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/v1/health', { config: { auth: PUBLIC_ROUTE } }, async () =>
    dataEnvelope(buildHealthReport()),
  );
}

export * from './services.js';
