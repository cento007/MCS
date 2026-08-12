import websocketPlugin from '@fastify/websocket';
import type { AppConfig, Db } from '@mc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readCookie, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { FULL_ACCESS_ROUTE } from '../auth/guard.js';
import type { Principal } from '../auth/principal.js';
import type { AuthService } from '../auth/service.js';
import { ApiError } from '../http/errors.js';
import { readAllowedOrigins as readAllowedOriginsSetting } from '../settings/security.js';
import type { HubSocket } from './connection.js';
import { HEARTBEAT_INTERVAL_MS, WebSocketHub } from './hub.js';
import { OriginAllowlist } from './origin.js';
import type { ConnectionCredential, EventBusPort, PromptPort, SessionAccessPort } from './ports.js';
import { TRANSPORT_MAX_PAYLOAD_BYTES, WS_CLOSE, WS_PATH } from './protocol.js';
import { sessionRowAccess } from './session-access.js';

/**
 * `ws/` — the WebSocket hub: one multiplexed connection at `/api/v1/ws` (F5.6, TDS 04 §14).
 *
 * Layout:
 *   protocol.ts       frame vocabulary, limits, close codes, frame parsing (§14.4–§14.6)
 *   channels.ts       channel registry + the event -> channel routing table (§14.3, §15.2)
 *   origin.ts         the Origin allowlist that stops cross-site WebSocket hijacking (§14.2)
 *   connection.ts     one socket: subscriptions, liveness, the backpressure policy
 *   hub.ts            fan-out, subscribe/unsubscribe/prompt handling, heartbeat
 *   ports.ts          the narrow interfaces consumed from events/, sessions/ and auth/
 *   session-access.ts the Phase 1 SessionAccessPort (existence check)
 *   index.ts          this file: Fastify wiring, upgrade authentication, lifecycle
 *
 * The hub is a relay (TDS 02 §2). It holds no business logic, mutates no domain state, and
 * does no replay (F6.3) — clients refetch on reconnect (§14.7).
 */

export * from './channels.js';
export * from './connection.js';
export * from './hub.js';
export * from './origin.js';
export * from './ports.js';
export * from './protocol.js';
export * from './session-access.js';

export interface RegisterWebSocketHubOptions {
  /** Bootstrap config — supplies `MC_HOST`/`MC_PORT`/`NODE_ENV` to the Origin allowlist. */
  readonly config?: AppConfig | undefined;
  /** Supplies the default `sessionAccess` and `readAllowedOrigins` implementations. */
  readonly db?: Db | undefined;
  /**
   * Enables close code `4001` (§14.6): without it a connection is never re-checked against
   * the credential that opened it.
   */
  readonly auth?: AuthService | undefined;
  readonly sessionAccess?: SessionAccessPort | undefined;
  readonly readAllowedOrigins?: (() => Promise<readonly string[]>) | undefined;
  /**
   * In-process F6 fan-out (`events/`). Omitting it yields a hub that serves the whole protocol
   * — upgrades, subscriptions, heartbeats — with no traffic to relay, which is what the unit
   * tier uses.
   */
  readonly bus?: EventBusPort | undefined;
  /**
   * Prompt submission (§6.4). Supplied by the managed-session wrapper; until then `prompt`
   * frames answer `OPERATION_NOT_SUPPORTED` and point at the REST endpoint.
   */
  readonly prompts?: PromptPort | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly originCacheTtlMs?: number | undefined;
  readonly softLimitBytes?: number | undefined;
  readonly hardLimitBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RegisteredWebSocketHub {
  readonly hub: WebSocketHub;
  readonly allowlist: OriginAllowlist;
}

/**
 * Wire the hub into a Fastify instance.
 *
 * Registration order matters and is deliberate:
 *   1. the `preClose` hook goes on BEFORE `@fastify/websocket`, so our 1001 close (§14.6)
 *      runs ahead of the plugin's default "close every client" sweep and clients learn why
 *      the server went away;
 *   2. the plugin, with `maxPayload` as the transport backstop (see `protocol.ts`);
 *   3. the route, inside its own scope so the plugin's `onRoute` transformation is installed
 *      before the route exists.
 */
export function registerWebSocketHub(
  app: FastifyInstance,
  options: RegisterWebSocketHubOptions,
): RegisteredWebSocketHub {
  const sessionAccess = resolveSessionAccess(options);
  const readAllowedOrigins = resolveAllowedOriginsReader(options);
  const auth = options.auth ?? null;

  const allowlist = new OriginAllowlist({
    host: options.config?.host ?? '127.0.0.1',
    port: options.config?.port ?? 8710,
    isDevelopment: options.config?.isDevelopment ?? false,
    readConfiguredOrigins: readAllowedOrigins,
    cacheTtlMs: options.originCacheTtlMs,
    onReadError: (error) => {
      app.log.error(
        { err: error },
        'failed to read security.allowedOrigins; using derived origins',
      );
    },
  });

  const hub = new WebSocketHub({
    log: app.log,
    sessionAccess,
    prompts: options.prompts,
    now: options.now,
    softLimitBytes: options.softLimitBytes,
    hardLimitBytes: options.hardLimitBytes,
  });

  app.addHook('preClose', async () => {
    hub.closeAll(WS_CLOSE.SERVER_SHUTDOWN, 'server shutting down');
  });

  /**
   * Release the hijacked socket of an upgrade that never completed.
   *
   * `@fastify/websocket` destroys it in its own `onResponse` hook, but only when its
   * `onRequest` hook has run — that hook is what sets `request.ws`. An upgrade rejected by an
   * EARLIER instance-level hook (the auth guard, which by design runs first) short-circuits
   * the chain before the plugin's hook, so its cleanup is skipped and the TCP connection is
   * left open with a written 401/403 on it. Node's HTTP server counts that connection, so
   * `server.close()` then waits for it forever: one unauthenticated upgrade attempt is enough
   * to hang a graceful shutdown, and a cross-site page hammering the endpoint accumulates
   * them. `reply.hijack()` on the success path means this hook never runs for a real upgrade.
   */
  app.addHook('onResponse', async (request) => {
    if (request.routeOptions.url !== WS_PATH) return;
    if (typeof request.raw.headers.upgrade !== 'string') return;
    request.raw.socket.destroy();
  });

  app.register(websocketPlugin, {
    options: { maxPayload: TRANSPORT_MAX_PAYLOAD_BYTES, clientTracking: false },
  });

  app.register(async (scope) => {
    scope.get(
      WS_PATH,
      {
        websocket: true,
        // Explicit rather than inherited: this endpoint carries every live Session's
        // transcript, and "authenticated, `full` scope, cookie allowed" should be readable at
        // the route, not inferred from a default three files away. `full` is also what makes
        // §14.1's "ingest-scoped tokens are rejected (403)" true — the guard enforces it.
        config: { auth: FULL_ACCESS_ROUTE },
        onRequest: async (request) => {
          await enforceUpgradePolicy(request, allowlist);
        },
      },
      (socket, request) => {
        const principal = request.principal;
        /* c8 ignore next 4 — unreachable: the guard rejects before the handler runs. */
        if (principal === null) {
          socket.close(WS_CLOSE.AUTH_EXPIRED, 'unauthenticated');
          return;
        }

        const credential = createCredential(request, principal, auth);
        const connection = hub.accept({
          socket: toHubSocket(socket),
          principal,
          log: request.log,
          ...(credential === null ? {} : { credential }),
        });

        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          hub.handleMessage(connection, toBuffer(data), isBinary);
        });
        socket.on('pong', () => {
          hub.handlePong(connection);
        });
        socket.on('close', () => {
          hub.handleClose(connection);
        });
        socket.on('error', (error) => {
          request.log.debug({ err: error, connectionId: connection.id }, 'websocket error');
          hub.handleClose(connection);
        });
      },
    );
  });

  if (options.bus !== undefined) {
    const unsubscribe = options.bus.subscribeAll((event) => {
      // §14.2: the allowlist is recomputed when the `security` settings change. Doing it here
      // rather than in `settings/` keeps the invalidation next to the thing it protects.
      if (event.type === 'setting.updated' && event.payload['category'] === 'security') {
        allowlist.invalidate();
      }
      hub.publish(event);
    });
    app.addHook('onClose', async () => {
      unsubscribe();
    });
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let heartbeat: NodeJS.Timeout | null = null;

  app.addHook('onReady', async () => {
    heartbeat = setInterval(() => {
      hub.tick();
    }, heartbeatIntervalMs);
    // The heartbeat must never be the reason a process stays alive: F8.1 requires the app to
    // exit on its own when its work is done, identically under a console and under systemd.
    heartbeat.unref();
  });

  app.addHook('onClose', async () => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  });

  return { hub, allowlist };
}

/**
 * The §14.2 enforcement table, applied at upgrade — the whole cross-site WebSocket hijacking
 * defense.
 *
 * | `Origin` present, allowlisted     | proceed (cookie or bearer)                    |
 * | `Origin` present, not allowlisted | 403 `ORIGIN_NOT_ALLOWED` (includes `null`)    |
 * | `Origin` absent (non-browser)     | bearer only; cookie auth is refused with 401  |
 *
 * ORDERING NOTE. This runs *after* the global auth guard (Fastify runs instance-level
 * `onRequest` hooks before route-level ones), so a cross-site upgrade carrying a valid cookie
 * is authenticated first and rejected here with 403 — before the upgrade completes, which is
 * what §14.2 requires. The one visible consequence is that such a request still slides the
 * session's idle timeout the same way any cross-origin credentialed GET already does; it
 * discloses nothing and completes no upgrade.
 */
async function enforceUpgradePolicy(
  request: FastifyRequest,
  allowlist: OriginAllowlist,
): Promise<void> {
  const origin = request.headers.origin;

  if (origin === undefined || origin.length === 0) {
    // No Origin means no browser — or a browser that has been talked into hiding it. Either
    // way the cookie is not usable as proof of intent here, so this path demands a bearer
    // token, which no cross-site page can obtain.
    if (request.principal?.authMethod === 'token') return;
    request.log.warn(
      { requestId: request.id },
      'websocket upgrade without Origin refused cookie auth',
    );
    throw new ApiError(
      'UNAUTHORIZED',
      'A WebSocket upgrade without an Origin header requires a bearer API token',
    );
  }

  if (await allowlist.isAllowed(origin)) return;

  request.log.warn(
    { requestId: request.id, origin },
    'websocket upgrade rejected: origin not allowed',
  );
  throw new ApiError('ORIGIN_NOT_ALLOWED', 'This Origin is not allowed to open a WebSocket', {
    origin: origin.slice(0, 256),
  });
}

/**
 * Capture the credential that authorised this upgrade so it can be re-checked (§14.6, close
 * `4001`).
 *
 * The raw token is retained in memory for the connection's lifetime. That is a deliberate,
 * bounded trade: it is the same value the peer already holds and the same value the process
 * saw at upgrade, it is never logged or serialised, and without it a logout in another tab
 * would leave a live transcript stream running until the socket happened to drop.
 */
function createCredential(
  request: FastifyRequest,
  principal: Principal,
  auth: AuthService | null,
): ConnectionCredential | null {
  if (auth === null) return null;

  if (principal.authMethod === 'cookie') {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    if (token === null) return null;
    return {
      expiresAt: principal.authSession?.expiresAt ?? null,
      revalidate: async () => {
        const refreshed = await auth.authenticateSessionToken(token);
        return refreshed === null
          ? { valid: false }
          : { valid: true, expiresAt: refreshed.authSession?.expiresAt ?? null };
      },
    };
  }

  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
  const token = match?.[1]?.trim();
  if (token === undefined || token.length === 0) return null;
  return {
    expiresAt: null,
    revalidate: async () => {
      const refreshed = await auth.authenticateBearerToken(token);
      return refreshed === null ? { valid: false } : { valid: true, expiresAt: null };
    },
  };
}

function resolveSessionAccess(options: RegisterWebSocketHubOptions): SessionAccessPort {
  if (options.sessionAccess !== undefined) return options.sessionAccess;
  if (options.db !== undefined) return sessionRowAccess(options.db);
  throw new Error('registerWebSocketHub requires either `sessionAccess` or `db`');
}

function resolveAllowedOriginsReader(
  options: RegisterWebSocketHubOptions,
): () => Promise<readonly string[]> {
  if (options.readAllowedOrigins !== undefined) return options.readAllowedOrigins;
  const db = options.db;
  if (db !== undefined) return async () => await readAllowedOriginsSetting(db);
  throw new Error('registerWebSocketHub requires either `readAllowedOrigins` or `db`');
}

/**
 * Adapt a `ws` socket to the hub's transport interface. The indirection is what lets every
 * liveness and backpressure rule be unit tested with no sockets at all (TDS 07 §2.1).
 */
function toHubSocket(socket: {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly OPEN: number;
  send(payload: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}): HubSocket {
  return {
    bufferedAmount: () => socket.bufferedAmount,
    isOpen: () => socket.readyState === socket.OPEN,
    send: (payload) => {
      socket.send(payload);
    },
    ping: () => {
      socket.ping();
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
    terminate: () => {
      socket.terminate();
    },
  };
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
