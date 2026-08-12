import type { EventEnvelope } from '@mc/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE } from './protocol.js';
import {
  backoffDelayMs,
  SocketAckError,
  SocketClient,
  type SocketCloseEvent,
  type SocketLike,
  type SocketMessageEvent,
} from './socket-client.js';

/**
 * `SocketClient` against a scripted in-memory socket (TDS 07 §4).
 *
 * No server, no DOM socket, no network — every rule in TDS 05 §5 is a pure state-machine
 * property and is asserted as one. The parts that matter most are the ones a live-server
 * test could not pin down deterministically: backoff jitter, the linger window, the
 * dedupe LRU, and the exact ORDER of resubscribe-then-invalidate on reconnect.
 */

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((event: SocketMessageEvent) => void) | null = null;
  onclose: ((event: SocketCloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.readyState = 3;
  }

  // ---- test drivers -------------------------------------------------------------------

  transportOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  hello(connectionId = 'conn-1'): void {
    this.receive({
      type: 'hello',
      connectionId,
      serverTime: new Date(0).toISOString(),
      protocolVersion: 1,
    });
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  framesOfType(type: string): Record<string, unknown>[] {
    return this.frames().filter((frame) => frame['type'] === type);
  }
}

function makeEvent(
  id: string,
  type = 'session.state_changed',
  payload: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    schemaVersion: 1,
    occurredAt: new Date(0).toISOString(),
    source: 'backend',
    correlationId: null,
    payload,
  } as unknown as EventEnvelope;
}

interface Harness {
  readonly client: SocketClient;
  readonly sockets: FakeSocket[];
  latest(): FakeSocket;
}

function harness(options: Partial<ConstructorParameters<typeof SocketClient>[0]> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const client = new SocketClient({
    url: 'ws://test/api/v1/ws',
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    // Deterministic jitter: the midpoint of the equal-jitter window.
    random: () => 0.5,
    pingIntervalMs: 100,
    livenessTimeoutMs: 300,
    backoffBaseMs: 1_000,
    backoffCapMs: 30_000,
    lingerMs: 50,
    ...options,
  });
  return {
    client,
    sockets,
    latest: () => sockets[sockets.length - 1] as FakeSocket,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelayMs', () => {
  it('grows exponentially, caps at 30 s, and is half-deterministic half-jittered', () => {
    const random = () => 0; // worst case: the bottom of the window
    expect(backoffDelayMs(0, { random })).toBe(500);
    expect(backoffDelayMs(1, { random })).toBe(1_000);
    expect(backoffDelayMs(2, { random })).toBe(2_000);
    expect(backoffDelayMs(10, { random })).toBe(15_000);

    const top = () => 1;
    expect(backoffDelayMs(0, { random: top })).toBe(1_000);
    expect(backoffDelayMs(10, { random: top })).toBe(30_000);
  });

  it('never returns the same value for two clients with different entropy', () => {
    // The point of jitter: two tabs that dropped together must not retry together.
    expect(backoffDelayMs(5, { random: () => 0 })).not.toBe(backoffDelayMs(5, { random: () => 1 }));
  });
});

describe('connection state machine (§5.1)', () => {
  it('starts idle, goes connecting on connect, and only reaches open on `hello`', () => {
    const { client, latest } = harness();
    expect(client.state).toBe('idle');

    client.connect();
    expect(client.state).toBe('connecting');

    // Transport open is NOT enough: the upgrade can still be refused on Origin, or the
    // credential re-checked into a 4001. A green chip here would be a lie.
    latest().transportOpen();
    expect(client.state).toBe('connecting');

    latest().hello();
    expect(client.state).toBe('open');
    expect(client.snapshot.connectionId).toBe('conn-1');
  });

  it('enters backoff on close and reconnects after the scheduled delay', () => {
    const { client, sockets, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    latest().serverClose(1006);
    expect(client.state).toBe('backoff');
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(750); // equal jitter at random()=0.5 for attempt 0 => 750ms
    expect(sockets).toHaveLength(2);
    expect(client.state).toBe('connecting');
  });

  it('does NOT retry after close code 4001 and routes through the auth path instead', () => {
    const onAuthFailure = vi.fn();
    const { client, sockets, latest } = harness({ onAuthFailure });
    client.connect();
    latest().transportOpen();
    latest().hello();

    latest().serverClose(WS_CLOSE.AUTH_EXPIRED);

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('idle');
    expect(client.snapshot.authFailed).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('DOES retry after 4002 slow-consumer, which is not an auth failure', () => {
    const onAuthFailure = vi.fn();
    const { client, sockets, latest } = harness({ onAuthFailure });
    client.connect();
    latest().transportOpen();
    latest().hello();

    latest().serverClose(WS_CLOSE.SLOW_CONSUMER);

    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(client.state).toBe('backoff');
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(2);
  });

  it('disconnect() goes straight to idle and schedules no retry', () => {
    const { client, sockets, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    client.disconnect();
    expect(client.state).toBe('idle');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('retryNow() cancels backoff, resets the attempt counter, and connects immediately', () => {
    const { client, sockets, latest } = harness();
    client.connect();
    latest().serverClose(1006);
    latest().serverClose(1006); // second failure would normally lengthen the delay
    expect(client.snapshot.attempt).toBeGreaterThan(0);

    client.retryNow();
    expect(sockets).toHaveLength(2);
    expect(client.snapshot.attempt).toBe(0);
  });

  it('reports increasing attempts so the chip can stop claiming "reconnecting" forever', () => {
    const { client, latest, sockets } = harness();
    client.connect();
    for (let round = 0; round < 3; round += 1) {
      latest().serverClose(1006);
      vi.advanceTimersByTime(30_000);
    }
    expect(sockets.length).toBeGreaterThan(3);
    expect(client.snapshot.attempt).toBeGreaterThanOrEqual(3);
  });
});

describe('refcounted channel subscriptions (§5.2)', () => {
  it('sends one subscribe frame for the first subscriber and none for the second', () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    client.subscribe('sessions');
    client.subscribe('sessions');

    const subscribes = latest().framesOfType('subscribe');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]?.['channels']).toEqual(['sessions']);
  });

  it('unsubscribes only after the LAST release and only once the linger expires', () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    const releaseA = client.subscribe('session:a');
    const releaseB = client.subscribe('session:a');

    releaseA();
    vi.advanceTimersByTime(200);
    expect(latest().framesOfType('unsubscribe')).toHaveLength(0);

    releaseB();
    expect(latest().framesOfType('unsubscribe')).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(latest().framesOfType('unsubscribe')[0]?.['channels']).toEqual(['session:a']);
  });

  it('cancels the linger when a new subscriber arrives inside the window', () => {
    // The exact case §5.2 names: a route transition between two views of the same Session
    // must not churn a subscribe/unsubscribe pair.
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    const release = client.subscribe('session:a');
    release();
    vi.advanceTimersByTime(20);
    client.subscribe('session:a');
    vi.advanceTimersByTime(200);

    expect(latest().framesOfType('unsubscribe')).toHaveLength(0);
    expect(latest().framesOfType('subscribe')).toHaveLength(1);
  });

  it('a release function called twice still counts once', () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    const release = client.subscribe('sessions');
    client.subscribe('sessions');
    release();
    release();

    vi.advanceTimersByTime(200);
    expect(latest().framesOfType('unsubscribe')).toHaveLength(0);
  });

  it('defers the subscribe frame when subscribing before the socket is open', () => {
    const { client, latest } = harness();
    client.subscribe('sessions');
    client.connect();
    expect(latest().framesOfType('subscribe')).toHaveLength(0);

    latest().transportOpen();
    latest().hello();
    expect(latest().framesOfType('subscribe')[0]?.['channels']).toEqual(['sessions']);
  });
});

describe('reconnect: resubscribe THEN invalidate (§5.3, §14.7)', () => {
  it('re-sends every desired channel in one frame and only then reports the reconnect', () => {
    const sockets: FakeSocket[] = [];
    /** Subscribe frames already on the wire at the instant `onReconnected` fired. */
    const subscribesAtCallback: number[] = [];

    const client = new SocketClient({
      url: 'ws://test/api/v1/ws',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
      lingerMs: 50,
      onReconnected: () => {
        const current = sockets[sockets.length - 1] as FakeSocket;
        subscribesAtCallback.push(current.framesOfType('subscribe').length);
      },
    });

    client.connect();
    (sockets[0] as FakeSocket).transportOpen();
    (sockets[0] as FakeSocket).hello();
    client.subscribe('sessions');
    client.subscribe('session:a');

    (sockets[0] as FakeSocket).serverClose(1006);
    vi.advanceTimersByTime(750);

    const second = sockets[1] as FakeSocket;
    second.transportOpen();
    expect(second.framesOfType('subscribe')).toHaveLength(0);

    second.hello('conn-2');

    const subscribes = second.framesOfType('subscribe');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]?.['channels']).toEqual(['sessions', 'session:a']);
    // The subscribe frame is on the wire BEFORE the refetch is asked for. The reverse order
    // has a window in which the refetch finished but the subscription had not, and anything
    // that changed inside it would be lost until the next unrelated event.
    expect(subscribesAtCallback).toEqual([1]);
  });

  it('reports the exact channel set the caller must invalidate', () => {
    const onReconnected = vi.fn();
    const { client, sockets, latest } = harness({ onReconnected });
    client.connect();
    latest().transportOpen();
    latest().hello();
    client.subscribe('sessions');
    client.subscribe('session:018f');

    latest().serverClose(1006);
    vi.advanceTimersByTime(750);
    (sockets[1] as FakeSocket).transportOpen();
    (sockets[1] as FakeSocket).hello('conn-2');

    expect(onReconnected).toHaveBeenCalledWith(['sessions', 'session:018f']);
  });

  it('does not fire the reconnect refetch for the FIRST connection', () => {
    const onReconnected = vi.fn();
    const { client, latest } = harness({ onReconnected });
    client.connect();
    latest().transportOpen();
    latest().hello();
    expect(onReconnected).not.toHaveBeenCalled();
  });
});

describe('idempotent event dispatch (F6.3)', () => {
  it('drops a duplicate envelope id — duplicates across a reconnect are expected', () => {
    const onEvent = vi.fn();
    const { client, latest } = harness({ onEvent });
    client.connect();
    latest().transportOpen();
    latest().hello();
    client.subscribe('sessions');

    latest().receive({ type: 'event', channel: 'sessions', event: makeEvent('evt-1') });
    latest().receive({ type: 'event', channel: 'sessions', event: makeEvent('evt-1') });
    latest().receive({ type: 'event', channel: 'sessions', event: makeEvent('evt-2') });

    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest id once the LRU is full, so memory is bounded', () => {
    const onEvent = vi.fn();
    const { client, latest } = harness({ onEvent, dedupeCapacity: 2 });
    client.connect();
    latest().transportOpen();
    latest().hello();

    for (const id of ['a', 'b', 'c']) {
      latest().receive({ type: 'event', channel: 'sessions', event: makeEvent(id) });
    }
    // `a` has been evicted, so it is no longer recognised as a duplicate.
    latest().receive({ type: 'event', channel: 'sessions', event: makeEvent('a') });
    expect(onEvent).toHaveBeenCalledTimes(4);
  });

  it('delivers to the channel handler and the global listener', () => {
    const channelHandler = vi.fn();
    const globalHandler = vi.fn();
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    client.subscribe('sessions', channelHandler);
    client.addEventListener(globalHandler);
    latest().receive({ type: 'event', channel: 'sessions', event: makeEvent('evt-1') });

    expect(channelHandler).toHaveBeenCalledTimes(1);
    expect(globalHandler).toHaveBeenCalledTimes(1);
  });

  it('ignores an unparseable frame rather than killing the connection', () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    latest().onmessage?.({ data: 'not json' });
    latest().onmessage?.({ data: JSON.stringify({ type: 'wat' }) });

    expect(client.state).toBe('open');
  });
});

describe('application-level liveness (§5.1)', () => {
  it('pings on the configured cadence while open', () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    vi.advanceTimersByTime(100);
    expect(latest().framesOfType('ping')).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(latest().framesOfType('ping')).toHaveLength(2);
  });

  it('force-closes and backs off when no frame of any kind arrives inside the deadline', () => {
    const { client, sockets, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();
    const first = latest();

    vi.advanceTimersByTime(300);

    expect(first.closedWith).not.toBeNull();
    expect(client.state).toBe('backoff');
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(2);
  });

  it('any inbound frame — not just a pong — resets the deadline', () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    vi.advanceTimersByTime(250);
    latest().receive({ type: 'event', channel: 'sessions', event: makeEvent('evt-1') });
    vi.advanceTimersByTime(250);

    expect(client.state).toBe('open');
  });
});

describe('prompt transmission and acks (§14.4/§14.5)', () => {
  it('resolves with the server-assigned messageId', async () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    const pending = client.sendPrompt('018f', 'hello');
    const frame = latest().framesOfType('prompt')[0];
    expect(frame?.['sessionId']).toBe('018f');

    latest().receive({ type: 'ack', id: frame?.['id'], ok: true, messageId: 'msg-1' });
    await expect(pending).resolves.toEqual({ messageId: 'msg-1' });
  });

  it('rejects with the refusal code on `ack { ok: false }` rather than hanging', async () => {
    const { client, latest } = harness();
    client.connect();
    latest().transportOpen();
    latest().hello();

    const pending = client.sendPrompt('018f', 'hello');
    const frame = latest().framesOfType('prompt')[0];
    latest().receive({
      type: 'ack',
      id: frame?.['id'],
      ok: false,
      error: { code: 'SESSION_NOT_RUNNING', message: 'not running' },
    });

    await expect(pending).rejects.toBeInstanceOf(SocketAckError);
  });

  it('rejects immediately when the socket is not open', async () => {
    const { client } = harness();
    await expect(client.sendPrompt('018f', 'hi')).rejects.toThrow(/not connected/i);
  });
});
