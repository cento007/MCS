/**
 * The `mc_session` cookie (F5.5, TDS 04 §1.4): HTTP-only, `SameSite=Lax`, `Path=/`,
 * `Secure` when the request was served over HTTPS.
 *
 * Hand-rolled rather than pulling in a cookie plugin, and the reason is the value itself:
 * this system sets exactly one cookie, whose value is base64url (`A–Z a–z 0–9 - _`) and
 * therefore needs no percent-encoding, and whose attribute set is fixed by contract. The
 * whole surface is the two functions below plus an exact-name lookup — a dependency here
 * would add supply-chain surface for a code path that has no variability to absorb.
 *
 * `SameSite=Lax` is the primary CSRF control for REST (TDS 04 §14.2); it does NOT protect
 * WebSocket upgrades, which is why that path additionally enforces an Origin allowlist. That
 * enforcement belongs to `ws/` and is not implemented here.
 */

export const SESSION_COOKIE_NAME = 'mc_session';

const COOKIE_PATH = '/';

export interface SessionCookieOptions {
  /**
   * `Secure` per TDS 04 §1.4 ("`Secure` when served over HTTPS"). Never hardcoded: V1 binds
   * `127.0.0.1` over plain HTTP by sanctioned deviation D10, so a hardcoded `Secure` would
   * make login impossible on the very deployment the PRD describes, and a hardcoded absence
   * would silently weaken an operator who *has* put TLS in front of it.
   */
  readonly secure: boolean;
  /** Cookie lifetime in seconds; matches the `auth_sessions.expires_at` it refers to. */
  readonly maxAgeSeconds: number;
}

export function serializeSessionCookie(token: string, options: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Expire the cookie immediately. Attributes must match the ones used to set it. */
export function serializeClearedSessionCookie(options: { readonly secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    `Path=${COOKIE_PATH}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Read one cookie by exact name from a `Cookie` request header.
 *
 * Exact name match on the trimmed key — no prefix or suffix matching, so `not_mc_session=…`
 * or `mc_session_x=…` can never be read as the session cookie. When a client sends the same
 * name twice (a stale cookie from a different path), the FIRST value wins and the request
 * either authenticates with it or is rejected; trying alternatives in turn would let an
 * attacker who can set a cookie on the browser append candidates for free.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) return null;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;

    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
