import { newId } from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FULL_ACCESS_ROUTE } from '../auth/guard.js';
import type { Principal } from '../auth/principal.js';
import { ApiError, type ErrorEnvelope } from '../http/errors.js';
import { registerHttpConventions } from '../http/index.js';
import { registerWebSocketHub } from './index.js';
import { WS_PATH } from './protocol.js';
import { allowAllSessionAccess } from './session-access.js';

/**
 * The upgrade handshake (TDS 04 §14.1–§14.2) driven through a real Fastify instance, with the
 * authentication guard stubbed to a fixed Principal so the tier stays database-free.
 *
 * The equivalent end-to-end test — real login, real `mc_session` cookie, real socket — is in
 * `ws.int.test.ts`. Both exist deliberately: this file is what runs on every commit, and the
 * Origin rule is the one control standing between a hostile page and every live transcript.
 */

const HOST = '127.0.0.1';
const PORT = 8710;
const OWN_ORIGIN = `http://${HOST}:${PORT}`;

const cookiePrincipal: Principal = {
  userId: newId(),
  username: 'operator',
  authMethod: 'cookie',
  scopes: ['full'],
  authSession: { id: newId(), expiresAt: new Date(Date.now() + 3_600_000) },
  apiToken: null,
};

const tokenPrincipal: Principal = {
  userId: cookiePrincipal.userId,
  username: 'operator',
  authMethod: 'token',
  scopes: ['full'],
  authSession: null,
  apiToken: { id: newId(), name: 'cli' },
};

let openApps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  openApps = [];
});

function buildApp(
  options: {
    principal?: Principal | null;
    allowedOrigins?: readonly string[];
    isDevelopment?: boolean;
  } = {},
): FastifyInstance {
  const principal = options.principal === undefined ? cookiePrincipal : options.principal;
  const app = Fastify({ logger: false });
  registerHttpConventions(app);

  // Stands in for `registerAuth`'s guard: an instance-level `onRequest` hook, registered
  // before the hub, exactly as `app.ts` orders them.
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === undefined) return;
    if (principal === null) throw new ApiError('UNAUTHORIZED', 'Authentication required');
    request.principal = principal;
  });

  registerWebSocketHub(app, {
    sessionAccess: allowAllSessionAccess(),
    readAllowedOrigins: async () => options.allowedOrigins ?? [],
    config: {
      host: HOST,
      port: PORT,
      isDevelopment: options.isDevelopment ?? false,
    } as never,
  });

  openApps.push(app);
  return app;
}

function envelope(body: string): ErrorEnvelope {
  return JSON.parse(body) as ErrorEnvelope;
}

describe('WebSocket upgrade — authentication (§14.1)', () => {
  it('rejects an unauthenticated upgrade with 401 and the F5.4 envelope', async () => {
    const app = buildApp({ principal: null });

    const response = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { origin: OWN_ORIGIN },
    });

    expect(response.statusCode).toBe(401);
    expect(envelope(response.body).error.code).toBe('UNAUTHORIZED');
  });

  it('declares the route as authenticated with full scope', async () => {
    const app = buildApp();
    const routes: { url: string; config: { auth?: unknown } }[] = [];
    app.addHook('onRoute', (route) => {
      routes.push({ url: route.url, config: route.config as { auth?: unknown } });
    });
    await app.ready();

    // §14.1: an `ingest`-scoped token must be refused with 403. That is enforced by the
    // shared guard reading this policy, so what this module owes is the declaration.
    expect(routes.find((route) => route.url === WS_PATH)?.config.auth).toEqual(FULL_ACCESS_ROUTE);
  });
});

describe('WebSocket upgrade — Origin allowlist (§14.2)', () => {
  it('rejects a foreign Origin with 403 ORIGIN_NOT_ALLOWED even with a valid session', async () => {
    // THE test this module exists for. The principal below is fully authenticated — this is
    // precisely the cross-site WebSocket hijacking case that `SameSite=Lax` does not stop.
    const app = buildApp({ principal: cookiePrincipal });

    const response = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(envelope(response.body).error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it.each([
    ['a look-alike host', 'https://evil-127.0.0.1:8710'],
    ['the same host on another port', 'http://127.0.0.1:9999'],
    ['a sandboxed iframe', 'null'],
    ['a browser extension', 'chrome-extension://abcdefghijklmnop'],
    ['the Vite port outside development', 'http://localhost:5173'],
  ])('rejects %s', async (_label, origin) => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: WS_PATH, headers: { origin } });

    expect(response.statusCode).toBe(403);
    expect(envelope(response.body).error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('accepts the Vite dev-server origin when NODE_ENV is development', async () => {
    const app = buildApp({ isDevelopment: true });

    const response = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { origin: 'http://localhost:5173' },
    });

    // Past the hooks: the plugin answers a non-upgrade GET on a websocket route with 404.
    expect(response.statusCode).toBe(404);
  });

  it('accepts an Origin added through the security.allowedOrigins setting', async () => {
    const app = buildApp({ allowedOrigins: ['https://mission-control.home.example'] });

    const response = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { origin: 'https://mission-control.home.example' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses cookie auth when the Origin header is absent, and names why', async () => {
    const app = buildApp({ principal: cookiePrincipal });

    const response = await app.inject({ method: 'GET', url: WS_PATH });

    expect(response.statusCode).toBe(401);
    expect(envelope(response.body).error.code).toBe('UNAUTHORIZED');
    expect(envelope(response.body).error.message).toContain('bearer');
  });

  it('allows a bearer-authenticated upgrade with no Origin (non-browser client)', async () => {
    const app = buildApp({ principal: tokenPrincipal });

    const response = await app.inject({ method: 'GET', url: WS_PATH });

    expect(response.statusCode).toBe(404);
  });

  it('still enforces the allowlist for a bearer client that does send an Origin', async () => {
    const app = buildApp({ principal: tokenPrincipal });

    const response = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('WebSocket upgrade — accepted connection', () => {
  it('completes the upgrade for an allowed Origin and sends hello immediately', async () => {
    const app = buildApp();
    await app.ready();

    const frames: string[] = [];
    const client = await app.injectWS(
      WS_PATH,
      { headers: { origin: OWN_ORIGIN } },
      {
        onInit: (socket) => {
          socket.on('message', (data: Buffer) => frames.push(data.toString()));
        },
      },
    );

    await vi.waitFor(() => {
      expect(frames).toHaveLength(1);
    });
    expect(JSON.parse(frames[0] as string)).toMatchObject({
      type: 'hello',
      protocolVersion: 1,
    });

    client.close();
  });

  it('does not complete the upgrade for a foreign Origin', async () => {
    const app = buildApp();
    await app.ready();

    await expect(
      app.injectWS(WS_PATH, { headers: { origin: 'https://evil.example' } }),
    ).rejects.toThrow('Unexpected server response: 403');
  });
});
