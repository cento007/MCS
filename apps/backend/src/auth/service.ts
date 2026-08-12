import { type Db, newId, schema } from '@mc/shared';
import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { recordAuditEntry } from '../audit/index.js';
import { ApiError } from '../http/errors.js';
import { readSessionTimeoutMinutes } from '../settings/security.js';
import {
  assertPasswordPolicy,
  hashPassword,
  PasswordPolicyError,
  verifyAgainstDecoy,
  verifyPassword,
} from './passwords.js';
import {
  type ApiTokenScope,
  auditActorContext,
  isApiTokenScope,
  type Principal,
} from './principal.js';
import {
  apiTokenPrefix,
  generateApiToken,
  generateSessionToken,
  hashToken,
  looksLikeApiToken,
  timingSafeHexEquals,
} from './tokens.js';

/**
 * `auth/service.ts` — everything that touches `users`, `auth_sessions` and `api_tokens`
 * (TDS 03 §3.1–§3.3) behind one object, so `routes.ts` and the guard stay transport code.
 *
 * Audit rows are written here rather than in the routes: the service is where the outcome is
 * actually known (a login that failed on the password vs. on an unknown username are the same
 * HTTP response but different audit rows), and TDS 03 §3.14 makes auth coverage mandatory.
 */

/** Per-request facts that every audited operation records (F5.4, TDS 03 §3.14). */
export interface RequestContext {
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AuthServiceOptions {
  readonly db: Db;
  /** Injectable clock — the expiry tests move time without sleeping. */
  readonly now?: () => Date;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

export interface LoginResult {
  readonly user: { readonly id: string; readonly username: string };
  /** Plaintext cookie value — returned once, to be written straight into `Set-Cookie`. */
  readonly sessionToken: string;
  readonly expiresAt: Date;
}

export interface CreateApiTokenInput {
  readonly name: string;
  readonly scopes?: readonly ApiTokenScope[];
  readonly expiresAt?: Date | null;
}

/** The API-facing token shape (TDS 04 §3.2–3.3) — never carries the token value. */
export interface ApiTokenView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ApiTokenScope[];
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface CreatedApiToken extends ApiTokenView {
  /** Shown exactly once, at creation (TDS 04 §3.3, WS5 §5.7.11). Never stored, never re-read. */
  readonly token: string;
}

/**
 * How stale `last_seen_at` / `last_used_at` may get before a request pays for an UPDATE.
 * Without this, every authenticated GET writes a row; with it, the idle-timeout clock is
 * still accurate to within a minute, which is the resolution the setting is expressed in.
 */
const TOUCH_INTERVAL_MS = 60_000;

export class AuthService {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(options: AuthServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
  }

  get db(): Db {
    return this.#db;
  }

  now(): Date {
    return this.#now();
  }

  // ---------------------------------------------------------------- session auth (§3.1)

  /**
   * `POST /api/v1/auth/login`. Both failure modes — unknown username and wrong password —
   * cost the same Argon2id verification and raise the same `INVALID_CREDENTIALS`
   * (TDS 04 §1.3: "never distinguishes user vs password").
   */
  async login(input: LoginInput, ctx: RequestContext): Promise<LoginResult> {
    const user = await this.#findUserByUsername(input.username);

    if (user === null) {
      await verifyAgainstDecoy(input.password);
      await this.#auditLoginFailed(null, input.username, ctx);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(user.passwordHash, input.password))) {
      await this.#auditLoginFailed(user.id, input.username, ctx);
      throw invalidCredentials();
    }

    const timeoutMinutes = await readSessionTimeoutMinutes(this.#db);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + timeoutMinutes * 60_000);
    const sessionToken = generateSessionToken();
    const authSessionId = newId();

    await this.#db.insert(schema.authSessions).values({
      id: authSessionId,
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      expiresAt,
      lastSeenAt: now,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      entityType: 'users',
      entityId: user.id,
      after: { authMethod: 'cookie', authSessionId, expiresAt: expiresAt.toISOString() },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });

    return {
      user: { id: user.id, username: user.username },
      sessionToken,
      expiresAt,
    };
  }

  /**
   * Resolve a cookie token to a Principal, applying the idle timeout from
   * `security.sessionTimeoutMinutes` (TDS 04 §1.4) and sliding it forward on activity.
   * Returns `null` for absent, unknown, or expired sessions — the caller never learns which.
   */
  async authenticateSessionToken(token: string): Promise<Principal | null> {
    const tokenHash = hashToken(token);

    const rows = await this.#db
      .select({
        id: schema.authSessions.id,
        tokenHash: schema.authSessions.tokenHash,
        expiresAt: schema.authSessions.expiresAt,
        lastSeenAt: schema.authSessions.lastSeenAt,
        userId: schema.users.id,
        username: schema.users.username,
      })
      .from(schema.authSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
      .where(eq(schema.authSessions.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    // Indexed lookup found the row; this is the decision (see `timingSafeHexEquals`).
    if (!timingSafeHexEquals(row.tokenHash, tokenHash)) return null;

    const now = this.#now();
    if (row.expiresAt.getTime() <= now.getTime()) {
      // Opportunistic sweep: an expired session has no further use and must not linger as a
      // credential-shaped row. The scheduled sweep (ix_auth_sessions_expires_at) is WS1's.
      await this.#db.delete(schema.authSessions).where(eq(schema.authSessions.id, row.id));
      return null;
    }

    const expiresAt = await this.#touchSession(row.id, row.lastSeenAt, row.expiresAt, now);

    return {
      userId: row.userId,
      username: row.username,
      authMethod: 'cookie',
      scopes: ['full'],
      authSession: { id: row.id, expiresAt },
      apiToken: null,
    };
  }

  /** `POST /api/v1/auth/logout` — invalidates the server-side session (TDS 04 §3.1). */
  async logout(principal: Principal, ctx: RequestContext): Promise<void> {
    if (principal.authSession !== null) {
      await this.#db
        .delete(schema.authSessions)
        .where(eq(schema.authSessions.id, principal.authSession.id));
    }

    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: principal.userId,
      action: 'auth.logout',
      entityType: 'users',
      entityId: principal.userId,
      after: {
        ...auditActorContext(principal),
        ...(principal.authSession === null ? {} : { authSessionId: principal.authSession.id }),
      },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });
  }

  /**
   * `POST /api/v1/auth/password` (TDS 04 §3.1, PRD §4.4.6). Invalidates all *other*
   * server-side sessions; the caller's own session survives so the SPA is not logged out by
   * its own success.
   */
  async changePassword(
    principal: Principal,
    input: { readonly currentPassword: string; readonly newPassword: string },
    ctx: RequestContext,
  ): Promise<void> {
    const rows = await this.#db
      .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, principal.userId))
      .limit(1);

    const user = rows[0];
    if (user === undefined) throw invalidCredentials();

    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      await recordAuditEntry(this.#db, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'auth.password_change_failed',
        entityType: 'users',
        entityId: principal.userId,
        after: { ...auditActorContext(principal), reason: 'invalid_credentials' },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
      throw invalidCredentials();
    }

    try {
      assertPasswordPolicy(input.newPassword);
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new ApiError('VALIDATION_FAILED', error.message, { field: 'newPassword' });
      }
      throw error;
    }

    const passwordHash = await hashPassword(input.newPassword);
    const now = this.#now();

    await this.#db
      .update(schema.users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(schema.users.id, principal.userId));

    const keptSessionId = principal.authSession?.id ?? null;
    const invalidated = await this.#db
      .delete(schema.authSessions)
      .where(
        keptSessionId === null
          ? eq(schema.authSessions.userId, principal.userId)
          : and(
              eq(schema.authSessions.userId, principal.userId),
              ne(schema.authSessions.id, keptSessionId),
            ),
      )
      .returning({ id: schema.authSessions.id });

    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: principal.userId,
      action: 'auth.password_changed',
      entityType: 'users',
      entityId: principal.userId,
      after: { ...auditActorContext(principal), invalidatedSessionCount: invalidated.length },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });
  }

  // ------------------------------------------------------------------ bearer auth (§3.3)

  /**
   * Resolve `Authorization: Bearer mct_<token>` to a Principal. Revoked, expired and unknown
   * tokens are indistinguishable to the caller — all `null`, all `401 UNAUTHORIZED`.
   */
  async authenticateBearerToken(token: string): Promise<Principal | null> {
    if (!looksLikeApiToken(token)) return null;

    const tokenHash = hashToken(token);
    const now = this.#now();

    const rows = await this.#db
      .select({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        tokenHash: schema.apiTokens.tokenHash,
        scopes: schema.apiTokens.scopes,
        lastUsedAt: schema.apiTokens.lastUsedAt,
        expiresAt: schema.apiTokens.expiresAt,
        revokedAt: schema.apiTokens.revokedAt,
        userId: schema.users.id,
        username: schema.users.username,
      })
      .from(schema.apiTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
      .where(eq(schema.apiTokens.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    if (!timingSafeHexEquals(row.tokenHash, tokenHash)) return null;

    // Revocation is `revoked_at`, not deletion (TDS 03 §3.3) — the audit trail keeps its
    // referent, so the row still exists and this check is what makes it powerless.
    if (row.revokedAt !== null) return null;
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;

    await this.#touchApiToken(row.id, row.lastUsedAt, now);

    return {
      userId: row.userId,
      username: row.username,
      authMethod: 'token',
      scopes: row.scopes.filter(isApiTokenScope),
      authSession: null,
      apiToken: { id: row.id, name: row.name },
    };
  }

  async createApiToken(
    principal: Principal,
    input: CreateApiTokenInput,
    ctx: RequestContext,
  ): Promise<CreatedApiToken> {
    const scopes: readonly ApiTokenScope[] =
      input.scopes === undefined || input.scopes.length === 0 ? ['full'] : input.scopes;

    const token = generateApiToken();
    const id = newId();
    const now = this.#now();
    const expiresAt = input.expiresAt ?? null;

    const inserted = await this.#db
      .insert(schema.apiTokens)
      .values({
        id,
        userId: principal.userId,
        name: input.name,
        tokenHash: hashToken(token),
        tokenPrefix: apiTokenPrefix(token),
        scopes: [...scopes],
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        prefix: schema.apiTokens.tokenPrefix,
        scopes: schema.apiTokens.scopes,
        lastUsedAt: schema.apiTokens.lastUsedAt,
        expiresAt: schema.apiTokens.expiresAt,
        createdAt: schema.apiTokens.createdAt,
      });

    const row = inserted[0];
    /* c8 ignore next */
    if (row === undefined) throw new ApiError('INTERNAL', 'Token insert returned no row');

    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: principal.userId,
      action: 'token.created',
      entityType: 'api_tokens',
      entityId: id,
      after: {
        ...auditActorContext(principal),
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
      },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });

    return { ...toApiTokenView(row), token };
  }

  /**
   * Active tokens, oldest first (ascending UUIDv7 `id` — the F5.3/§1.2 default ordering key).
   * Revoked tokens are excluded: the list shape in TDS 04 §3.2 has no `revokedAt` field, so a
   * revoked row would be indistinguishable from a live one on the wire.
   */
  async listApiTokens(
    principal: Principal,
    options: { readonly limit: number; readonly afterId?: string | undefined },
  ): Promise<ApiTokenView[]> {
    const conditions = [
      eq(schema.apiTokens.userId, principal.userId),
      isNull(schema.apiTokens.revokedAt),
    ];
    if (options.afterId !== undefined) {
      conditions.push(gt(schema.apiTokens.id, options.afterId));
    }

    const rows = await this.#db
      .select({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        prefix: schema.apiTokens.tokenPrefix,
        scopes: schema.apiTokens.scopes,
        lastUsedAt: schema.apiTokens.lastUsedAt,
        expiresAt: schema.apiTokens.expiresAt,
        createdAt: schema.apiTokens.createdAt,
      })
      .from(schema.apiTokens)
      .where(and(...conditions))
      .orderBy(asc(schema.apiTokens.id))
      .limit(options.limit);

    return rows.map(toApiTokenView);
  }

  /** `DELETE /api/v1/auth/tokens/{id}` → 204, `NOT_FOUND` when unknown or already revoked. */
  async revokeApiToken(principal: Principal, tokenId: string, ctx: RequestContext): Promise<void> {
    const now = this.#now();

    const revoked = await this.#db
      .update(schema.apiTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.apiTokens.id, tokenId),
          eq(schema.apiTokens.userId, principal.userId),
          isNull(schema.apiTokens.revokedAt),
        ),
      )
      .returning({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        prefix: schema.apiTokens.tokenPrefix,
        scopes: schema.apiTokens.scopes,
      });

    const row = revoked[0];
    if (row === undefined) throw new ApiError('NOT_FOUND', `No API token with id ${tokenId}`);

    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: principal.userId,
      action: 'token.revoked',
      entityType: 'api_tokens',
      entityId: row.id,
      before: { name: row.name, prefix: row.prefix, scopes: row.scopes, revokedAt: null },
      after: { ...auditActorContext(principal), revokedAt: now.toISOString() },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });
  }

  // ------------------------------------------------------------------------- internals

  async #findUserByUsername(
    username: string,
  ): Promise<{ id: string; username: string; passwordHash: string } | null> {
    const rows = await this.#db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      // Matches ux_users_username_lower (TDS 03 §3.1): usernames are case-insensitive.
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
      .limit(1);

    return rows[0] ?? null;
  }

  async #auditLoginFailed(
    userId: string | null,
    attemptedUsername: string,
    ctx: RequestContext,
  ): Promise<void> {
    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: userId,
      action: 'auth.login_failed',
      entityType: 'users',
      entityId: userId,
      // The attempted username is not a secret and is the only forensic value here; the
      // password never appears in an audit row, a log line or an error `details`.
      after: {
        username: attemptedUsername,
        reason: userId === null ? 'unknown_user' : 'invalid_password',
      },
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });
  }

  /** Slide the idle timeout forward, at most once per `TOUCH_INTERVAL_MS`. */
  async #touchSession(
    id: string,
    lastSeenAt: Date | null,
    currentExpiresAt: Date,
    now: Date,
  ): Promise<Date> {
    if (lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < TOUCH_INTERVAL_MS) {
      return currentExpiresAt;
    }

    const timeoutMinutes = await readSessionTimeoutMinutes(this.#db);
    const expiresAt = new Date(now.getTime() + timeoutMinutes * 60_000);

    await this.#db
      .update(schema.authSessions)
      .set({ lastSeenAt: now, expiresAt, updatedAt: now })
      .where(eq(schema.authSessions.id, id));

    return expiresAt;
  }

  async #touchApiToken(id: string, lastUsedAt: Date | null, now: Date): Promise<void> {
    if (lastUsedAt !== null && now.getTime() - lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;

    await this.#db
      .update(schema.apiTokens)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(schema.apiTokens.id, id));
  }
}

function toApiTokenView(row: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter(isApiTokenScope),
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** One message for both failure modes (TDS 04 §1.3). */
function invalidCredentials(): ApiError {
  return new ApiError('INVALID_CREDENTIALS', 'Invalid username or password');
}
