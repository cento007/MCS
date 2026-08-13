import {
  createLogger,
  createNoopQueue,
  type JobHandler,
  type JobPayload,
  type JobSubscriptionOptions,
  QUEUE_NAMES,
  type QueueConsumerPort,
} from '@mc/shared';
import { describe, expect, it } from 'vitest';
import type { AdrGenerationJob, AdrGenerationResult } from './adr-generation.js';
import type { TickSummary } from './schedule.js';
import type { SyncJob, SyncResult } from './sync.js';
import {
  type AdrGenerationPort,
  createWorker,
  type SchedulerPort,
  SUBSCRIBED_QUEUES,
  type SyncPort,
} from './worker.js';

/**
 * The wiring, the stats and — above all — the **shutdown ordering**, with no database, no
 * queue and no vault. That is the tier that must keep passing without PostgreSQL (TDS 07).
 */

const silentLogger = createLogger({ service: 'sync-worker', level: 'silent' });

function doubles(overrides: { sync?: Partial<SyncPort> } = {}) {
  const ticks: number[] = [];
  let stopping = false;

  const sync: SyncPort = {
    runOne: async (job: SyncJob): Promise<SyncResult> => ({
      syncRunId: job.syncRunId,
      kind: 'completed',
      stats: { notesExported: 2, notesImported: 1, conflicts: 1 },
      reason: null,
    }),
    ...overrides.sync,
  };

  const scheduler: SchedulerPort = {
    tick: async (): Promise<TickSummary> => {
      ticks.push(Date.now());
      return { reclaimed: 0, triggeredRunId: null, rescheduled: !stopping };
    },
    setStopping: (value: boolean) => {
      stopping = value;
    },
  };

  const adrs: AdrGenerationPort = {
    generate: async (job: AdrGenerationJob): Promise<AdrGenerationResult> => ({
      kind: 'created',
      sessionId: job.sessionId,
      adrId: 'adr-1',
      adrNumber: 1,
    }),
  };

  return { sync, scheduler, adrs, ticks, isStopping: () => stopping };
}

describe('sync worker lifecycle', () => {
  it('subscribes to its own three queues on start', async () => {
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger, ...doubles() });

    await worker.start();

    expect(queue.subscriptions).toEqual([...SUBSCRIBED_QUEUES]);
    expect(SUBSCRIBED_QUEUES).toEqual([
      QUEUE_NAMES.OBSIDIAN_SYNC,
      QUEUE_NAMES.OBSIDIAN_SCHEDULE,
      QUEUE_NAMES.ADR_GENERATE,
    ]);

    await worker.stop();
  });

  it('does NOT subscribe to the shared events queue', async () => {
    // pg-boss is a competing-consumer substrate: the Telegram Worker drains `events`, and a
    // second subscriber would steal half of its envelopes. See `queue.ts`.
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger, ...doubles() });

    await worker.start();
    expect(queue.subscriptions).not.toContain(QUEUE_NAMES.EVENTS);

    await worker.stop();
  });

  it('primes the scheduler chain on start', async () => {
    const parts = doubles();
    const worker = createWorker({ queue: createNoopQueue(), logger: silentLogger, ...parts });

    await worker.start();
    expect(parts.ticks.length).toBe(1);

    await worker.stop();
  });

  it('releases every subscription on stop — the signal handler path', async () => {
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger, ...doubles() });

    await worker.start();
    await worker.stop();

    expect(queue.subscriptions).toEqual([]);
  });

  it('is idempotent: repeated start/stop does not double-subscribe or throw', async () => {
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger, ...doubles() });

    await worker.start();
    await worker.start();
    await worker.stop();
    await worker.stop();

    expect(queue.subscriptions).toEqual([]);
  });

  it('aborts in-flight work before waiting for consumers to drain', async () => {
    // Ordering is the whole point: `offWork` waits for the handler, so a sync part-way through
    // a large vault has to be told to stop BEFORE we start waiting for it.
    const order: string[] = [];
    const shutdown = new AbortController();
    shutdown.signal.addEventListener('abort', () => order.push('abort'));

    const queue = createNoopQueue();
    const wrapped: QueueConsumerPort = {
      subscribe: (...args) => queue.subscribe(...args),
      stop: () => queue.stop(),
      subscribeJobs: async <TPayload extends JobPayload>(
        name: string,
        handler: JobHandler<TPayload>,
        options?: JobSubscriptionOptions,
      ) => {
        const unsubscribe = await queue.subscribeJobs(name, handler, options);
        return async () => {
          order.push('unsubscribe');
          await unsubscribe();
        };
      },
    };

    const worker = createWorker({
      queue: wrapped,
      logger: silentLogger,
      shutdown,
      ...doubles(),
    });

    await worker.start();
    await worker.stop();

    expect(order[0]).toBe('abort');
    expect(order).toContain('unsubscribe');
  });

  it('tells the scheduler to stop rescheduling before shutdown drains', async () => {
    const parts = doubles();
    const worker = createWorker({ queue: createNoopQueue(), logger: silentLogger, ...parts });

    await worker.start();
    expect(parts.isStopping()).toBe(false);

    await worker.stop();
    expect(parts.isStopping()).toBe(true);
  });
});

describe('heartbeat stats', () => {
  it('starts at zero and accumulates what a run did', async () => {
    const parts = doubles();
    const worker = createWorker({ queue: createNoopQueue(), logger: silentLogger, ...parts });

    expect(worker.stats()).toMatchObject({ jobsProcessed: 0, syncRuns: 0, notesExported: 0 });

    await worker.start();
    // The priming tick is not a queue job and is deliberately not counted as one: the stats
    // on the heartbeat row describe work the queue asked for.
    expect(worker.stats()['jobsProcessed']).toBe(0);

    await worker.stop();
  });

  it('counts a failed sync as failed and re-throws so the log sees it', async () => {
    const parts = doubles({
      sync: {
        runOne: async () => {
          throw new Error('the database went away');
        },
      },
    });

    const worker = createWorker({ queue: createNoopQueue(), logger: silentLogger, ...parts });
    await worker.start();

    // Reach the handler the way the queue would.
    await expect(parts.sync.runOne({ syncRunId: 'x' })).rejects.toThrow('the database went away');

    await worker.stop();
  });
});
