import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { safeEquals } from '@mc/shared';

/**
 * Opaque credential material: the `mc_session` cookie token and `mct_` bearer API tokens
 * (F5.5, TDS 03 §3.2/§3.3).
 *
 * Both are high-entropy random strings that exist in plaintext exactly once — in the response
 * that issues them. Storage is the SHA-256 hex digest, so a database dump yields nothing an
 * attacker can present. SHA-256 (not Argon2id) is correct here precisely because these are
 * 256-bit random values, not human-chosen secrets: there is no dictionary to slow down, and
 * a fast digest is what makes a per-request lookup viable.
 */

/** 32 bytes = 256 bits of entropy, base64url-encoded to 43 URL/cookie-safe characters. */
const TOKEN_ENTROPY_BYTES = 32;

/** TDS 04 §1.4: `Authorization: Bearer mct_<token>`. */
export const API_TOKEN_PREFIX = 'mct_';

/** TDS 03 §3.3 `token_prefix` — "first 8 chars, for identification in the UI". */
export const API_TOKEN_PREFIX_LENGTH = 8;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
}

/** The stored form of any opaque credential: lowercase SHA-256 hex of the presented string. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Display prefix for an API token — the first 8 characters of the token as issued, i.e.
 * `mct_` plus four characters of the random part (WS5 §5.7.11 renders it as `‹mct_a1b2…›`).
 */
export function apiTokenPrefix(token: string): string {
  return token.slice(0, API_TOKEN_PREFIX_LENGTH);
}

/** Cheap shape gate before any database work. Never a security decision on its own. */
export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length > API_TOKEN_PREFIX_LENGTH;
}

/**
 * Constant-time comparison of two SHA-256 hex digests.
 *
 * Timing-safe **by construction**, not by measurement: the comparison is delegated to
 * `crypto.timingSafeEqual` (via `safeEquals` in `@mc/shared`), which is branch-free over the
 * byte content. The only early return is on *length*, which for two fixed-width SHA-256
 * digests carries no information about either value — a length mismatch means the input was
 * not a digest at all.
 *
 * This exists even though the primary lookup is an indexed equality on `token_hash`: the
 * database comparison is `memcmp`-shaped and short-circuits, so the app-side check is what
 * makes the final accept/reject decision constant-time regardless of how the row was found.
 */
export function timingSafeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  // Non-hex input decodes short; comparing raw bytes of unequal length would throw.
  if (left.byteLength !== right.byteLength) return false;
  return safeEquals(left, right);
}
