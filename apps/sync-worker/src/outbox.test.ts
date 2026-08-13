import { type Db, NOTIFY_MAX_PAYLOAD_BYTES, QUEUE_NAMES, type QueuePort } from '@mc/shared';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { WorkerOutbox } from './outbox.js';

/**
 * `WorkerOutbox` (F6.3 + TDS 04 §15.1), with no database.
 *
 * The property this file protects is the one whose absence was the original defect: a worker
 * event that is enqueued but never relayed reaches **nobody** — the Telegram Worker drains the
 * `events` queue and discards it, and no browser ever hears about the sync run. So the test is
 * not "does `emit` enqueue", it is "does `emit` do *both*, on *one* transaction".
 */

interface Recorder {
  readonly db: Db;
  readonly statements: { sql: string; params: unknown[] }[];
  /** `true` once the transaction callback has returned; nothing may run after it. */
  committed: boolean;
}

function fakeDb(): Recorder {
  const statements: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const recorder = { statements, committed: false } as Recorder & { committed: boolean };

  const tx = {
    execute: vi.fn(async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      statements.push({ sql: compiled.sql, params: compiled.params });
      return { rows: [] };
    }),
  };

  const db = {
    transaction: async <T>(work: (handle: unknown) => Promise<T>): Promise<T> => {
      const result = await work(tx);
      recorder.committed = true;
      return result;
    },
  } as unknown as Db;

  return Object.assign(recorder, { db });
}

function fakeQueue(): {
  queue: QueuePort;
  enqueued: { queue: string; eventId: string; tx: unknown }[];
} {
  const enqueued: { queue: string; eventId: string; tx: unknown }[] = [];
  return {
    enqueued,
    queue: {
      enqueue: async (tx, name, event) => {
        enqueued.push({ queue: name, eventId: event.id, tx });
      },
      enqueueJob: async () => undefined,
    },
  };
}

describe('WorkerOutbox.emit', () => {
  it('enqueues the durable job AND raises the relay notify, on the caller’s transaction', async () => {
    const recorder = fakeDb();
    const { queue, enqueued } = fakeQueue();
    const outbox = new WorkerOutbox({ db: recorder.db, queue });

    const event = outbox.event('sync.completed', {
      syncRunId: '018f6b2e-1111-7abc-8def-0123456789ab',
      notesExported: 2,
      notesImported: 0,
      conflicts: 0,
    });

    await outbox.run(async (ctx) => {
      await ctx.emit(event);
    });

    expect(enqueued).toEqual([
      { queue: QUEUE_NAMES.EVENTS, eventId: event.id, tx: expect.anything() },
    ]);
    // Same handle for both halves — that is what makes them atomic with the domain write, and
    // what makes a rollback discard the notification rather than announce a run that never was.
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0]?.sql).toMatch(/pg_notify/);
    expect(recorder.statements[0]?.params[0]).toBe('mc_events');
    expect(JSON.parse(String(recorder.statements[0]?.params[1]))).toMatchObject({
      id: event.id,
      type: 'sync.completed',
      source: 'sync-worker',
    });
  });

  it('stamps `source: sync-worker` on everything it builds (F6.2)', () => {
    const recorder = fakeDb();
    const { queue } = fakeQueue();
    const outbox = new WorkerOutbox({ db: recorder.db, queue });

    expect(outbox.event('sync.started', { syncRunId: 'x' }).source).toBe('sync-worker');
  });

  it('keeps the durable copy and reports when an envelope is too large to relay', async () => {
    const recorder = fakeDb();
    const { queue, enqueued } = fakeQueue();
    const onUndeliverable = vi.fn();
    const outbox = new WorkerOutbox({ db: recorder.db, queue, onUndeliverable });

    await outbox.run(async (ctx) => {
      await ctx.emit(
        outbox.event('sync.conflict_detected', {
          syncRunId: '018f6b2e-1111-7abc-8def-0123456789ab',
          // A pathological vault path. F6 payloads are ids and scalars (F6.1) so this cannot
          // happen today; the point is that it degrades rather than aborting the sync run.
          path: 'x'.repeat(NOTIFY_MAX_PAYLOAD_BYTES),
          resolution: 'newer_wins',
        }),
      );
    });

    expect(recorder.committed).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(recorder.statements).toHaveLength(0);
    expect(onUndeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'oversized', limit: NOTIFY_MAX_PAYLOAD_BYTES }),
    );
  });
});
