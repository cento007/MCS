import {
  arrayOf,
  entityId,
  nullable,
  nullableTimestamp,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import { API_TOKEN_SCOPES } from './principal.js';

/**
 * The `/api/v1/auth/*` response shapes (TDS 04 §3).
 *
 * These have no `*Resource` interface to bind an `ExactShape` to — the handlers build their
 * envelopes inline from `Principal` and `ApiTokenView` — so the conformance check against real
 * responses is the whole guard here, and `additionalProperties: false` is what makes it two-sided.
 */

export const currentUserSchema = objectSchema('CurrentUser', {
  id: entityId,
  username: stringValue,
});

export const authMeSchema = objectSchema('AuthMe', {
  user: currentUserSchema,
  authMethod: stringEnum(['cookie', 'token']),
  /** `null` under bearer-token auth — a token has no server-side session (§3.1). */
  session: nullable(objectSchema('AuthSession', { expiresAt: timestampValue })),
});

export const loginResultSchema = objectSchema('LoginResult', {
  user: currentUserSchema,
  expiresAt: timestampValue,
});

export const apiTokenSchema = objectSchema('ApiTokenSummary', {
  id: entityId,
  name: stringValue,
  /** The visible `mct_…` prefix; the token itself is hashed at rest and never read back. */
  prefix: stringValue,
  scopes: arrayOf(stringEnum(API_TOKEN_SCOPES)),
  lastUsedAt: nullableTimestamp,
  expiresAt: nullableTimestamp,
  createdAt: timestampValue,
});

/**
 * `POST /auth/tokens` — the summary plus the one and only time the token value exists outside
 * the client's own storage.
 */
export const createdApiTokenSchema = objectSchema('CreatedApiToken', {
  ...apiTokenSchema.properties,
  token: stringValue,
});
