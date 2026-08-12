/**
 * Identity and access: `users`, `auth_sessions`, `api_tokens` (TDS 03 §3.1–§3.3).
 *
 * `auth_sessions` is named to avoid any collision with the domain `sessions` entity
 * (F9.5 vocabulary discipline). No plaintext credential is stored anywhere here:
 * `password_hash` is an Argon2id encoded string, cookie and API tokens are SHA-256 hashes.
 */

import { sql } from 'drizzle-orm';
import { check, index, inet, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';

/** WS2 §3.3 token scopes. `ingest` may call only `POST /api/v1/hook-events` (TDS 03 §3.3). */
const API_TOKEN_SCOPES = ['full', 'ingest'] as const;

/**
 * Single local account in V1 (F4.1), but a real table for future OIDC.
 * `password_hash` stores the full encoded Argon2id string — hashing is app-layer (PRD §10).
 */
export const users = pgTable(
  'users',
  {
    id: primaryKeyId(),
    username: text('username').notNull(),
    /** Argon2id encoded string (algorithm/params/salt/hash). */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_users_username_length', sql`length(${table.username}) BETWEEN 1 AND 64`),
    uniqueIndex('ux_users_username_lower').on(sql`lower(${table.username})`),
  ],
);

/**
 * Server-side login sessions referenced by the HTTP-only cookie (F5.5).
 * The cookie carries an opaque random token; only its SHA-256 hash is stored.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: primaryKeyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 hex of the cookie token. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('ux_auth_sessions_token_hash').on(table.tokenHash),
    index('ix_auth_sessions_user_id').on(table.userId),
    /** Expiry sweep job. */
    index('ix_auth_sessions_expires_at').on(table.expiresAt),
  ],
);

/**
 * Bearer tokens for programmatic access, hashed at rest (F5.5, PRD §4.4.6).
 * Revocation is `revoked_at`, not deletion, so the audit trail keeps its referent.
 *
 * `scopes` is `text[]` and not a scalar: the API shape is a set and
 * `'ingest' = ANY(scopes)` is the authorization predicate (TDS 03 §3.3, finding B8).
 * No index on `scopes` — authorization reads the row by `token_hash` first.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: primaryKeyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sha256 hex; the plaintext is shown once at creation and never stored. */
    tokenHash: text('token_hash').notNull(),
    /** First 8 chars, for identification in the UI. */
    tokenPrefix: text('token_prefix').notNull(),
    /** WS2 §3.3; the default matches the API default. */
    scopes: text('scopes').array().notNull().default(['full']),
    lastUsedAt: timestamptz('last_used_at'),
    /** NULL = no expiry. */
    expiresAt: timestamptz('expires_at'),
    /** NULL = active. */
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_api_tokens_name_length', sql`length(${table.name}) BETWEEN 1 AND 100`),
    check(
      'ck_api_tokens_scopes',
      // `cardinality`, not `array_length`: array_length('{}', 1) is NULL, and a CHECK
      // passes on NULL — so the array_length form silently admitted the empty (powerless)
      // token it was written to forbid. cardinality('{}') is 0 and fails the comparison.
      sql`cardinality(${table.scopes}) >= 1 AND ${table.scopes} <@ ARRAY[${valueList(API_TOKEN_SCOPES)}]::text[] AND array_position(${table.scopes}, NULL::text) IS NULL`,
    ),
    uniqueIndex('ux_api_tokens_token_hash').on(table.tokenHash),
    index('ix_api_tokens_user_id').on(table.userId),
  ],
);
