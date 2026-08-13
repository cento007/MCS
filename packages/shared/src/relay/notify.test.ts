import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { DbTransaction } from '../db/index.js';
import { createEvent, type EventEnvelope } from '../events/index.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueuePort } from '../queue/port.js';
import { EVENT_RELAY_CHANNEL, NOTIFY_MAX_PAYLOAD_BYTES } from './codec.js';
import { emitWorkerEvent, notifyEvent } from './notify.js';

/**
 * The producer half of the relay (TDS 04 §15.1), driven with no database.
 *
 * The properties under test are the ones that would otherwise only fail in production:
 *   - the notify runs on the CALLER'S transaction handle, which is what makes it atomic with
 *     the domain write and the durable job;
 *   - the durable enqueue happens FIRST, so a notify failure unwinds everything rather than
 *     leaving a browser told about a job that does not exist;
 *   - an oversized payload issues NO SQL at all — a `NOTIFY` that raised 22023 inside the
 *     transaction would roll back the sync run that produced it;
 *   - an ephemeral event cannot travel this path at all.
 */

const CHANNEL_CALL = /pg_notify/;

interface FakeTx {
  readonly tx: DbTransaction;
  readonly executed: { sql: string; params: unknown[] }[];
}

/**
 * A transaction double that compiles the Drizzle `SQL` object with the **real** PostgreSQL
 * dialect, so the test asserts on the statement and the bound parameters a server would
 * actually receive — not on a hand-rolled approximation of them.
 */
function fakeTransaction(): FakeTx {
  const executed: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();

  const tx = {
    execute: vi.fn(async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      executed.push({ sql: compiled.sql, params: compiled.params });
      return { rows: [] };
    }),
  } as unknown as DbTransaction;

  return { tx, executed };
}

function fakeQueue(): { queue: QueuePort; enqueued: { queue: string; event: EventEnvelope }[] } {
  const enqueued: { queue: string; event: EventEnvelope }[] = [];
  const queue: QueuePort = {
    enqueue: async (_tx, name, event) => {
      enqueued.push({ queue: name, event });
    },
    enqueueJob: async () => {
      throw new Error('not used');
    },
  };
  return { queue, enqueued };
}

function syncCompleted(payload: Record<string, unknown> = {}): EventEnvelope {
  return createEvent('sync.completed', 'sync-worker', {
    syncRunId: '018f6b2e-1111-7abc-8def-0123456789ab',
    notesExported: 1,
    notesImported: 0,
    conflicts: 0,
    ...payload,
  });
}

describe('notifyEvent', () => {
  it('issues pg_notify on the caller’s transaction, with the channel and payload as parameters', async () => {
    const { tx, executed } = fakeTransaction();

    const outcome = await notifyEvent(tx, syncCompleted());

    expect(outcome).toEqual({ delivered: true, bytes: expect.any(Number) as unknown as number });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toMatch(CHANNEL_CALL);
    // Bound parameters, never string-spliced: the payload is JSON from a domain object.
    expect(executed[0]?.params[0]).toBe(EVENT_RELAY_CHANNEL);
    expect(JSON.parse(String(executed[0]?.params[1]))).toMatchObject({ type: 'sync.completed' });
  });

  it('degrades to a counted no-op when the payload exceeds the NOTIFY limit', async () => {
    const { tx, executed } = fakeTransaction();
    const onUndeliverable = vi.fn();
    const event = syncCompleted({ path: 'x'.repeat(NOTIFY_MAX_PAYLOAD_BYTES) });

    const outcome = await notifyEvent(tx, event, { onUndeliverable });

    // The chosen degradation: refuse, report, return — never throw, because the caller is
    // inside a transaction whose domain write must still commit.
    expect(outcome).toEqual({
      delivered: false,
      reason: 'oversized',
      bytes: expect.any(Number) as unknown as number,
    });
    expect(executed).toHaveLength(0);
    expect(onUndeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'oversized', event, limit: NOTIFY_MAX_PAYLOAD_BYTES }),
    );
  });

  it('is silent-but-safe when no onUndeliverable is wired', async () => {
    const { tx, executed } = fakeTransaction();
    const event = syncCompleted({ path: 'x'.repeat(NOTIFY_MAX_PAYLOAD_BYTES) });

    await expect(notifyEvent(tx, event)).resolves.toMatchObject({ delivered: false });
    expect(executed).toHaveLength(0);
  });

  it('refuses to relay the ephemeral delta type (§14.5, §15.2 row 10)', async () => {
    const { tx, executed } = fakeTransaction();
    const delta = createEvent('session.message.delta_appended', 'backend', {
      sessionId: '018f6b2e-1111-7abc-8def-0123456789ab',
    });

    await expect(notifyEvent(tx, delta)).rejects.toThrow(/ephemeral/);
    expect(executed).toHaveLength(0);
  });

  it('honours a channel override so a test can isolate itself from a shared database', async () => {
    const { tx, executed } = fakeTransaction();
    await notifyEvent(tx, syncCompleted(), { channel: 'mc_events_test' });
    expect(executed[0]?.params[0]).toBe('mc_events_test');
  });
});

describe('emitWorkerEvent', () => {
  it('enqueues the durable job first, then relays — both on the one transaction', async () => {
    const { tx, executed } = fakeTransaction();
    const { queue, enqueued } = fakeQueue();
    const event = syncCompleted();

    await emitWorkerEvent(tx, queue, event);

    expect(enqueued).toEqual([{ queue: QUEUE_NAMES.EVENTS, event }]);
    expect(executed).toHaveLength(1);
  });

  it('still enqueues the durable copy when the envelope is too large to relay', async () => {
    const { tx, executed } = fakeTransaction();
    const { queue, enqueued } = fakeQueue();
    const event = syncCompleted({ path: 'x'.repeat(NOTIFY_MAX_PAYLOAD_BYTES) });

    const outcome = await emitWorkerEvent(tx, queue, event);

    expect(outcome).toMatchObject({ delivered: false, reason: 'oversized' });
    expect(enqueued).toHaveLength(1);
    expect(executed).toHaveLength(0);
  });

  it('does not relay when the durable enqueue fails', async () => {
    const { tx, executed } = fakeTransaction();
    const queue: QueuePort = {
      enqueue: async () => {
        throw new Error('pgboss unavailable');
      },
      enqueueJob: async () => undefined,
    };

    await expect(emitWorkerEvent(tx, queue, syncCompleted())).rejects.toThrow('pgboss unavailable');
    expect(executed).toHaveLength(0);
  });
});
