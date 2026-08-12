import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createEvent, type EventEnvelope, newId, schema } from '@mc/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  cookieValueFrom,
  createTestApp,
  seedUser,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { SECURITY_SETTING_KEYS } from '../settings/security.js';
import { sessionChannel } from './channels.js';
import type { ServerFrame } from './protocol.js';
import { WS_CLOSE, WS_PATH } from './protocol.js';

/**
 * The WebSocket protocol end-to-end (TDS 07 §6): a real Fastify listener on an ephemeral
 * port, real `ws` clients, a real `mc_session` cookie minted by the real login endpoint, and
 * a real database behind the Origin allowlist and the Session-channel access check.
 *
 * The centrepiece is the cross-site WebSocket hijacking case: a **valid session cookie** plus
 * a **foreign Origin** must be refused. TDS 07 §6.1 requires that test to exist from day one,
 * "before any hardening drift", and this is it.
 */

const ALLOWED_ORIGIN = 'http://127.0.0.1:8710'; // `MC_HOST`:`MC_PORT` from `testConfig()`
const PROXY_ORIGIN = 'https://mission-control.home.example';

let built: TestApp;
let wsUrl: string;
let cookie: string;
let fullToken: string;
let ingestToken: string;
const openSockets: WebSocket[] = [];

interface Client {
  readonly socket: WebSocket;
  readonly frames: ServerFrame[];
  send(frame: unknown): void;
  /** Wait for the first frame matching `predicate`, then return it. */
  await(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  close(): void;
}

async function listen(app: TestApp['app']): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}${WS_PATH}`;
}

async function connect(headers: Record<string, string>, url: string = wsUrl): Promise<Client> {
  const socket = new WebSocket(url, { headers });
  const frames: ServerFrame[] = [];
  socket.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString('utf8')) as ServerFrame);
  });

  // `once` rejects on `error`, which is how a refused upgrade surfaces in the `ws` client.
  await once(socket, 'open');
  openSockets.push(socket);

  const client: Client = {
    socket,
    frames,
    send: (frame) => {
      socket.send(JSON.stringify(frame));
    },
    await: async (predicate) => {
      let found: ServerFrame | undefined;
      await vi.waitFor(() => {
        found = frames.find(predicate);
        expect(found).toBeDefined();
      });
      return found as ServerFrame;
    },
    close: () => {
      socket.close();
    },
  };

  await client.await((frame) => frame.type === 'hello');
  return client;
}

/** Writes the `('security', 'allowed_origins')` row directly (WS2 §7.6 registry coordinates). */
async function storeAllowedOrigins(origins: readonly string[]): Promise<void> {
  await testDatabase()
    .db.insert(schema.settings)
    .values({
      id: newId(),
      category: 'security',
      key: SECURITY_SETTING_KEYS.allowedOrigins,
      value: [...origins],
      valueType: 'array',
    });
}

function settingUpdated(category: string): EventEnvelope {
  return createEvent('setting.updated', 'backend', {
    category,
    integration: null,
    changedKeys: [SECURITY_SETTING_KEYS.allowedOrigins],
    actorId: null,
  });
}

beforeAll(async () => {
  await truncateAll();
  const user = await seedUser();

  built = createTestApp();
  wsUrl = await listen(built.app);

  const login = await built.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = `${SESSION_COOKIE_NAME}=${cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME)}`;

  const createToken = async (name: string, scopes: string[]): Promise<string> => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: { cookie },
      payload: { name, scopes },
    });
    return (JSON.parse(response.body) as { data: { token: string } }).data.token;
  };

  fullToken = await createToken('ws-full', ['full']);
  ingestToken = await createToken('ws-ingest', ['ingest']);
});

afterAll(() => {
  for (const socket of openSockets.splice(0)) socket.terminate();
});

describe('upgrade handshake (§14.1–§14.2)', () => {
  it('rejects an upgrade with no credential', async () => {
    await expect(connect({ origin: ALLOWED_ORIGIN })).rejects.toThrow(
      'Unexpected server response: 401',
    );
  });

  it('rejects a foreign Origin even with a valid session cookie', async () => {
    // Cross-site WebSocket hijacking (WS0 sign-off finding #3). The cookie below is genuine
    // and would authenticate any REST call — `SameSite=Lax` does not cover this handshake, so
    // the Origin allowlist is the only thing standing between evil.example and every live
    // Session transcript. If this test ever starts failing, do not "fix" it by widening the
    // allowlist.
    await expect(connect({ origin: 'https://evil.example', cookie })).rejects.toThrow(
      'Unexpected server response: 403',
    );
  });

  it('rejects a look-alike origin', async () => {
    await expect(connect({ origin: 'http://127.0.0.1.evil.example:8710', cookie })).rejects.toThrow(
      'Unexpected server response: 403',
    );
  });

  it('rejects the same host on a different port', async () => {
    await expect(connect({ origin: 'http://127.0.0.1:9999', cookie })).rejects.toThrow(
      'Unexpected server response: 403',
    );
  });

  it('refuses cookie auth when no Origin is sent', async () => {
    await expect(connect({ cookie })).rejects.toThrow('Unexpected server response: 401');
  });

  it('accepts an allowed Origin with a valid cookie and sends hello', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    expect(client.frames[0]).toMatchObject({ type: 'hello', protocolVersion: 1 });
    expect(typeof (client.frames[0] as { connectionId: string }).connectionId).toBe('string');
    client.close();
  });

  it('accepts a bearer token with no Origin (non-browser client)', async () => {
    const client = await connect({ authorization: `Bearer ${fullToken}` });

    expect(client.frames[0]).toMatchObject({ type: 'hello' });
    client.close();
  });

  it('rejects an ingest-scoped token with 403 (§14.1)', async () => {
    await expect(connect({ authorization: `Bearer ${ingestToken}` })).rejects.toThrow(
      'Unexpected server response: 403',
    );
  });

  it('honours security.allowedOrigins once the security settings change (§14.2)', async () => {
    await expect(connect({ origin: PROXY_ORIGIN, cookie })).rejects.toThrow(
      'Unexpected server response: 403',
    );

    await storeAllowedOrigins([PROXY_ORIGIN]);
    // The same signal the settings service emits on a write (§15.2 event 21); the hub's
    // subscription is what recomputes the allowlist.
    built.bus.publish(settingUpdated('security'));

    const client = await connect({ origin: PROXY_ORIGIN, cookie });
    expect(client.frames[0]).toMatchObject({ type: 'hello' });
    client.close();
  });
});

describe('channel protocol (§14.3–§14.5)', () => {
  it('round-trips subscribe and unsubscribe', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    client.send({ type: 'subscribe', id: 's1', channels: ['audit', 'settings'] });
    expect(await client.await((frame) => frame.type === 'ack')).toEqual({
      type: 'ack',
      id: 's1',
      ok: true,
      channels: ['audit', 'settings'],
    });

    client.send({ type: 'unsubscribe', id: 's2', channels: ['audit'] });
    expect(await client.await((frame) => frame.type === 'ack' && frame.id === 's2')).toMatchObject({
      ok: true,
      channels: ['audit'],
    });

    client.close();
  });

  it('delivers only subscribed channels, with the F6 envelope verbatim', async () => {
    const auditor = await connect({ origin: ALLOWED_ORIGIN, cookie });
    const watcher = await connect({ origin: ALLOWED_ORIGIN, cookie });

    auditor.send({ type: 'subscribe', id: 'a', channels: ['audit'] });
    watcher.send({ type: 'subscribe', id: 'b', channels: ['notifications'] });
    await auditor.await((frame) => frame.type === 'ack');
    await watcher.await((frame) => frame.type === 'ack');

    const envelope = createEvent('audit.entry_recorded', 'backend', {
      auditLogEntryId: newId(),
      action: 'auth.login',
    });
    built.hub.publish(envelope);

    const delivered = await auditor.await((frame) => frame.type === 'event');
    expect(delivered).toEqual({ type: 'event', channel: 'audit', event: envelope });

    // Isolation: the other connection is subscribed elsewhere and must see nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watcher.frames.filter((frame) => frame.type === 'event')).toEqual([]);

    auditor.close();
    watcher.close();
  });

  it('answers a client ping with a pong (§14.6)', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    client.send({ type: 'ping', id: 'p1' });

    expect(await client.await((frame) => frame.type === 'pong')).toEqual({
      type: 'pong',
      id: 'p1',
    });
    client.close();
  });

  it('refuses a session channel whose Session does not exist', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    client.send({ type: 'subscribe', id: 's1', channels: [sessionChannel(newId())] });

    expect(await client.await((frame) => frame.type === 'ack')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    client.close();
  });

  it('refuses an unknown channel without closing the connection', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    client.send({ type: 'subscribe', id: 's1', channels: ['everything'] });
    expect(await client.await((frame) => frame.type === 'ack')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });

    client.send({ type: 'subscribe', id: 's2', channels: ['audit'] });
    expect(await client.await((frame) => frame.type === 'ack' && frame.id === 's2')).toMatchObject({
      ok: true,
    });

    client.close();
  });

  it('answers a malformed frame with an error frame and stays connected', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    client.socket.send('}{ not json');

    expect(await client.await((frame) => frame.type === 'error')).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.send({ type: 'subscribe', id: 's1', channels: ['sync'] });
    expect(await client.await((frame) => frame.type === 'ack')).toMatchObject({ ok: true });

    client.close();
  });

  it('answers a prompt frame with OPERATION_NOT_SUPPORTED until the wrapper wires the port', async () => {
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie });

    client.send({ type: 'prompt', id: 'p1', sessionId: newId(), content: 'hello' });

    expect(await client.await((frame) => frame.type === 'ack')).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_NOT_SUPPORTED' },
    });
    client.close();
  });
});

describe('reconnect semantics (F6.3 / §14.7)', () => {
  it('replays nothing and keeps no subscription state across connections', async () => {
    const first = await connect({ origin: ALLOWED_ORIGIN, cookie });
    first.send({ type: 'subscribe', id: 's1', channels: ['audit'] });
    await first.await((frame) => frame.type === 'ack');

    first.socket.terminate();
    await vi.waitFor(() => {
      expect(built.hub.subscriberCount('audit')).toBe(0);
    });

    // Published inside the loss window: best-effort relay means it is gone for good.
    built.hub.publish(createEvent('audit.entry_recorded', 'backend', { auditLogEntryId: newId() }));

    const second = await connect({ origin: ALLOWED_ORIGIN, cookie });
    second.send({ type: 'subscribe', id: 's1', channels: ['audit'] });
    await second.await((frame) => frame.type === 'ack');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.frames.filter((frame) => frame.type === 'event')).toEqual([]);

    second.close();
  });
});

describe('shutdown (§14.6)', () => {
  it('closes live connections with 1001 when the server shuts down', async () => {
    const other = createTestApp();
    const otherUrl = await listen(other.app);
    const client = await connect({ origin: ALLOWED_ORIGIN, cookie }, otherUrl);
    const closed = once(client.socket, 'close');

    await other.app.close();

    const [code] = (await closed) as [number, Buffer];
    expect(code).toBe(WS_CLOSE.SERVER_SHUTDOWN);
  });

  it('a refused upgrade does not leave a socket holding the server open', async () => {
    // Regression: `@fastify/websocket` only releases the hijacked socket when its own
    // `onRequest` hook ran, and a rejection from the auth guard short-circuits before that.
    // The leaked connection made `server.close()` wait forever — a hung graceful shutdown
    // from a single unauthenticated upgrade attempt.
    const other = createTestApp();
    const otherUrl = await listen(other.app);

    await expect(connect({ origin: ALLOWED_ORIGIN }, otherUrl)).rejects.toThrow(
      'Unexpected server response: 401',
    );
    await expect(connect({ origin: 'https://evil.example', cookie }, otherUrl)).rejects.toThrow(
      'Unexpected server response: 403',
    );

    const started = Date.now();
    await other.app.close();

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
