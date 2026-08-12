/**
 * The authenticated caller (F5.5, TDS 04 §1.4).
 *
 * Two principals, **one User**: the browser session cookie and a bearer API token both
 * resolve to the single local account (F4.1). `authMethod` records how the caller proved it,
 * which is what `GET /api/v1/auth/me` reports and what the audit rule in TDS 04 §12 keys off:
 * a token-authenticated call is still `actorType: 'user'`, with the token named in the entry
 * payload — there is no `'token'` actor.
 */

export const API_TOKEN_SCOPES = ['full', 'ingest'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === 'string' && (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

export type AuthMethod = 'cookie' | 'token';

export interface Principal {
  readonly userId: string;
  readonly username: string;
  readonly authMethod: AuthMethod;
  /**
   * A cookie session carries `['full']`: TDS 04 §1.4 scopes only exist for API tokens, and
   * the browser session is the operator with the entire API available to them.
   */
  readonly scopes: readonly ApiTokenScope[];
  /** Present for `authMethod: 'cookie'` only. */
  readonly authSession: { readonly id: string; readonly expiresAt: Date } | null;
  /** Present for `authMethod: 'token'` only. */
  readonly apiToken: { readonly id: string; readonly name: string } | null;
}

/** `full` grants the entire API (TDS 04 §1.4), so it satisfies every scope requirement. */
export function hasScope(principal: Principal, required: ApiTokenScope): boolean {
  return principal.scopes.includes('full') || principal.scopes.includes(required);
}

/**
 * The audit payload fragment that identifies the acting token (TDS 04 §12): `apiTokenId` /
 * `apiTokenName`, **never the token value**. Empty for cookie auth.
 */
export function auditActorContext(principal: Principal): Record<string, unknown> {
  if (principal.apiToken === null) return { authMethod: principal.authMethod };
  return {
    authMethod: principal.authMethod,
    apiTokenId: principal.apiToken.id,
    apiTokenName: principal.apiToken.name,
  };
}
