import { createEvent, EVENT_RELAY_CHANNEL, type EventEnvelope, encodeRelayEvent } from '@mc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus, type EventBus } from './bus.js';
import { EventRelay, type RelayClient, type RelayNotification } from './relay.js';

/**
 * The relay listener (TDS 04 §15.1), driven with **no database**.
 *
 * The reconnect behaviour is the reason this tier exists. A `LISTEN` connection dropped by a
 * network blip or a database restart never comes back on its own, and nothing else in the
 * process notices: the relay looks alive and delivers nothing for the life of the Backend.
 * That failure mode is invisible without a test, so it is the centrepiece here — `error` and
 * `end` are both proved to re-establish the connection, re-issue the `LISTEN`, and go on
 * delivering.
 *
 * The integration twin (`relay.int.test.ts`) proves the same thing against a real PostgreSQL
 * connection that a real `pg_terminate_backend` kills.
 */

const SESSION_ID = '018f6b2e-1111-7abc-8def-0123456789ab';

interface FakeClient extends RelayClient {
  /** Deliver a notification as PostgreSQL would. */
  notify(message: RelayNotification): void;
  /** Simulate a connection-level failure. */
  fail(error: Error): void;
  /** Simulate the server closing the connection. */
  finish(): void;
  readonly queries: string[];
  readonly ended: boolean;
}

interface Harness {
  readonly clients: FakeClient[];
  readonly newClient: () => RelayClient;
  /** Fail the next `connect()` with this error, once. */
  failNextConnect(error: Error): void;
}

function harness(): Harness {
  const clients: FakeClient[] = [];
  let connectFailure: Error | null = null;

  const newClient = (): RelayClient => {
    const queries: string[] = [];
    let onNotification: ((message: RelayNotification) => void) | null = null;
    let onError: ((error: Error) => void) | null = null;
    let onEnd: (() => void) | null = null;
    let ended = false;

    const client: FakeClient = {
      queries,
      get ended() {
        return ended;
      },
      connect: async () => {
        if (connectFailure !== null) {
          const error = connectFailure;
          connectFailure = null;
          throw error;
        }
      },
      query: async (text: string) => {
        queries.push(text);
        return undefined;
      },
      onNotification: (listener) => {
        onNotification = listener;
      },
      onError: (listener) => {
        onError = listener;
      },
      onEnd: (listener) => {
        onEnd = listener;
      },
      end: async () => {
        ended = true;
      },
      notify: (message) => onNotification?.(message),
      fail: (error) => onError?.(error),
      finish: () => onEnd?.(),
    };

    clients.push(client);
    return client;
  };

  return {
    clients,
    newClient,
    failNextConnect: (error) => {
      connectFailure = error;
    },
  };
}

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function payloadFor(event: EventEnvelope): string {
  const encoded = encodeRelayEvent(event);
  if (!encoded.ok) throw new Error('fixture is oversized');
  return encoded.payload;
}

function syncCompleted(overrides: { id?: string } = {}): EventEnvelope {
  return createEvent(
    'sync.completed',
    'sync-worker',
    { syncRunId: SESSION_ID, notesExported: 1, notesImported: 0, conflicts: 0 },
    { correlationId: SESSION_ID, ...(overrides.id === undefined ? {} : { id: overrides.id }) },
  );
}

let bus: EventBus;
let received: EventEnvelope[];
let relay: EventRelay | null;

beforeEach(() => {
  bus = createEventBus();
  received = [];
  bus.subscribeAll((event) => received.push(event));
  relay = null;
});

afterEach(async () => {
  await relay?.stop();
  vi.useRealTimers();
});

function start(
  h: Harness,
  options: Partial<ConstructorParameters<typeof EventRelay>[0]> = {},
): Promise<void> {
  relay = new EventRelay({
    bus,
    log: silentLog,
    newClient: h.newClient,
    reconnectDelayMs: 10,
    maxReconnectDelayMs: 10,
    // Pinned jitter keeps the backoff exactly `reconnectDelayMs` so fake timers are precise.
    random: () => 1,
    ...options,
  });
  return relay.start();
}

describe('connecting', () => {
  it('issues LISTEN on the agreed channel and reports itself listening', async () => {
    const h = harness();
    await start(h);

    expect(h.clients).toHaveLength(1);
    expect(h.clients[0]?.queries).toEqual([`LISTEN ${EVENT_RELAY_CHANNEL}`]);
    expect(relay?.status).toMatchObject({
      state: 'listening',
      connects: 1,
      reconnects: 0,
      gaps: 0,
    });
  });

  it('does not reject when the database is not up yet — it schedules a retry', async () => {
    const h = harness();
    h.failNextConnect(new Error('ECONNREFUSED'));

    await expect(start(h)).resolves.toBeUndefined();
    expect(relay?.status).toMatchObject({ state: 'reconnecting', connects: 0 });
    expect(relay?.status.lastError).toBe('ECONNREFUSED');
  });
});

describe('relaying', () => {
  it('publishes a valid envelope onto the in-process bus, byte-identical', async () => {
    const h = harness();
    await start(h);

    const event = syncCompleted();
    h.clients[0]?.notify({ channel: EVENT_RELAY_CHANNEL, payload: payloadFor(event) });

    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).toBe(JSON.stringify(event));
    expect(relay?.status).toMatchObject({ received: 1, relayed: 1 });
  });

  it('ignores notifications on another channel', async () => {
    const h = harness();
    await start(h);

    h.clients[0]?.notify({ channel: 'pgboss_something', payload: payloadFor(syncCompleted()) });

    expect(received).toEqual([]);
    expect(relay?.status.received).toBe(0);
  });

  it('drops a duplicate envelope — delivery is at-least-once and subscribers have side effects', async () => {
    const h = harness();
    await start(h);

    const event = syncCompleted();
    const payload = payloadFor(event);
    h.clients[0]?.notify({ channel: EVENT_RELAY_CHANNEL, payload });
    h.clients[0]?.notify({ channel: EVENT_RELAY_CHANNEL, payload });

    expect(received).toHaveLength(1);
    expect(relay?.status).toMatchObject({ received: 2, relayed: 1, dropped: { duplicate: 1 } });
  });

  it.each([
    ['garbage that is not JSON', 'not json', 'unparsable'],
    ['an envelope with an unknown type', '{"type":"sync.exploded"}', 'unknownType'],
  ])('survives %s without dropping the connection', async (_label, payload, counter) => {
    const h = harness();
    await start(h);

    expect(() => {
      h.clients[0]?.notify({ channel: EVENT_RELAY_CHANNEL, payload });
    }).not.toThrow();

    expect(received).toEqual([]);
    expect(relay?.status.dropped[counter as 'unparsable' | 'unknownType']).toBe(1);
    expect(relay?.status.state).toBe('listening');
  });

  it('refuses an ephemeral delta even if something else on the box raises one', async () => {
    const h = harness();
    await start(h);

    // Hand-built: `notifyEvent` throws for this type, so it can only arrive from outside our
    // own code — a psql prompt, a future producer that forgot. §14.5 says WS-only, never
    // persisted, never queued; a durable cross-process path must therefore never carry it.
    h.clients[0]?.notify({
      channel: EVENT_RELAY_CHANNEL,
      payload: JSON.stringify({
        id: '018f6b30-4c2a-7d31-9e44-2f1a09b7c001',
        type: 'session.message.delta_appended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        source: 'backend',
        correlationId: null,
        payload: { sessionId: SESSION_ID, text: 'hi' },
      }),
    });

    expect(received).toEqual([]);
    expect(relay?.status.dropped.ephemeral).toBe(1);
  });

  it('tolerates a notification with no payload at all', async () => {
    const h = harness();
    await start(h);

    h.clients[0]?.notify({ channel: EVENT_RELAY_CHANNEL });

    expect(received).toEqual([]);
    expect(relay?.status.dropped.unparsable).toBe(1);
  });
});

describe('reconnect — the failure mode that is invisible without a test', () => {
  it('re-establishes and re-LISTENs after a connection error, and keeps delivering', async () => {
    vi.useFakeTimers();
    const h = harness();
    await start(h);

    h.clients[0]?.fail(new Error('connection terminated unexpectedly'));
    expect(relay?.status.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(50);

    expect(h.clients).toHaveLength(2);
    expect(h.clients[1]?.queries).toEqual([`LISTEN ${EVENT_RELAY_CHANNEL}`]);
    expect(relay?.status).toMatchObject({ state: 'listening', connects: 2, reconnects: 1 });

    // The point of the whole exercise: the relay is not merely "connected again", it delivers.
    const event = syncCompleted();
    h.clients[1]?.notify({ channel: EVENT_RELAY_CHANNEL, payload: payloadFor(event) });
    expect(received.map((entry) => entry.id)).toEqual([event.id]);
  });

  it('treats a server-side close (`end`) the same as an error', async () => {
    vi.useFakeTimers();
    const h = harness();
    await start(h);

    h.clients[0]?.finish();
    await vi.advanceTimersByTimeAsync(50);

    expect(h.clients).toHaveLength(2);
    expect(relay?.status).toMatchObject({ state: 'listening', connects: 2 });
  });

  it('keeps retrying while the database stays down, then recovers', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.failNextConnect(new Error('ECONNREFUSED'));
    await start(h);

    h.failNextConnect(new Error('ECONNREFUSED'));
    await vi.advanceTimersByTimeAsync(10);
    expect(relay?.status).toMatchObject({ state: 'reconnecting', connects: 0 });

    await vi.advanceTimersByTimeAsync(10);
    expect(relay?.status).toMatchObject({ state: 'listening', connects: 1 });

    const event = syncCompleted();
    h.clients.at(-1)?.notify({ channel: EVENT_RELAY_CHANNEL, payload: payloadFor(event) });
    expect(received.map((entry) => entry.id)).toEqual([event.id]);
  });

  it('backs off exponentially, capped', async () => {
    vi.useFakeTimers();
    const h = harness();
    relay = new EventRelay({
      bus,
      log: silentLog,
      newClient: h.newClient,
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 400,
      random: () => 1,
    });
    h.failNextConnect(new Error('down'));
    await relay.start();

    // 100 -> 200 -> 400 -> 400 (capped). Each step is proved by the attempt NOT firing early.
    for (const delay of [100, 200, 400, 400]) {
      h.failNextConnect(new Error('still down'));
      const before = h.clients.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.clients).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.clients).toHaveLength(before + 1);
    }
  });

  it('never lets the reconnect timer hold the process open (F8.1)', async () => {
    const h = harness();
    h.failNextConnect(new Error('down'));
    const unref = vi.spyOn(globalThis, 'setTimeout');
    await start(h);

    const timer = unref.mock.results.at(-1)?.value as NodeJS.Timeout;
    // `unref`ed timers report `hasRef() === false`.
    expect(timer.hasRef()).toBe(false);
    unref.mockRestore();
  });
});

describe('the gap policy — NOTIFY keeps no backlog', () => {
  it('announces a gap on reconnect, with how long the relay was deaf', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T10:00:00.000Z'));
    const onGap = vi.fn();
    const h = harness();
    await start(h, { onGap });

    expect(onGap).not.toHaveBeenCalled(); // first connect: there was no stream to have a gap in

    h.clients[0]?.fail(new Error('connection terminated'));
    await vi.advanceTimersByTimeAsync(50);

    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onGap.mock.calls[0]?.[0]).toMatchObject({ downForMs: expect.any(Number) as number });
    expect(relay?.status.gaps).toBe(1);
  });

  it('does not announce a gap for a first connect that had to retry', async () => {
    vi.useFakeTimers();
    const onGap = vi.fn();
    const h = harness();
    h.failNextConnect(new Error('ECONNREFUSED'));
    await start(h, { onGap });

    await vi.advanceTimersByTimeAsync(50);

    // The relay never delivered anything before this point, so nothing was missed: closing live
    // sockets here would be a spurious reconnect storm at boot.
    expect(relay?.status.state).toBe('listening');
    expect(onGap).not.toHaveBeenCalled();
  });

  it('survives a gap handler that throws', async () => {
    vi.useFakeTimers();
    const h = harness();
    await start(h, {
      onGap: () => {
        throw new Error('hub exploded');
      },
    });

    h.clients[0]?.fail(new Error('connection terminated'));
    await vi.advanceTimersByTimeAsync(50);

    expect(relay?.status).toMatchObject({ state: 'listening', gaps: 1 });
  });
});

describe('shutdown', () => {
  it('ends the connection and stops relaying', async () => {
    const h = harness();
    await start(h);
    await relay?.stop();

    expect(h.clients[0]?.ended).toBe(true);
    expect(relay?.status.state).toBe('stopped');

    h.clients[0]?.notify({ channel: EVENT_RELAY_CHANNEL, payload: payloadFor(syncCompleted()) });
    expect(received).toEqual([]);
  });

  it('cancels a pending reconnect rather than resurrecting after stop', async () => {
    vi.useFakeTimers();
    const h = harness();
    await start(h);

    h.clients[0]?.fail(new Error('connection terminated'));
    await relay?.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.clients).toHaveLength(1);
    expect(relay?.status.state).toBe('stopped');
  });

  it('is idempotent', async () => {
    const h = harness();
    await start(h);
    await relay?.stop();
    await expect(relay?.stop()).resolves.toBeUndefined();
  });
});
