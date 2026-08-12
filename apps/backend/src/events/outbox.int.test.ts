import {
  createJob,
  type EventEnvelope,
  newId,
  type PgBossQueue,
  QUEUE_NAMES,
  schema,
} from '@mc/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  seedOperatorRow,
  seedProject,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { createEventBus } from './bus.js';
import { Outbox } from './outbox.js';

/**
 * **The guardrail that keeps F6.3's "transactional outbox by construction" true forever**
 * (TDS 07 §7.1, mandatory).
 *
 * Both directions are asserted, because only the pair proves anything: committing together is
 * what makes delivery reliable, and rolling back together is what stops a consumer acting on a
 * domain change that never happened.
 *
 * The mechanism under test is the one TDS 03 §7.2 pins — pg-boss's job INSERT routed through
 * the caller's Drizzle transaction. This runs against real PostgreSQL and real pg-boss, because
 * a fake could not tell the difference between "same transaction" and "same process".
 */

type JobRow = {
  id: string;
  name: string;
  data: EventEnvelope;
};

let queue: PgBossQueue;
let projectId: string;
let userId: string;

async function jobs(name: string = QUEUE_NAMES.EVENTS): Promise<JobRow[]> {
  const result = await testDatabase().db.execute<JobRow>(
    sql`SELECT id, name, data FROM pgboss.job WHERE name = ${name} ORDER BY created_on`,
  );
  return result.rows;
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  userId = await seedOperatorRow();
  ({ projectId } = await seedProject());
});

describe('transactional outbox — commit path', () => {
  it('commits the domain row and the job together', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });
    const sessionId = newId();

    await outbox.run(async (ctx) => {
      await ctx.tx.insert(schema.sessions).values({
        id: sessionId,
        projectId,
        userId,
        sessionType: 'managed',
        state: 'created',
      });
      await ctx.emit(outbox.event('session.created', { sessionId, projectId }));
    });

    const rows = await testDatabase()
      .db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(rows).toHaveLength(1);

    const enqueued = await jobs();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data.type).toBe('session.created');
    expect(enqueued[0]?.data.payload['sessionId']).toBe(sessionId);
  });

  it('carries the F6.2 envelope through the queue unchanged', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });
    const correlationId = newId();

    await outbox.run(async (ctx) => {
      await ctx.emit(
        outbox.event(
          'session.state_changed',
          { sessionId: 'x', fromState: 'created' },
          {
            correlationId,
          },
        ),
      );
    });

    const envelope = (await jobs())[0]?.data as EventEnvelope;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.source).toBe('backend');
    expect(envelope.correlationId).toBe(correlationId);
    expect(typeof envelope.occurredAt).toBe('string');
    expect(envelope.occurredAt.endsWith('Z')).toBe(true);
  });

  it('relays to the in-process bus only after the commit', async () => {
    const bus = createEventBus();
    const relayed: string[] = [];
    bus.subscribeAll((event) => relayed.push(event.type));

    const outbox = new Outbox({ db: testDatabase().db, queue, bus });
    const sessionId = newId();

    await outbox.run(async (ctx) => {
      await ctx.tx.insert(schema.sessions).values({
        id: sessionId,
        projectId,
        userId,
        sessionType: 'managed',
        state: 'created',
      });
      await ctx.emit(outbox.event('session.created', { sessionId }));
      expect(relayed).toEqual([]);
    });

    expect(relayed).toEqual(['session.created']);
  });
});

describe('transactional outbox — rollback path', () => {
  it('leaves neither the domain row nor the job when the domain write fails', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });
    const sessionId = newId();

    await expect(
      outbox.run(async (ctx) => {
        await ctx.tx.insert(schema.sessions).values({
          id: sessionId,
          projectId,
          userId,
          sessionType: 'managed',
          state: 'created',
        });
        await ctx.emit(outbox.event('session.created', { sessionId }));

        // The domain write that fails *after* the enqueue — the exact ordering the outbox has
        // to survive. A FK to a project that does not exist is a real constraint violation,
        // not a thrown sentinel, so PostgreSQL is the thing that aborts the transaction.
        await ctx.tx.insert(schema.sessions).values({
          id: newId(),
          projectId: newId(),
          userId,
          sessionType: 'managed',
          state: 'created',
        });
      }),
    ).rejects.toThrow();

    const rows = await testDatabase()
      .db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(rows).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
  });

  it('leaves no job when the callback throws before committing', async () => {
    const bus = createEventBus();
    const relayed: string[] = [];
    bus.subscribeAll((event) => relayed.push(event.type));
    const outbox = new Outbox({ db: testDatabase().db, queue, bus });

    await expect(
      outbox.run(async (ctx) => {
        await ctx.emit(outbox.event('session.failed', { sessionId: 'x', reason: 'spawn_error' }));
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');

    expect(await jobs()).toHaveLength(0);
    // And nothing was relayed: a client is never told about a change that rolled back.
    expect(relayed).toEqual([]);
  });
});

describe('at-least-once delivery and idempotent consumption (F6.3)', () => {
  it('collapses a re-enqueue of the same envelope id into one job', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });
    const envelope = outbox.event('session.completed', { sessionId: 'x', trigger: 'user' });

    await outbox.run(async (ctx) => {
      await ctx.emit(envelope);
    });
    await outbox.run(async (ctx) => {
      await ctx.emit(envelope);
    });

    // The job's primary key is `(name, id)` and every insert is ON CONFLICT DO NOTHING, so the
    // envelope id is a real enqueue-side de-duplication key — see the note in `pg-boss.ts`
    // about why `singletonKey` alone would not be.
    expect(await jobs()).toHaveLength(1);
  });

  it('a redelivered job runs the consumer twice and the side effect happens once', async () => {
    // The consumer's own idempotency, which F6.3 makes the actual contract: dedupe on the
    // envelope id. Redelivery is simulated by handing the same envelope to the handler twice,
    // which is exactly what pg-boss does after a handler crashes mid-flight.
    const seen = new Set<string>();
    const sideEffects: string[] = [];

    const handler = async (event: EventEnvelope): Promise<void> => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      sideEffects.push(event.type);
    };

    const outbox = new Outbox({ db: testDatabase().db, queue });
    const envelope = outbox.event('session.archived', { sessionId: 'x', trigger: 'user' });

    await handler(envelope);
    await handler(envelope);

    expect(sideEffects).toEqual(['session.archived']);
  });

  it('delivers an enqueued event to a real subscriber', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });
    const received: EventEnvelope[] = [];

    const unsubscribe = await queue.subscribe(QUEUE_NAMES.EVENTS, async (event) => {
      received.push(event);
    });

    try {
      await outbox.run(async (ctx) => {
        await ctx.emit(outbox.event('session.paused', { sessionId: 'x' }));
      });

      await waitFor(() => received.length === 1);
      expect(received[0]?.type).toBe('session.paused');
      expect(received[0]?.payload['sessionId']).toBe('x');
    } finally {
      await unsubscribe();
    }
  });
});

describe('non-event jobs (TDS 04 §15.2 note)', () => {
  it('enqueues a `session.launch` job on the caller transaction', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });
    const job = createJob({ sessionId: 'x', fromState: 'created', action: 'start' });

    await outbox.run(async (ctx) => {
      await queue.enqueueJob(ctx.tx, QUEUE_NAMES.SESSION_LAUNCH, job);
    });

    const enqueued = await jobs(QUEUE_NAMES.SESSION_LAUNCH);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.id).toBe(job.id);
    // No F6 envelope: the payload is the job payload, verbatim.
    expect(enqueued[0]?.data).toEqual(job.payload);
  });

  it('rolls a launch job back with its transaction', async () => {
    const outbox = new Outbox({ db: testDatabase().db, queue });

    await expect(
      outbox.run(async (ctx) => {
        await queue.enqueueJob(
          ctx.tx,
          QUEUE_NAMES.SESSION_LAUNCH,
          createJob({ sessionId: 'x', fromState: 'created', action: 'start' }),
        );
        throw new Error('caller changed its mind');
      }),
    ).rejects.toThrow();

    expect(await jobs(QUEUE_NAMES.SESSION_LAUNCH)).toHaveLength(0);
  });
});

/** Poll rather than sleep (TDS 07 §11.3: no wall-clock sleeps), with a hard cap. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met within the timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
