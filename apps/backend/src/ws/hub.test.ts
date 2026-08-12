import { createEvent, type EventPayload, type EventType, newId } from '@mc/shared';
import type { FastifyBaseLogger } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../auth/principal.js';
import { ApiError } from '../http/errors.js';
import { sessionChannel } from './channels.js';
import {
  HARD_LIMIT_BYTES,
  type HubConnection,
  type HubSocket,
  SOFT_LIMIT_BYTES,
} from './connection.js';
import { MAX_MISSED_PONGS, WebSocketHub } from './hub.js';
import type { ConnectionCredential, PromptPort, SessionAccessPort } from './ports.js';
import {
  MAX_CHANNELS_PER_CONNECTION,
  MAX_CLIENT_FRAME_BYTES,
  MAX_PROTOCOL_VIOLATIONS,
  type ServerFrame,
  WS_CLOSE,
} from './protocol.js';

/**
 * The hub, with the transport faked out (TDS 07 §2.1 — the unit tier owns no sockets and no
 * database). What is under test here is everything that decides *behaviour*: subscription
 * bookkeeping, channel isolation, the §14.4 violation budget, the §14.6 heartbeat, and the
 * backpressure policy. The real socket, the real cookie and the real upgrade are exercised in
 * `ws.int.test.ts`.
 */

const SESSION_A = '018f6b2e-1111-7abc-8def-0123456789ab';
const SESSION_B = '018f6b2e-2222-7abc-8def-0123456789ab';

const silentLog = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => silentLog,
} as unknown as FastifyBaseLogger;

const principal: Principal = {
  userId: newId(),
  username: 'operator',
  authMethod: 'cookie',
  scopes: ['full'],
  authSession: { id: newId(), expiresAt: new Date('2099-01-01T00:00:00.000Z') },
  apiToken: null,
};

class FakeSocket implements HubSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  terminated = false;
  pings = 0;
  buffered = 0;
  open = true;
  failNextSend = false;

  bufferedAmount(): number {
    return this.buffered;
  }
  isOpen(): boolean {
    return this.open;
  }
  send(payload: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('socket gone');
    }
    this.sent.push(payload);
  }
  ping(): void {
    this.pings += 1;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
    this.open = false;
  }

  frames(): ServerFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as ServerFrame);
  }
  /** Frames received since `hello`, which every connection gets first. */
  after(index: number): ServerFrame[] {
    return this.frames().slice(index);
  }
  last(): ServerFrame {
    const frames = this.frames();
    const frame = frames.at(-1);
    if (frame === undefined) throw new Error('no frames sent');
    return frame;
  }
  reset(): void {
    this.sent.length = 0;
  }
}

function event(type: EventType, payload: EventPayload = {}) {
  return createEvent(type, 'backend', payload);
}

interface Harness {
  readonly hub: WebSocketHub;
  readonly sessionAccess: SessionAccessPort;
  connect(): { socket: FakeSocket; connection: HubConnection };
  send(connection: HubConnection, socket: FakeSocket, frame: unknown): Promise<void>;
}

function createHarness(
  options: {
    canRead?: (sessionId: string) => boolean | Promise<boolean>;
    prompts?: PromptPort;
    softLimitBytes?: number;
    hardLimitBytes?: number;
  } = {},
): Harness {
  const sessionAccess: SessionAccessPort = {
    canRead: async (_p, sessionId) => (options.canRead ?? (() => true))(sessionId),
  };

  const hub = new WebSocketHub({
    log: silentLog,
    sessionAccess,
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.softLimitBytes === undefined ? {} : { softLimitBytes: options.softLimitBytes }),
    ...(options.hardLimitBytes === undefined ? {} : { hardLimitBytes: options.hardLimitBytes }),
  });

  return {
    hub,
    sessionAccess,
    connect() {
      const socket = new FakeSocket();
      const connection = hub.accept({ socket, principal, log: silentLog });
      return { socket, connection };
    },
    async send(connection, _socket, frame) {
      hub.handleMessage(connection, JSON.stringify(frame), false);
      await hub.settled(connection);
    },
  };
}

describe('WebSocketHub — handshake', () => {
  it('sends hello immediately on accept (§14.1)', () => {
    const { connect } = createHarness();
    const { socket, connection } = connect();

    expect(socket.frames()[0]).toMatchObject({
      type: 'hello',
      connectionId: connection.id,
      protocolVersion: 1,
    });
    expect(
      Date.parse(String((socket.frames()[0] as { serverTime: string }).serverTime)),
    ).not.toBeNaN();
  });

  it('starts with no subscriptions — the server keeps none across connections (§14.7)', () => {
    const { hub, connect } = createHarness();
    const { connection } = connect();

    expect(connection.subscriptions.size).toBe(0);
    expect(hub.subscriberCount('sessions')).toBe(0);
  });
});

describe('WebSocketHub — subscribe / unsubscribe', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('round-trips a subscription', async () => {
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: ['sessions', `session:${SESSION_A}`],
    });

    expect(socket.last()).toEqual({
      type: 'ack',
      id: 'f1',
      ok: true,
      channels: ['sessions', sessionChannel(SESSION_A)],
    });
    expect(harness.hub.subscriberCount('sessions')).toBe(1);

    await harness.send(connection, socket, {
      type: 'unsubscribe',
      id: 'f2',
      channels: ['sessions'],
    });

    expect(socket.last()).toEqual({ type: 'ack', id: 'f2', ok: true, channels: ['sessions'] });
    expect(harness.hub.subscriberCount('sessions')).toBe(0);
    expect(harness.hub.subscriberCount(sessionChannel(SESSION_A))).toBe(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels: ['audit'] });

    harness.hub.publish(event('audit.entry_recorded', { auditLogEntryId: newId() }));
    socket.reset();

    await harness.send(connection, socket, { type: 'unsubscribe', id: 'f2', channels: ['audit'] });
    socket.reset();
    harness.hub.publish(event('audit.entry_recorded', { auditLogEntryId: newId() }));

    expect(socket.frames()).toEqual([]);
  });

  it('is idempotent: re-subscribing does not double-register', async () => {
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels: ['sync'] });
    await harness.send(connection, socket, { type: 'subscribe', id: 'f2', channels: ['sync'] });
    socket.reset();

    harness.hub.publish(event('sync.completed', { syncRunId: newId() }));

    expect(socket.frames()).toHaveLength(1);
  });

  it('rejects an unknown channel with an ack, not a disconnect', async () => {
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: ['everything'],
    });

    expect(socket.last()).toMatchObject({
      type: 'ack',
      id: 'f1',
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(socket.closed).toBeNull();
  });

  it('applies a mixed subscribe atomically — nothing takes effect if one channel fails', async () => {
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: ['sessions', 'nonsense'],
    });

    expect(socket.last()).toMatchObject({ ok: false });
    expect(harness.hub.subscriberCount('sessions')).toBe(0);
  });

  it('enforces the 64-channel budget per connection (§14.3)', async () => {
    const { socket, connection } = harness.connect();
    const channels = Array.from({ length: MAX_CHANNELS_PER_CONNECTION }, () =>
      sessionChannel(newId()),
    );

    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels });
    expect(socket.last()).toMatchObject({ ok: true });

    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f2',
      channels: [sessionChannel(newId())],
    });

    expect(socket.last()).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(connection.subscriptions.size).toBe(MAX_CHANNELS_PER_CONNECTION);
  });

  it('refuses a session channel the principal may not read', async () => {
    const denying = createHarness({ canRead: (sessionId) => sessionId !== SESSION_B });
    const { socket, connection } = denying.connect();

    await denying.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_B}`],
    });

    expect(socket.last()).toMatchObject({
      type: 'ack',
      id: 'f1',
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(denying.hub.subscriberCount(sessionChannel(SESSION_B))).toBe(0);
    expect(socket.closed).toBeNull();
  });

  it('answers INTERNAL — and subscribes nothing — when the access check throws', async () => {
    const broken = createHarness({
      canRead: () => {
        throw new Error('database is down');
      },
    });
    const { socket, connection } = broken.connect();

    await broken.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_A}`],
    });

    expect(socket.last()).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(broken.hub.subscriberCount(sessionChannel(SESSION_A))).toBe(0);
  });

  it('registers nothing for a connection that died during the access check', async () => {
    // `handleClose` sweeps the index once. A subscription applied after that sweep would
    // never be swept again — a dead connection pinned in the fan-out map forever.
    let release: (readable: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const gated = createHarness({ canRead: () => gate });
    const { socket, connection } = gated.connect();

    gated.hub.handleMessage(
      connection,
      JSON.stringify({ type: 'subscribe', id: 'f1', channels: [`session:${SESSION_A}`] }),
      false,
    );
    socket.terminate();
    gated.hub.handleClose(connection);
    release(true);
    await gated.hub.settled(connection);

    expect(gated.hub.subscriberCount(sessionChannel(SESSION_A))).toBe(0);
    expect(connection.subscriptions.size).toBe(0);
  });

  it('answers a ping frame with a pong carrying the same id (§14.6)', async () => {
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, { type: 'ping', id: 'p1' });

    expect(socket.last()).toEqual({ type: 'pong', id: 'p1' });
  });

  it('processes frames in order even across the async access check', async () => {
    const { socket, connection } = harness.connect();

    harness.hub.handleMessage(
      connection,
      JSON.stringify({ type: 'subscribe', id: 'f1', channels: [`session:${SESSION_A}`] }),
      false,
    );
    harness.hub.handleMessage(
      connection,
      JSON.stringify({ type: 'unsubscribe', id: 'f2', channels: [`session:${SESSION_A}`] }),
      false,
    );
    await harness.hub.settled(connection);

    expect(harness.hub.subscriberCount(sessionChannel(SESSION_A))).toBe(0);
    expect(socket.after(1).map((frame) => (frame as { id: string }).id)).toEqual(['f1', 'f2']);
  });
});

describe('WebSocketHub — relay', () => {
  it('delivers only subscribed channels (isolation)', async () => {
    const harness = createHarness();
    const a = harness.connect();
    const b = harness.connect();

    await harness.send(a.connection, a.socket, {
      type: 'subscribe',
      id: 'f1',
      channels: ['sessions'],
    });
    await harness.send(b.connection, b.socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_A}`],
    });
    a.socket.reset();
    b.socket.reset();

    harness.hub.publish(
      event('session.state_changed', {
        sessionId: SESSION_A,
        fromState: 'created',
        toState: 'running',
      }),
    );
    harness.hub.publish(event('session.message.appended', { sessionId: SESSION_A }));
    harness.hub.publish(event('session.message.appended', { sessionId: SESSION_B }));
    harness.hub.publish(event('notification.created', { notificationId: newId() }));

    expect(a.socket.frames()).toHaveLength(1);
    expect(a.socket.frames()[0]).toMatchObject({ type: 'event', channel: 'sessions' });

    expect(b.socket.frames()).toHaveLength(2);
    for (const frame of b.socket.frames()) {
      expect(frame).toMatchObject({ type: 'event', channel: sessionChannel(SESSION_A) });
    }
  });

  it('carries the F6 envelope verbatim', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels: ['settings'] });
    socket.reset();

    const envelope = event('setting.updated', {
      category: 'security',
      integration: null,
      changedKeys: ['allowed_origins'],
      actorId: principal.userId,
    });
    harness.hub.publish(envelope);

    expect(socket.last()).toEqual({ type: 'event', channel: 'settings', event: envelope });
  });

  it('does not replay: an event published before a subscription is gone forever (F6.3)', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    harness.hub.publish(event('session.created', { sessionId: SESSION_A }));

    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels: ['sessions'] });
    socket.reset();

    expect(socket.frames()).toEqual([]);
  });

  it('drops an event whose type routes nowhere', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels: ['sessions'] });
    socket.reset();

    harness.hub.publish(event('session.message.appended', { sessionId: SESSION_A }));

    expect(socket.frames()).toEqual([]);
  });

  it('one dead socket does not stop the fan-out to the others', async () => {
    const harness = createHarness();
    const a = harness.connect();
    const b = harness.connect();
    for (const peer of [a, b]) {
      await harness.send(peer.connection, peer.socket, {
        type: 'subscribe',
        id: 'f1',
        channels: ['audit'],
      });
      peer.socket.reset();
    }
    a.socket.failNextSend = true;

    harness.hub.publish(event('audit.entry_recorded', { auditLogEntryId: newId() }));

    expect(a.socket.frames()).toEqual([]);
    expect(b.socket.frames()).toHaveLength(1);
  });
});

describe('WebSocketHub — ephemeral streaming deltas', () => {
  it('publishSessionDelta reaches session:{id} only, never the list channel', async () => {
    const harness = createHarness();
    const list = harness.connect();
    const detail = harness.connect();
    await harness.send(list.connection, list.socket, {
      type: 'subscribe',
      id: 'f1',
      channels: ['sessions'],
    });
    await harness.send(detail.connection, detail.socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_A}`],
    });
    list.socket.reset();
    detail.socket.reset();

    const envelope = harness.hub.publishSessionDelta({
      sessionId: SESSION_A,
      messageId: SESSION_B,
      blockIndex: 0,
      deltaType: 'text_delta',
      text: 'Refactoring the',
      streamEventType: 'content_block_delta',
    });

    expect(list.socket.frames()).toEqual([]);
    expect(detail.socket.last()).toEqual({
      type: 'event',
      channel: sessionChannel(SESSION_A),
      event: envelope,
    });
  });

  it('builds the §14.5 payload shape', () => {
    const harness = createHarness();
    const envelope = harness.hub.publishSessionDelta({
      sessionId: SESSION_A,
      messageId: SESSION_B,
      blockIndex: 2,
      deltaType: 'input_json_delta',
      partialJson: '{"pat',
      streamEventType: 'content_block_delta',
      correlationId: SESSION_A,
    });

    expect(envelope).toMatchObject({
      type: 'session.message.delta_appended',
      schemaVersion: 1,
      source: 'backend',
      correlationId: SESSION_A,
      payload: {
        sessionId: SESSION_A,
        messageId: SESSION_B,
        blockIndex: 2,
        deltaType: 'input_json_delta',
        text: null,
        partialJson: '{"pat',
        streamEventType: 'content_block_delta',
      },
    });
  });
});

describe('WebSocketHub — malformed frames (§14.4)', () => {
  it('answers an error frame and keeps the connection', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    harness.hub.handleMessage(connection, 'not json at all', false);
    await harness.hub.settled(connection);

    expect(socket.last()).toMatchObject({ type: 'error', error: { code: 'VALIDATION_FAILED' } });
    expect(socket.closed).toBeNull();
    expect(connection.isDead).toBe(false);
  });

  it('rejects binary frames', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    harness.hub.handleMessage(connection, Buffer.from([0x00, 0x01]), true);
    await harness.hub.settled(connection);

    expect(socket.last()).toMatchObject({ type: 'error' });
    expect(socket.closed).toBeNull();
  });

  it('rejects an oversized frame with PAYLOAD_TOO_LARGE', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    harness.hub.handleMessage(connection, 'x'.repeat(MAX_CLIENT_FRAME_BYTES + 1), false);
    await harness.hub.settled(connection);

    expect(socket.last()).toMatchObject({ type: 'error', error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(socket.closed).toBeNull();
  });

  it('closes with 4000 once violations repeat', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    for (let i = 0; i < MAX_PROTOCOL_VIOLATIONS - 1; i += 1) {
      harness.hub.handleMessage(connection, '{', false);
    }
    await harness.hub.settled(connection);
    expect(socket.closed).toBeNull();

    harness.hub.handleMessage(connection, '{', false);
    await harness.hub.settled(connection);

    expect(socket.closed).toEqual({
      code: WS_CLOSE.PROTOCOL_VIOLATION,
      reason: 'repeated protocol violations',
    });
  });

  it('a semantically refused frame is not a violation', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    for (let i = 0; i < MAX_PROTOCOL_VIOLATIONS + 2; i += 1) {
      await harness.send(connection, socket, {
        type: 'subscribe',
        id: `f${i}`,
        channels: ['nope'],
      });
    }

    expect(socket.closed).toBeNull();
    expect(connection.stats.violations).toBe(0);
  });
});

describe('WebSocketHub — heartbeat (§14.6)', () => {
  it('pings on every tick and terminates after two missed pongs', () => {
    const harness = createHarness();
    const { socket } = harness.connect();

    harness.hub.tick();
    expect(socket.pings).toBe(1);
    harness.hub.tick();
    expect(socket.pings).toBe(MAX_MISSED_PONGS);
    expect(socket.terminated).toBe(false);

    harness.hub.tick();

    expect(socket.terminated).toBe(true);
    expect(harness.hub.connectionCount).toBe(0);
  });

  it('a pong keeps the connection alive indefinitely', () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    for (let i = 0; i < 10; i += 1) {
      harness.hub.tick();
      harness.hub.handlePong(connection);
    }

    expect(socket.terminated).toBe(false);
    expect(harness.hub.connectionCount).toBe(1);
  });

  it('any inbound frame counts as liveness, not just a protocol pong', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    harness.hub.tick();
    harness.hub.tick();
    await harness.send(connection, socket, { type: 'ping' });
    harness.hub.tick();

    expect(socket.terminated).toBe(false);
  });

  it('terminates a connection still lingering a tick after a close was requested', () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    connection.beginClose(WS_CLOSE.PROTOCOL_VIOLATION, 'test');
    expect(socket.terminated).toBe(false);

    harness.hub.tick();

    expect(socket.terminated).toBe(true);
    expect(harness.hub.connectionCount).toBe(0);
  });

  it('reaps a socket that closed underneath us', () => {
    const harness = createHarness();
    const { socket } = harness.connect();

    socket.open = false;
    harness.hub.tick();

    expect(harness.hub.connectionCount).toBe(0);
  });
});

describe('WebSocketHub — credential revalidation (close 4001)', () => {
  function credential(result: () => Promise<{ valid: boolean }>): ConnectionCredential {
    return {
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
      revalidate: result as ConnectionCredential['revalidate'],
    };
  }

  it('closes with 4001 when the credential is gone', async () => {
    const harness = createHarness();
    const socket = new FakeSocket();
    harness.hub.accept({
      socket,
      principal,
      log: silentLog,
      credential: credential(async () => ({ valid: false })),
    });

    harness.hub.tick(new Date('2026-01-01T00:00:00.000Z'));
    await vi.waitFor(() => {
      expect(socket.closed).toEqual({
        code: WS_CLOSE.AUTH_EXPIRED,
        reason: 'authentication expired',
      });
    });
  });

  it('keeps the connection and refreshes the floor when the credential is still valid', async () => {
    const harness = createHarness();
    const socket = new FakeSocket();
    const revalidate = vi.fn(async () => ({
      valid: true as const,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }));
    const connection = harness.hub.accept({
      socket,
      principal,
      log: silentLog,
      credential: { expiresAt: new Date('2000-01-01T00:00:00.000Z'), revalidate },
    });

    harness.hub.tick(new Date('2026-01-01T00:00:00.000Z'));
    await vi.waitFor(() => {
      expect(connection.credentialExpiresAt?.getFullYear()).toBe(2099);
    });

    harness.hub.tick(new Date('2026-01-01T00:00:30.000Z'));
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBeNull();
  });

  it('a failed revalidation is not a logout', async () => {
    const harness = createHarness();
    const socket = new FakeSocket();
    harness.hub.accept({
      socket,
      principal,
      log: silentLog,
      credential: credential(async () => {
        throw new Error('database is down');
      }),
    });

    harness.hub.tick(new Date('2026-01-01T00:00:00.000Z'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.closed).toBeNull();
  });
});

describe('WebSocketHub — slow consumer (TDS 02 §4.2)', () => {
  it('drops ephemeral deltas above the soft limit but still relays durable events', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_A}`],
    });
    socket.reset();
    socket.buffered = SOFT_LIMIT_BYTES;

    harness.hub.publishSessionDelta({
      sessionId: SESSION_A,
      messageId: SESSION_B,
      blockIndex: 0,
      deltaType: 'text_delta',
      text: 'tokens',
      streamEventType: 'content_block_delta',
    });
    expect(socket.frames()).toEqual([]);
    expect(connection.stats.droppedEphemeral).toBe(1);

    harness.hub.publish(event('session.message.appended', { sessionId: SESSION_A }));

    // The durable event still lands: it is what heals the dropped deltas (§14.7).
    expect(socket.frames()).toHaveLength(1);
    expect(socket.closed).toBeNull();
  });

  it('closes with 4002 once the hard limit is reached', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_A}`],
    });
    socket.reset();
    socket.buffered = HARD_LIMIT_BYTES;

    harness.hub.publish(event('session.message.appended', { sessionId: SESSION_A }));

    expect(socket.frames()).toEqual([]);
    expect(socket.closed).toMatchObject({ code: WS_CLOSE.SLOW_CONSUMER });
  });

  it('one wedged client neither stalls nor drops traffic for a healthy one', async () => {
    const harness = createHarness();
    const slow = harness.connect();
    const fast = harness.connect();
    for (const peer of [slow, fast]) {
      await harness.send(peer.connection, peer.socket, {
        type: 'subscribe',
        id: 'f1',
        channels: [`session:${SESSION_A}`],
      });
      peer.socket.reset();
    }
    slow.socket.buffered = SOFT_LIMIT_BYTES * 2;

    for (let i = 0; i < 50; i += 1) {
      harness.hub.publishSessionDelta({
        sessionId: SESSION_A,
        messageId: SESSION_B,
        blockIndex: 0,
        deltaType: 'text_delta',
        text: `token-${i}`,
        streamEventType: 'content_block_delta',
      });
    }

    expect(fast.socket.frames()).toHaveLength(50);
    expect(slow.socket.frames()).toEqual([]);
    expect(slow.connection.stats.droppedEphemeral).toBe(50);
  });

  it('honours configured limits', async () => {
    const harness = createHarness({ softLimitBytes: 10, hardLimitBytes: 20 });
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: [`session:${SESSION_A}`],
    });
    socket.reset();

    socket.buffered = 10;
    harness.hub.publishSessionDelta({
      sessionId: SESSION_A,
      messageId: SESSION_B,
      blockIndex: 0,
      deltaType: 'text_delta',
      text: 'x',
      streamEventType: 'content_block_delta',
    });
    expect(connection.stats.droppedEphemeral).toBe(1);

    socket.buffered = 20;
    harness.hub.publish(event('session.message.appended', { sessionId: SESSION_A }));
    expect(socket.closed).toMatchObject({ code: WS_CLOSE.SLOW_CONSUMER });
  });
});

describe('WebSocketHub — prompt frames', () => {
  it('answers OPERATION_NOT_SUPPORTED until the session domain wires the port', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'prompt',
      id: 'f1',
      sessionId: SESSION_A,
      content: 'hello',
    });

    expect(socket.last()).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_NOT_SUPPORTED' },
    });
  });

  it('delegates to the port and acks with the persisted messageId (§6.4)', async () => {
    const submit = vi.fn(async () => ({ messageId: SESSION_B }));
    const harness = createHarness({ prompts: { submit } });
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'prompt',
      id: 'f1',
      sessionId: SESSION_A,
      content: 'refactor this',
    });

    expect(submit).toHaveBeenCalledWith({
      principal,
      sessionId: SESSION_A,
      content: 'refactor this',
    });
    expect(socket.last()).toEqual({ type: 'ack', id: 'f1', ok: true, messageId: SESSION_B });
  });

  it('renders a domain ApiError into the ack verbatim', async () => {
    const harness = createHarness({
      prompts: {
        submit: async () => {
          throw new ApiError('SESSION_NOT_RUNNING', 'Session is not running');
        },
      },
    });
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'prompt',
      id: 'f1',
      sessionId: SESSION_A,
      content: 'hi',
    });

    expect(socket.last()).toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_RUNNING', message: 'Session is not running' },
    });
  });

  it('refuses a prompt for a session the principal may not read', async () => {
    const harness = createHarness({
      canRead: () => false,
      prompts: { submit: async () => ({ messageId: SESSION_B }) },
    });
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'prompt',
      id: 'f1',
      sessionId: SESSION_A,
      content: 'hi',
    });

    expect(socket.last()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('rejects a malformed sessionId without reaching the port', async () => {
    const submit = vi.fn(async () => ({ messageId: SESSION_B }));
    const harness = createHarness({ prompts: { submit } });
    const { socket, connection } = harness.connect();

    await harness.send(connection, socket, {
      type: 'prompt',
      id: 'f1',
      sessionId: 'not-an-id',
      content: 'hi',
    });

    expect(socket.last()).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('WebSocketHub — teardown', () => {
  it('closeAll closes every connection with 1001 and clears the index', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, { type: 'subscribe', id: 'f1', channels: ['sessions'] });

    harness.hub.closeAll();

    expect(socket.closed).toEqual({
      code: WS_CLOSE.SERVER_SHUTDOWN,
      reason: 'server shutting down',
    });
    expect(harness.hub.connectionCount).toBe(0);
    expect(harness.hub.subscriberCount('sessions')).toBe(0);
  });

  it('handleClose detaches the connection from every channel', async () => {
    const harness = createHarness();
    const { socket, connection } = harness.connect();
    await harness.send(connection, socket, {
      type: 'subscribe',
      id: 'f1',
      channels: ['sessions', `session:${SESSION_A}`],
    });

    harness.hub.handleClose(connection);

    expect(harness.hub.subscriberCount('sessions')).toBe(0);
    expect(harness.hub.subscriberCount(sessionChannel(SESSION_A))).toBe(0);
    expect(harness.hub.connectionCount).toBe(0);
  });
});
