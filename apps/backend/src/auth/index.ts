import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { registerAuthGuard } from './guard.js';
import type { FixedWindowRateLimiter } from './rate-limit.js';
import { registerAuthRoutes } from './routes.js';
import { AuthService } from './service.js';

/**
 * `auth/` — local account login, DB-backed sessions, cookie issuance, bearer API tokens
 * (F5.5); password hashing with argon2id (TDS 02 §2, TDS 03 §3.1).
 *
 * Contract: TDS 04 §1.4 (two principals, one User) and §3 (the endpoints). Storage:
 * TDS 03 §3.1–§3.3 (`users`, `auth_sessions`, `api_tokens`), unmodified.
 *
 * Layout:
 *   passwords.ts  argon2id hashing/verification (+ the decoy hash that keeps the two login
 *                 failure modes indistinguishable in time as well as in wording)
 *   tokens.ts     opaque credential generation, SHA-256 storage form, timing-safe compare
 *   cookie.ts     the `mc_session` cookie: HTTP-only, SameSite=Lax, Secure from config
 *   principal.ts  the authenticated caller, scopes, and the TDS 04 §12 audit actor rule
 *   service.ts    all `users` / `auth_sessions` / `api_tokens` access + audit writes
 *   guard.ts      the global onRequest guard: authenticated by default, opt-out is explicit
 *   routes.ts     `/api/v1/auth/*`
 *   rate-limit.ts login throttle (10/min/IP, TDS 04 §3.1)
 *   bootstrap.ts  first-run account creation (see the TDS gap noted in that file)
 */

export * from './bootstrap.js';
export * from './cookie.js';
export * from './guard.js';
export * from './passwords.js';
export * from './principal.js';
export * from './rate-limit.js';
export * from './service.js';
export * from './tokens.js';

export interface RegisterAuthOptions {
  readonly db: Db;
  /** `undefined` derives `Secure` per request from the scheme (see `AuthRoutesOptions`). */
  readonly cookieSecure?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
  readonly loginRateLimiter?: FixedWindowRateLimiter | undefined;
}

/**
 * Wire authentication into the app: the guard first (so it covers every route registered
 * afterwards, including routes other modules add), then the auth endpoints themselves.
 */
export function registerAuth(app: FastifyInstance, options: RegisterAuthOptions): AuthService {
  const auth = new AuthService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  registerAuthGuard(app, auth);
  registerAuthRoutes(app, {
    auth,
    cookieSecure: options.cookieSecure,
    loginRateLimiter: options.loginRateLimiter,
  });

  return auth;
}
