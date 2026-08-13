import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  createEvent,
  EVENT_RELAY_CHANNEL,
  type EventEnvelope,
  emitWorkerEvent,
  NOTIFY_MAX_PAYLOAD_BYTES,
  newId,
  notifyEvent,
  type PgBossQueue,
  QUEUE_NAMES,
  schema,
} from '@mc/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  cookieValueFrom,
  createTestApp,
  seedUser,
  type TestApp,
  testDatabase,
  testDatabaseUrl,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { ServerFrame } from '../ws/protocol.js';
import { WS_CLOSE, WS_PATH } from '../ws/protocol.js';
import { createEventBus, type EventBus } from './bus.js';
import { createPgRelayClient, EventRelay, RELAY_APPLICATION_NAME } from './relay.js';

/**
 * The worker -> hub relay, end to end (TDS 04 §15.1).
 *
 * Everything here is real: a real PostgreSQL `LISTEN` on its own dedicated connection, a real
 * `pg_notify` raised from a **separate connection pool** standing in for a worker process, a
 * real Fastify listener, and a real `ws` client. Nothing about the fan-out is mocked, because
 * the property under test is precisely the one a mock would assume.
 *
 * ## Why `pg_notify` and not another pg-boss subscription
 *
 * `pgboss.job` rows are claimed with `FOR UPDATE SKIP LOCKED` — one job, one winner. Two
 * Backends on the `events` queue would steal each other's envelopes, which is exactly the trap
 * TDS 04 §15.2's consumer column walks into. `NOTIFY` has no row and no lock: the server copies
 * the payload to every listening session. "Two listeners both receive it" below is that
 * difference, demonstrated rather than asserted in a comment.
 */

const ALLOWED_ORIGIN = 'http://127.0.0.1:8710'; // `MC_HOST`:`MC_PORT` from `testConfig()`
const SYNC_RUN_ID = '018f6b2e-1111-7abc-8def-0123456789ab';

let built: TestApp;
let wsUrl: string;
let cookie: string;
let queue: PgBossQueue;
/** Stands in for a worker process: its own pool, its own connections, no Backend imports. */
let workerPool: pg.Pool;
let workerDb: ReturnType<typeof drizzle<typeof schema>>;
const openSockets: WebSocket[] = [];
const openRelays: EventRelay[] = [];

interface Client {
  readonly socket: WebSocket;
  readonly frames: ServerFrame[];
  readonly closes: { code: number; reason: string }[];
  send(frame: unknown): void;
  await(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
}

async function connect(): Promise<Client> {
  const socket = new WebSocket(wsUrl, { headers: { origin: ALLOWED_ORIGIN, cookie } });
  const frames: ServerFrame[] = [];
  const closes: { code: number; reason: string }[] = [];

  socket.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString('utf8')) as ServerFrame);
  });
  socket.on('close', (code: number, reason: Buffer) => {
    closes.push({ code, reason: reason.toString('utf8') });
  });

  await once(socket, 'open');
  openSockets.push(socket);

  const client: Client = {
    socket,
    frames,
    closes,
    send: (frame) => {
      socket.send(JSON.stringify(frame));
    },
    await: async (predicate) => {
      let found: ServerFrame | undefined;
      // Generous, because this tier runs eight forks in parallel and a starved fork must fail
      // on the assertion it is making rather than on a stopwatch.
      await vi.waitFor(
        () => {
          found = frames.find(predicate);
          expect(found).toBeDefined();
        },
        { timeout: 15_000, interval: 25 },
      );
      return found as ServerFrame;
    },
  };

  await client.await((frame) => frame.type === 'hello');
  return client;
}

async function subscribe(client: Client, channels: string[]): Promise<void> {
  const id = newId();
  client.send({ type: 'subscribe', id, channels });
  await client.await((frame) => frame.type === 'ack' && frame.id === id);
}

/**
 * Emit exactly as a worker does: durable enqueue plus relay notify, in one transaction, over a
 * connection the Backend does not own.
 */
async function emitFromWorker(
  event: EventEnvelope,
  options: Parameters<typeof emitWorkerEvent>[3] = {},
): Promise<void> {
  await workerDb.transaction(async (tx) => {
    await emitWorkerEvent(tx, queue, event, options);
  });
}

function syncCompleted(overrides: Partial<{ id: string }> = {}): EventEnvelope {
  return createEvent(
    'sync.completed',
    'sync-worker',
    { syncRunId: SYNC_RUN_ID, notesExported: 4, notesImported: 2, conflicts: 0 },
    { correlationId: SYNC_RUN_ID, ...(overrides.id === undefined ? {} : { id: overrides.id }) },
  );
}

/**
 * A second, independent relay — a stand-in for a second Backend process.
 *
 * Each one costs a dedicated `LISTEN` connection, and this tier already runs eight forks
 * against a stock `max_connections`, so they are released in `afterEach` rather than
 * accumulating across the file (TDS 07 §4's connection-budget note in the integration config).
 */
async function extraRelay(): Promise<{ relay: EventRelay; bus: EventBus; seen: EventEnvelope[] }> {
  const bus = createEventBus();
  const seen: EventEnvelope[] = [];
  bus.subscribeAll((event) => seen.push(event));

  const relay = new EventRelay({
    bus,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    newClient: () => createPgRelayClient(testDatabaseUrl()),
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 200,
  });
  await relay.start();
  openRelays.push(relay);
  return { relay, bus, seen };
}

beforeAll(async () => {
  await truncateAll();
  const user = await seedUser();
  queue = await testQueue();

  // A separate pool, deliberately: the fan-out must be exercised across real connections, not
  // by two objects sharing one.
  workerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
  workerPool.on('error', () => {
    /* the pool discards the client itself */
  });
  workerDb = drizzle(workerPool, { schema });

  built = createTestApp({
    queue,
    // The relay is off by default in the harness (one dedicated LISTEN connection per app);
    // this suite is the one that wants it.
    eventRelay: { reconnectDelayMs: 50, maxReconnectDelayMs: 200 },
  });

  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}${WS_PATH}`;

  const login = await built.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = `${SESSION_COOKIE_NAME}=${cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME)}`;
});

beforeEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  // The app's own relay must be listening before a test emits: `NOTIFY` is not durable, so an
  // event raised while the listener is down is genuinely gone. The previous test may have
  // terminated its connection.
  await vi.waitFor(
    () => {
      expect(built.eventRelay?.status.state).toBe('listening');
    },
    { timeout: 15_000, interval: 50 },
  );
});

afterEach(async () => {
  for (const relay of openRelays.splice(0)) await relay.stop();
});

afterAll(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  for (const relay of openRelays.splice(0)) await relay.stop();
  await workerPool.end();
});

describe('a worker event reaches a subscribed browser', () => {
  it('arrives on the sync channel with a byte-identical envelope', async () => {
    const client = await connect();
    await subscribe(client, ['sync']);

    const event = syncCompleted();
    await emitFromWorker(event);

    const frame = (await client.await(
      (candidate) => candidate.type === 'event' && candidate.event.id === event.id,
    )) as { type: 'event'; channel: string; event: EventEnvelope };

    expect(frame.channel).toBe('sync');
    // Byte equality, so a relay that "helpfully" re-stamped `id` or `occurredAt` — or reordered
    // the envelope — fails here rather than in production, where it would break every consumer's
    // de-duplication at once (F6.3).
    expect(JSON.stringify(frame.event)).toBe(JSON.stringify(event));
  });

  it('routes to exactly the channel an in-process publish of the same envelope would', async () => {
    const client = await connect();
    await subscribe(client, ['sync', 'notifications', 'sessions']);

    const relayed = syncCompleted();
    await emitFromWorker(relayed);
    await client.await((frame) => frame.type === 'event' && frame.event.id === relayed.id);

    // The in-process twin: same type, published straight onto the bus the outbox uses.
    const inProcess = syncCompleted({ id: newId() });
    built.bus.publish(inProcess);
    await client.await((frame) => frame.type === 'event' && frame.event.id === inProcess.id);

    const channelsFor = (id: string): string[] =>
      client.frames
        .filter(
          (
            frame,
          ): frame is ServerFrame & { type: 'event'; channel: string; event: EventEnvelope } =>
            frame.type === 'event' && frame.event.id === id,
        )
        .map((frame) => frame.channel);

    // The whole reason the relay injects into the bus rather than calling the hub directly:
    // provenance changes nothing about routing (`ws/channels.ts` is the one filter).
    expect(channelsFor(relayed.id)).toEqual(channelsFor(inProcess.id));
    expect(channelsFor(relayed.id)).toEqual(['sync']);
  });

  it('carries a Telegram Worker notification.sent to the notifications channel', async () => {
    const client = await connect();
    await subscribe(client, ['notifications']);

    const event = createEvent('notification.sent', 'telegram-worker', {
      notificationId: newId(),
      channel: 'telegram',
    });
    await emitFromWorker(event);

    const frame = (await client.await(
      (candidate) => candidate.type === 'event' && candidate.event.id === event.id,
    )) as { type: 'event'; channel: string };
    expect(frame.channel).toBe('notifications');
  });

  it('leaves the durable copy on the events queue — the relay is additive, not a replacement', async () => {
    const event = syncCompleted();
    await emitFromWorker(event);

    const rows = await testDatabase().db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS} AND id = ${event.id}`,
    );
    expect(rows.rows[0]?.count).toBe('1');
  });
});

describe('fan-out, not competing consumption', () => {
  it('delivers the same envelope to two independent Backend listeners', async () => {
    const first = await extraRelay();
    const second = await extraRelay();

    const event = syncCompleted();
    await emitFromWorker(event);

    // Both. If this relay were a pg-boss subscription, exactly one of these would ever fire and
    // the other Backend would be silently blind — which is the defect this design avoids.
    await vi.waitFor(() => {
      expect(first.seen.map((entry) => entry.id)).toContain(event.id);
      expect(second.seen.map((entry) => entry.id)).toContain(event.id);
    });

    // …and the app's own relay, which is a third listener on the same channel.
    expect(built.eventRelay?.status.relayed).toBeGreaterThan(0);
  });

  it('does not consume anything: the job stays on the queue for its real consumer', async () => {
    const first = await extraRelay();
    const event = syncCompleted();
    await emitFromWorker(event);

    await vi.waitFor(() => {
      expect(first.seen.map((entry) => entry.id)).toContain(event.id);
    });

    const rows = await testDatabase().db.execute<{ state: string }>(
      sql`SELECT state FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS} AND id = ${event.id}`,
    );
    // `created`, not `active`/`completed`: nothing about the relay touches the job's lifecycle.
    expect(rows.rows[0]?.state).toBe('created');
  });
});

describe('the two PostgreSQL limits, deliberately', () => {
  it('drops an oversized envelope without failing the transaction that produced it', async () => {
    const client = await connect();
    await subscribe(client, ['sync']);

    const undeliverable: unknown[] = [];
    const event = createEvent(
      'sync.conflict_detected',
      'sync-worker',
      {
        syncRunId: SYNC_RUN_ID,
        path: 'x'.repeat(NOTIFY_MAX_PAYLOAD_BYTES),
        resolution: 'manual_pending',
      },
      { correlationId: SYNC_RUN_ID },
    );

    // The transaction commits. That is the point: a `NOTIFY` that raised 22023 inside it would
    // roll back the sync run whose completion it was announcing.
    await emitFromWorker(event, { onUndeliverable: (info) => undeliverable.push(info) });

    expect(undeliverable).toHaveLength(1);

    // The durable copy is intact…
    const rows = await testDatabase().db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS} AND id = ${event.id}`,
    );
    expect(rows.rows[0]?.count).toBe('1');

    // …and nothing reached the browser, which is the honest outcome for a hint that could not
    // be carried. A follower event proves the relay is still alive rather than merely quiet.
    const follower = syncCompleted();
    await emitFromWorker(follower);
    await client.await((frame) => frame.type === 'event' && frame.event.id === follower.id);
    expect(
      client.frames.some((frame) => frame.type === 'event' && frame.event.id === event.id),
    ).toBe(false);
  });

  it('refuses to relay an ephemeral delta, and drops one that arrives anyway', async () => {
    const { relay, seen } = await extraRelay();
    const before = relay.status.dropped.ephemeral;

    const delta = createEvent('session.message.delta_appended', 'backend', {
      sessionId: SYNC_RUN_ID,
      text: 'partial',
    });

    // Producer side: unrepresentable.
    await expect(
      workerDb.transaction(async (tx) => {
        await notifyEvent(tx, delta);
      }),
    ).rejects.toThrow(/ephemeral/);

    // Consumer side: refused even when raised straight from SQL, because "never persisted,
    // never queued" (§14.5) has to hold against anything with database access, not just
    // against our own producers.
    await testDatabase().db.execute(
      sql`SELECT pg_notify(${EVENT_RELAY_CHANNEL}, ${JSON.stringify(delta)})`,
    );

    await vi.waitFor(() => {
      expect(relay.status.dropped.ephemeral).toBe(before + 1);
    });
    expect(seen.map((entry) => entry.type)).not.toContain('session.message.delta_appended');
  });
});

describe('operator visibility', () => {
  it('reports the relay in GET /services/health', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/v1/services/health',
      headers: { cookie },
    });

    const body = JSON.parse(response.body) as {
      data: { services: { name: string; status: string; meta: Record<string, unknown> | null }[] };
    };
    const backend = body.data.services.find((service) => service.name === 'backend');

    expect(backend?.status).toBe('healthy');
    expect(backend?.meta).toMatchObject({
      eventRelay: { state: 'listening', channel: EVENT_RELAY_CHANNEL },
    });
  });

  it('is findable in pg_stat_activity by application_name', async () => {
    const rows = await testDatabase().db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
        FROM pg_stat_activity
       WHERE application_name = ${RELAY_APPLICATION_NAME}
         AND datname = current_database()
    `);
    expect(Number(rows.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });
});

/**
 * Last on purpose: `pg_terminate_backend` kills **every** relay connection on this database,
 * including the app's own, so anything that assumed a settled `listening` state would become
 * order-dependent if it ran after.
 */
describe('the listener reconnects after its connection is dropped', () => {
  /** Kill every relay `LISTEN` on this test's database. Other Vitest forks have their own. */
  async function dropRelayConnections(): Promise<number> {
    const killed = await testDatabase().db.execute<{ pid: number }>(sql`
      SELECT pg_terminate_backend(pid) AS terminated, pid
        FROM pg_stat_activity
       WHERE application_name = ${RELAY_APPLICATION_NAME}
         AND datname = current_database()
         AND pid <> pg_backend_pid()
    `);
    return killed.rows.length;
  }

  it('re-establishes, re-LISTENs, and keeps delivering', async () => {
    const { relay, seen } = await extraRelay();
    const before = relay.status.connects;

    // A real drop — the database terminates the relay's backend, exactly as a restart or a
    // network reaper would. Nothing here simulates the failure at the driver boundary.
    expect(await dropRelayConnections()).toBeGreaterThan(0);

    await vi.waitFor(
      () => {
        expect(relay.status.state).toBe('listening');
        expect(relay.status.connects).toBeGreaterThan(before);
      },
      { timeout: 15_000, interval: 50 },
    );

    // The assertion that matters: not "it reconnected" but "it still relays". A `LISTEN` lost
    // on reconnect leaves a relay that looks perfectly healthy and delivers nothing — the exact
    // silent death this whole mechanism has to rule out.
    const event = syncCompleted();
    await emitFromWorker(event);
    await vi.waitFor(
      () => {
        expect(seen.map((entry) => entry.id)).toContain(event.id);
      },
      { timeout: 15_000, interval: 50 },
    );

    expect(relay.status.gaps).toBeGreaterThan(0);
  }, 45_000);

  it('closes live websockets after a gap so clients refetch (§14.7)', async () => {
    const client = await connect();
    await subscribe(client, ['sync']);

    await dropRelayConnections();

    // `NOTIFY` keeps no backlog and F6.3 forbids a replay buffer, so the server cannot tell the
    // client what it missed. It invokes the recovery the contract already defines instead.
    await vi.waitFor(
      () => {
        expect(client.closes[0]?.code).toBe(WS_CLOSE.RELAY_GAP);
      },
      { timeout: 15_000, interval: 50 },
    );

    // A fresh connection is fully served again — the gap is a blip, not a one-way door.
    //
    // The wait is not incidental: `NOTIFY` has no backlog, so an event emitted before the relay
    // has re-`LISTEN`ed is genuinely lost. That is the property under test, not a flake to be
    // retried away — the gap close exists precisely because those events cannot be recovered.
    await vi.waitFor(
      () => {
        expect(built.eventRelay?.status.state).toBe('listening');
      },
      { timeout: 15_000, interval: 50 },
    );

    const reconnected = await connect();
    await subscribe(reconnected, ['sync']);
    const event = syncCompleted();
    await emitFromWorker(event);
    await vi.waitFor(
      () => {
        expect(
          reconnected.frames.some((frame) => frame.type === 'event' && frame.event.id === event.id),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 50 },
    );
  }, 45_000);
});
