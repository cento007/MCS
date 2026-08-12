/**
 * Origin allowlist for the WebSocket upgrade — TDS 04 §14.2, closing WS0 sign-off finding #3.
 *
 * WHY THIS FILE EXISTS. `SameSite=Lax` does not apply to WebSocket handshakes: a browser will
 * happily attach `mc_session` to `new WebSocket('ws://127.0.0.1:8710/api/v1/ws')` opened from
 * `https://evil.example`. Without an Origin check, any page the operator visits can open an
 * authenticated duplex channel into Mission Control, subscribe to every Session, read the live
 * transcript, and submit prompts. That is cross-site WebSocket hijacking, and the allowlist
 * below is the whole defense — there is no second control behind it.
 *
 * Matching is EXACT on normalised origins (scheme + host + port). No wildcards, no suffix
 * matching: `https://evil-mission-control.example` must never match because it ends with a
 * trusted string, and `*.` rules are how that mistake gets made.
 *
 * The operator-editable half of the list lives in the database as `security.allowedOrigins`
 * (§7.2, registry key `('security', 'allowed_origins')`), NOT in the environment — sanctioned
 * deviation D7 keeps the F8.2 bootstrap variable set locked.
 */

/** Vite's default dev-server port (§14.2 item 2). */
const VITE_DEV_PORT = 5173;

/** Hosts that mean "this machine" when they appear in `MC_HOST`. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

/** Bind-any addresses: they are not origins themselves, but they do serve the loopback ones. */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '*']);

/**
 * Normalise an `Origin` header (or an allowlist entry) to `scheme://host[:port]`.
 *
 * Returns `null` for anything that is not an http(s) origin — which includes the literal
 * `"null"` that browsers send for sandboxed iframes, `data:` documents and some redirect
 * chains. §14.2 requires `Origin: null` to be rejected, and rejecting it falls out of this
 * function rather than needing a special case at the call site.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;

  // `URL.origin` already collapses the default port (`http://x:80` -> `http://x`) and
  // lower-cases scheme and host. Both sides of every comparison go through this function, so
  // the "exact port" rule in §14.2 is exact on a canonical form rather than on raw text.
  const origin = url.origin;
  return origin === 'null' ? null : origin;
}

function hostForUrl(host: string): string {
  // Bare IPv6 literals need brackets before they can be parsed as a URL authority.
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function addOrigin(target: Set<string>, candidate: string): void {
  const normalized = normalizeOrigin(candidate);
  if (normalized !== null) target.add(normalized);
}

export interface DeriveServerOriginsInput {
  /** `MC_HOST` (F8.2). */
  readonly host: string;
  /** `MC_PORT` (F8.2). */
  readonly port: number;
  /** `NODE_ENV=development` — adds the Vite dev-server origin (§14.2 item 2). */
  readonly isDevelopment: boolean;
}

/**
 * The config-derived half of the allowlist (§14.2 items 1–2). Computed once at startup: it
 * depends only on bootstrap config, which cannot change without a restart.
 *
 * Both schemes are emitted for the bound host. V1 is plain HTTP on loopback (sanctioned
 * deviation D10), but an operator who terminates TLS on the same host:port is serving the
 * same application and must not be locked out of their own dashboard by this file.
 *
 * A wildcard bind (`0.0.0.0`) contributes only the loopback aliases: when the dashboard is
 * reached over the LAN the browser sends `Origin: http://192.168.x.y:8710`, an address this
 * process cannot enumerate. That case is exactly what `security.allowedOrigins` is for.
 */
export function deriveServerOrigins(input: DeriveServerOriginsInput): ReadonlySet<string> {
  const origins = new Set<string>();
  const host = input.host.trim().toLowerCase();
  const isWildcard = WILDCARD_HOSTS.has(host);

  if (!isWildcard) {
    addOrigin(origins, `http://${hostForUrl(host)}:${input.port}`);
    addOrigin(origins, `https://${hostForUrl(host)}:${input.port}`);
  }

  if (isWildcard || LOOPBACK_HOSTS.has(host)) {
    for (const loopback of ['localhost', '127.0.0.1', '[::1]']) {
      addOrigin(origins, `http://${loopback}:${input.port}`);
      addOrigin(origins, `https://${loopback}:${input.port}`);
    }
  }

  if (input.isDevelopment) {
    // §14.2 names `http://localhost:5173`. `127.0.0.1` is added alongside it because Vite
    // binds both and a developer who typed the IP would otherwise hit a security rejection
    // that looks exactly like a bug.
    addOrigin(origins, `http://localhost:${VITE_DEV_PORT}`);
    addOrigin(origins, `http://127.0.0.1:${VITE_DEV_PORT}`);
  }

  return origins;
}

export interface OriginAllowlistOptions extends DeriveServerOriginsInput {
  /**
   * Reads `security.allowedOrigins` (§7.2). A port rather than a `Db` handle: the allowlist
   * is then unit-testable with no database, which is what keeps the hijacking tests in the
   * `pnpm test` tier where they get run on every change.
   */
  readonly readConfiguredOrigins: () => Promise<readonly string[]>;
  /**
   * Upper bound on how stale the DB half may be. §14.2 says "recomputed on `setting.updated`
   * for `security`" and `invalidate()` is that path; the TTL is the backstop for a
   * `setting.updated` that never arrives (worker-side write, missed NOTIFY, restart race).
   */
  readonly cacheTtlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Invoked when the DB read fails. See the fail-mode note on `entries()`. */
  readonly onReadError?: ((error: unknown) => void) | undefined;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

export class OriginAllowlist {
  /** §14.2 items 1–2. Fixed for the process lifetime. */
  readonly derived: ReadonlySet<string>;

  readonly #readConfiguredOrigins: () => Promise<readonly string[]>;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #onReadError: (error: unknown) => void;

  #cached: ReadonlySet<string> | null = null;
  #cachedAt = 0;
  #inFlight: Promise<ReadonlySet<string>> | null = null;

  constructor(options: OriginAllowlistOptions) {
    this.derived = deriveServerOrigins(options);
    this.#readConfiguredOrigins = options.readConfiguredOrigins;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#onReadError = options.onReadError ?? (() => {});
  }

  /** Drop the cached DB half. Called from the `setting.updated` (category `security`) path. */
  invalidate(): void {
    this.#cached = null;
    this.#inFlight = null;
  }

  /**
   * The effective allowlist.
   *
   * FAIL MODE: if the settings read throws (database down mid-flight), the derived origins are
   * used alone. That is fail-closed in the direction that matters — the DB half can only ever
   * *add* origins, so a failed read can never admit an origin that was not already trusted;
   * it can only lock out a reverse-proxy hostname while PostgreSQL is unavailable, which is a
   * moment when the dashboard has nothing to show anyway.
   */
  async entries(): Promise<ReadonlySet<string>> {
    const cached = this.#cached;
    if (cached !== null && this.#now() - this.#cachedAt < this.#cacheTtlMs) return cached;

    // Collapse concurrent misses: a burst of reconnects after a restart must not become a
    // burst of identical settings queries.
    this.#inFlight ??= this.#load();
    return await this.#inFlight;
  }

  async #load(): Promise<ReadonlySet<string>> {
    const entries = new Set(this.derived);
    try {
      for (const configured of await this.#readConfiguredOrigins()) {
        addOrigin(entries, configured);
      }
    } catch (error) {
      this.#onReadError(error);
    }

    this.#cached = entries;
    this.#cachedAt = this.#now();
    this.#inFlight = null;
    return entries;
  }

  /**
   * The §14.2 decision for a present `Origin` header. `undefined`/absent is NOT handled here:
   * that case is an authentication rule (cookie refused, bearer required), and it lives with
   * the other authentication rules in `index.ts`.
   */
  async isAllowed(origin: string): Promise<boolean> {
    const normalized = normalizeOrigin(origin);
    if (normalized === null) return false;
    return (await this.entries()).has(normalized);
  }
}
