import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import { serializeClearedSessionCookie, serializeSessionCookie } from './cookie.js';
import { PUBLIC_ROUTE, requirePrincipal } from './guard.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords.js';
import { API_TOKEN_SCOPES, type ApiTokenScope } from './principal.js';
import { FixedWindowRateLimiter, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS } from './rate-limit.js';
import type { ApiTokenView, AuthService, RequestContext } from './service.js';

/**
 * `/api/v1/auth/*` — TDS 04 §3, implemented path-for-path and shape-for-shape.
 *
 *   POST   /api/v1/auth/login       public, 10/min/IP   → 200 + `mc_session` cookie
 *   POST   /api/v1/auth/logout      authenticated       → 204
 *   GET    /api/v1/auth/me          authenticated       → 200
 *   POST   /api/v1/auth/password    authenticated       → 204
 *   GET    /api/v1/auth/tokens      authenticated       → 200 (cursor list)
 *   POST   /api/v1/auth/tokens      authenticated       → 201 (token value shown once)
 *   DELETE /api/v1/auth/tokens/{id} authenticated       → 204
 *
 * `http/` owns no business logic (TDS 02 §2): these handlers validate, delegate to
 * `AuthService`, and shape the envelope.
 */

export interface AuthRoutesOptions {
  readonly auth: AuthService;
  /**
   * `Secure` on the session cookie. `undefined` derives it per request from the scheme the
   * request actually arrived on, which is the honest reading of TDS 04 §1.4 ("`Secure` when
   * served over HTTPS") under sanctioned deviation D10 — V1 binds loopback HTTP with no TLS,
   * so a hardcoded `Secure` would lock the operator out of their own dashboard.
   */
  readonly cookieSecure?: boolean | undefined;
  /** Injectable so tests can drive the window without a real minute passing. */
  readonly loginRateLimiter?: FixedWindowRateLimiter | undefined;
}

const loginBodySchema = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 64 },
    password: { type: 'string', minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
  },
} as const;

const passwordBodySchema = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
    newPassword: {
      type: 'string',
      minLength: MIN_PASSWORD_LENGTH,
      maxLength: MAX_PASSWORD_LENGTH,
    },
  },
} as const;

/**
 * `scopes` is **required**, and that is a security decision rather than strictness for its
 * own sake.
 *
 * `additionalProperties: false` does not reject here — Fastify runs Ajv with
 * `removeAdditional: true`, which turns it into *silently delete the field*. So a caller who
 * typed the singular `scope: ['ingest']` had it stripped, and with `scopes` optional the
 * service's `?? ['full']` default then issued a **full-access token**, answered `201`, and
 * gave no hint that the requested scope had been discarded. Privilege escalation by typo,
 * with a success response.
 *
 * Making the field required closes it at the schema: the stripped body now fails validation
 * with `VALIDATION_FAILED` naming `scopes`. Full access must be asked for explicitly and can
 * never be reached by omission — which is the point of the `ingest` scope existing at all,
 * since it is what stops a hook profile installed on a dev machine from holding the whole API.
 *
 * The SPA already sends `scopes` on every create (`features/settings/panels/ApiTokens.tsx`),
 * so no client of ours relied on the default.
 */
const createTokenBodySchema = {
  type: 'object',
  required: ['name', 'scopes'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    scopes: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', enum: [...API_TOKEN_SCOPES] },
    },
    expiresAt: { type: 'string', minLength: 1, maxLength: 40 },
  },
} as const;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

const tokenIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const;

interface LoginBody {
  username: string;
  password: string;
}
interface PasswordBody {
  currentPassword: string;
  newPassword: string;
}
interface CreateTokenBody {
  name: string;
  scopes?: ApiTokenScope[];
  expiresAt?: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
}
interface TokenIdParams {
  id: string;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { auth } = options;
  const loginRateLimiter =
    options.loginRateLimiter ??
    new FixedWindowRateLimiter({ limit: LOGIN_RATE_LIMIT, windowMs: LOGIN_RATE_WINDOW_MS });

  const cookieSecureFor = (request: FastifyRequest): boolean =>
    options.cookieSecure ?? request.protocol === 'https';

  // ------------------------------------------------------------------------ §3.1 session

  app.post<{ Body: LoginBody }>(
    '/api/v1/auth/login',
    {
      config: { auth: PUBLIC_ROUTE },
      schema: { body: loginBodySchema },
    },
    async (request, reply) => {
      const decision = loginRateLimiter.consume(request.ip);
      if (!decision.allowed) {
        reply.header('retry-after', String(decision.retryAfterSeconds));
        throw new ApiError('RATE_LIMITED', 'Too many login attempts. Try again shortly.', {
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }

      const result = await auth.login(request.body, contextOf(request));

      const maxAgeSeconds = Math.max(
        0,
        Math.floor((result.expiresAt.getTime() - auth.now().getTime()) / 1000),
      );
      reply.header(
        'set-cookie',
        serializeSessionCookie(result.sessionToken, {
          secure: cookieSecureFor(request),
          maxAgeSeconds,
        }),
      );

      return dataEnvelope({
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(requirePrincipal(request), contextOf(request));
    reply.header('set-cookie', serializeClearedSessionCookie({ secure: cookieSecureFor(request) }));
    return noContent(reply);
  });

  app.get('/api/v1/auth/me', async (request) => {
    const principal = requirePrincipal(request);
    return dataEnvelope({
      user: { id: principal.userId, username: principal.username },
      authMethod: principal.authMethod,
      // `null` for token auth (TDS 04 §3.1) — a bearer token has no server-side session.
      session:
        principal.authSession === null
          ? null
          : { expiresAt: principal.authSession.expiresAt.toISOString() },
    });
  });

  app.post<{ Body: PasswordBody }>(
    '/api/v1/auth/password',
    { schema: { body: passwordBodySchema } },
    async (request, reply) => {
      await auth.changePassword(requirePrincipal(request), request.body, contextOf(request));
      return noContent(reply);
    },
  );

  // ------------------------------------------------------------------- §3.2–3.3 tokens

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/auth/tokens',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const afterId = decodeIdCursor(request.query.cursor);

      const tokens = await auth.listApiTokens(requirePrincipal(request), { limit, afterId });
      const page = paginate(tokens.map(serializeToken), limit, (row) => row.id);

      return { data: page.data, meta: page.meta };
    },
  );

  app.post<{ Body: CreateTokenBody }>(
    '/api/v1/auth/tokens',
    { schema: { body: createTokenBodySchema } },
    async (request, reply) => {
      const created = await auth.createApiToken(
        requirePrincipal(request),
        {
          name: request.body.name,
          ...(request.body.scopes === undefined ? {} : { scopes: request.body.scopes }),
          expiresAt: parseExpiresAt(request.body.expiresAt),
        },
        contextOf(request),
      );

      reply.code(201);
      return dataEnvelope({
        ...serializeToken(created),
        // The one and only time this value exists outside the client's own storage.
        token: created.token,
      });
    },
  );

  app.delete<{ Params: TokenIdParams }>(
    '/api/v1/auth/tokens/:id',
    { schema: { params: tokenIdParamsSchema } },
    async (request, reply) => {
      await auth.revokeApiToken(requirePrincipal(request), request.params.id, contextOf(request));
      return noContent(reply);
    },
  );
}

/** TDS 04 §1.2: `204 No Content` for deletes, logout and ingest acks. */
function noContent(reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}

function contextOf(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: request.id,
    ipAddress: request.ip.length > 0 ? request.ip : null,
    userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : null,
  };
}

function serializeToken(token: ApiTokenView): {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
} {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: [...token.scopes],
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

/**
 * `expiresAt` is validated here rather than by a JSON-Schema `format`: Fastify's bundled ajv
 * has no format vocabulary, so `format: 'date-time'` would be silently ignored — a validation
 * rule that looks present and does nothing is worse than none.
 */
function parseExpiresAt(value: string | undefined): Date | null {
  if (value === undefined) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', 'expiresAt must be an ISO 8601 timestamp', {
      field: 'expiresAt',
    });
  }
  return parsed;
}
