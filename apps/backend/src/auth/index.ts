/**
 * `auth/` — local account login, DB-backed sessions, cookie issuance, bearer API tokens
 * (F5.5); password hashing with argon2id (TDS 02 §2, TDS 03 §3.1).
 *
 * SCAFFOLD STATE: directory placeholder. Nothing here is implemented.
 *
 * What lands here (owner: WS1, contract: TDS 04 §3):
 *   - `POST /api/v1/auth/login` -> `mc_session` HTTP-only, SameSite=Lax cookie backed by
 *     an `auth_sessions` row (TDS 03 §3.2); the cookie carries an opaque random token and
 *     only its SHA-256 hash is stored
 *   - bearer API tokens `Authorization: Bearer mct_<token>`, hashed at rest, scopes
 *     `full` | `ingest` (TDS 03 §3.3) — `ingest` is limited to `POST /api/v1/hook-events`
 *   - request guards used by `http/`; there is no RBAC in V1 (single local user)
 *   - audit rows for login success/failure, logout, token create/revoke (TDS 03 §3.14)
 */
export {};
