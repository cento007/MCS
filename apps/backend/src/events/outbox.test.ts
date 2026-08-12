import {
  createNoopQueue,
  type Db,
  type DbTransaction,
  type EventEnvelope,
  QUEUE_NAMES,
} from '@mc/shared';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './bus.js';
import { Outbox } from './outbox.js';

/**
 * The outbox's *sequencing* rules, provable with no database (TDS 07 §1 — the unit tier stays
 * DB-free). The atomicity claim itself needs a real transaction and is proved in
 * `outbox.int.test.ts`; what is proved here is everything around it:
 *
 *   - `emit` enqueues on the caller's transaction handle, not on some ambient connection;
 *   - the in-process relay fires **after** commit, never before, so a client is never told
 *     about a change that then rolls back;
 *   - a rollback publishes nothing at all;
 *   - ephemeral event types are refused outright (TDS 04 §15.2 row 10).
 */

/** A `Db` whose `transaction` runs the callback against a sentinel handle. */
function fakeDb(): { db: Db; tx: DbTransaction } {
  const tx = { __marker: 'tx' } as unknown as DbTransaction;
  const db = {
    transaction: async <T>(callback: (handle: DbTransaction) => Promise<T>): Promise<T> =>
      callback(tx),
  } as unknown as Db;
  return { db, tx };
}

describe('Outbox', () => {
  it('enqueues each emitted event on the caller transaction, on the events queue', async () => {
    const { db, tx } = fakeDb();
    const queue = createNoopQueue();
    const enqueue = vi.spyOn(queue, 'enqueue');
    const outbox = new Outbox({ db, queue });

    await outbox.run(async (ctx) => {
      await ctx.emit(outbox.event('session.created', { sessionId: 'a' }));
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toBe(tx);
    expect(enqueue.mock.calls[0]?.[1]).toBe(QUEUE_NAMES.EVENTS);
    expect(queue.enqueued[0]?.event.type).toBe('session.created');
  });

  it('stamps the envelope with this process as the source', async () => {
    const { db } = fakeDb();
    const outbox = new Outbox({ db, queue: createNoopQueue() });

    const envelope = outbox.event('session.started', { sessionId: 'a' });

    expect(envelope.source).toBe('backend');
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.correlationId).toBeNull();
  });

  it('publishes to the in-process bus only after the transaction resolves', async () => {
    const { db } = fakeDb();
    const bus = createEventBus();
    const seen: EventEnvelope[] = [];
    bus.subscribeAll((event) => seen.push(event));

    const outbox = new Outbox({ db, queue: createNoopQueue(), bus });

    await outbox.run(async (ctx) => {
      await ctx.emit(outbox.event('session.created', { sessionId: 'a' }));
      // Still inside the transaction: nothing may have been relayed yet.
      expect(seen).toHaveLength(0);
      expect(ctx.emitted).toHaveLength(1);
    });

    expect(seen.map((event) => event.type)).toEqual(['session.created']);
  });

  it('publishes nothing when the transaction fails', async () => {
    const tx = {} as unknown as DbTransaction;
    const db = {
      transaction: async <T>(callback: (handle: DbTransaction) => Promise<T>): Promise<T> => {
        // A real Drizzle transaction rethrows after rolling back; so does this.
        return callback(tx);
      },
    } as unknown as Db;

    const bus = createEventBus();
    const seen: EventEnvelope[] = [];
    bus.subscribeAll((event) => seen.push(event));
    const outbox = new Outbox({ db, queue: createNoopQueue(), bus });

    await expect(
      outbox.run(async (ctx) => {
        await ctx.emit(outbox.event('session.created', { sessionId: 'a' }));
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');

    expect(seen).toHaveLength(0);
  });

  it('refuses to enqueue an ephemeral event type', async () => {
    const { db } = fakeDb();
    const queue = createNoopQueue();
    const outbox = new Outbox({ db, queue });

    await expect(
      outbox.run(async (ctx) => {
        await ctx.emit(outbox.event('session.message.delta_appended', { sessionId: 'a' }));
      }),
    ).rejects.toThrow(/ephemeral/);

    expect(queue.enqueued).toHaveLength(0);
  });

  it('joins an open transaction instead of starting a second one', async () => {
    const { db } = fakeDb();
    const transaction = vi.spyOn(db, 'transaction');
    const outbox = new Outbox({ db, queue: createNoopQueue() });

    await outbox.run(async (outer) => {
      await outbox.join(outer, async (inner) => {
        expect(inner).toBe(outer);
      });
    });

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('starts a transaction when `join` is given none', async () => {
    const { db } = fakeDb();
    const transaction = vi.spyOn(db, 'transaction');
    const outbox = new Outbox({ db, queue: createNoopQueue() });

    await outbox.join(undefined, async (ctx) => {
      expect(ctx.tx).toBeDefined();
    });

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
