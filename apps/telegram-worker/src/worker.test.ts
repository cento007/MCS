import {
  createLogger,
  createNoopQueue,
  type NoopQueue,
  type NotificationDispatchJob,
  QUEUE_NAMES,
} from '@mc/shared';
import { describe, expect, it } from 'vitest';
import type { TickSummary } from './daily-report.js';
import { DeliveryAbortedError, type DeliveryResult } from './delivery.js';
import {
  createWorker,
  type DailyReportPort,
  type DeliveryPort,
  SUBSCRIBED_QUEUES,
  type Worker,
} from './worker.js';

const silentLogger = createLogger({ service: 'telegram-worker', level: 'silent' });

const tickSummary: TickSummary = {
  ran: false,
  reason: 'not_due',
  notificationId: null,
  nextTickInSeconds: 60,
};

class FakeDelivery implements DeliveryPort {
  readonly delivered: NotificationDispatchJob[] = [];
  sweptWith: number | undefined | null = null;
  swept = 0;
  result: DeliveryResult = { kind: 'sent', notificationId: 'n1' };
  /** Set to make `deliver` hang until the signal aborts — the shutdown scenario. */
  blockUntilAborted = false;

  async deliver(job: NotificationDispatchJob, signal?: AbortSignal): Promise<DeliveryResult> {
    this.delivered.push(job);

    if (this.blockUntilAborted) {
      await new Promise<void>((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => {
          resolve();
        });
      });
      throw new DeliveryAbortedError(job.notificationId);
    }

    return this.result;
  }

  async sweepPending(limit?: number): Promise<number> {
    this.sweptWith = limit;
    return this.swept;
  }
}

class FakeDailyReport implements DailyReportPort {
  ticks = 0;
  stopping: boolean | null = null;

  async tick(): Promise<TickSummary> {
    this.ticks += 1;
    return tickSummary;
  }

  setStopping(stopping: boolean): void {
    this.stopping = stopping;
  }
}

interface Harness {
  readonly worker: Worker;
  readonly queue: NoopQueue;
  readonly delivery: FakeDelivery;
  readonly dailyReport: FakeDailyReport;
  readonly shutdown: AbortController;
}

function harness(overrides: { sweepOnStart?: boolean } = {}): Harness {
  const queue = createNoopQueue();
  const delivery = new FakeDelivery();
  const dailyReport = new FakeDailyReport();
  const shutdown = new AbortController();

  const worker = createWorker({
    queue,
    logger: silentLogger,
    delivery,
    dailyReport,
    shutdown,
    ...(overrides.sweepOnStart === undefined ? {} : { sweepOnStart: overrides.sweepOnStart }),
  });

  return { worker, queue, delivery, dailyReport, shutdown };
}

describe('telegram worker lifecycle', () => {
  it('subscribes to its three declared queues on start', async () => {
    const { worker, queue } = harness();

    expect(queue.subscriptions).toEqual([]);
    await worker.start();

    expect([...queue.subscriptions].sort()).toEqual([...SUBSCRIBED_QUEUES].sort());
    expect(SUBSCRIBED_QUEUES).toContain(QUEUE_NAMES.NOTIFICATION_DELIVER);
    expect(SUBSCRIBED_QUEUES).toContain(QUEUE_NAMES.NOTIFICATION_SCHEDULE);
    // The `events` subscription is the drain for the queue the Backend writes to (F6.3).
    expect(SUBSCRIBED_QUEUES).toContain(QUEUE_NAMES.EVENTS);

    await worker.stop();
  });

  it('releases every subscription on stop — the signal handler path', async () => {
    const { worker, queue } = harness();

    await worker.start();
    await worker.stop();

    expect(queue.subscriptions).toEqual([]);
  });

  it('is idempotent: repeated start/stop does not double-subscribe or throw', async () => {
    const { worker, queue } = harness();

    await worker.start();
    await worker.start();
    expect([...queue.subscriptions].sort()).toEqual([...SUBSCRIBED_QUEUES].sort());

    await worker.stop();
    await worker.stop();
    expect(queue.subscriptions).toEqual([]);
  });

  it('primes the daily-report chain and sweeps stranded notifications on start', async () => {
    const { worker, delivery, dailyReport } = harness();

    await worker.start();

    expect(dailyReport.ticks).toBe(1);
    expect(delivery.sweptWith).toBeUndefined();

    await worker.stop();
  });

  it('can be started without the startup sweep', async () => {
    const { worker, delivery } = harness({ sweepOnStart: false });

    await worker.start();
    expect(delivery.sweptWith).toBeNull();

    await worker.stop();
  });

  it('tells the scheduler it is stopping so no further tick is enqueued', async () => {
    const { worker, dailyReport } = harness();

    await worker.start();
    expect(dailyReport.stopping).toBe(false);

    await worker.stop();
    expect(dailyReport.stopping).toBe(true);
  });
});

describe('shutdown with a send in flight', () => {
  /**
   * The property this file exists for. `offWork` waits for the in-flight handler, so a handler
   * parked on something that never completes blocks SIGTERM forever — the failure the session
   * registry hit. `stop()` must abort the shutdown signal BEFORE it awaits the unsubscribes.
   */
  it('does not hang: aborting the shutdown signal unblocks the handler', async () => {
    const { worker, queue, delivery, shutdown } = harness();
    delivery.blockUntilAborted = true;

    await worker.start();

    // Drive the delivery handler directly through the queue double, as pg-boss would.
    const handler = queue.jobHandlerFor(QUEUE_NAMES.NOTIFICATION_DELIVER);
    const inFlight = handler({
      id: 'job-1',
      payload: { notificationId: 'n1', attempt: 1 },
      signal: shutdown.signal,
    });

    // The handler re-throws so pg-boss re-queues rather than completing a job whose
    // Notification is still `pending`.
    const settled = inFlight.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    await worker.stop();

    const outcome = await withTimeout(settled, 1_000);
    expect(outcome).toBeInstanceOf(DeliveryAbortedError);
    expect(shutdown.signal.aborted).toBe(true);
  });

  it('stop() itself resolves promptly even while a send is parked', async () => {
    const { worker, queue, delivery, shutdown } = harness();
    delivery.blockUntilAborted = true;

    await worker.start();

    const handler = queue.jobHandlerFor(QUEUE_NAMES.NOTIFICATION_DELIVER);
    void handler({
      id: 'job-1',
      payload: { notificationId: 'n1', attempt: 1 },
      signal: shutdown.signal,
    }).catch(() => undefined);

    await expect(withTimeout(worker.stop(), 1_000)).resolves.toBeUndefined();
  });
});

describe('stats — the heartbeat row’s `stats` column', () => {
  it('counts processed jobs and delivered notifications', async () => {
    const { worker, queue } = harness();
    await worker.start();

    const handler = queue.jobHandlerFor(QUEUE_NAMES.NOTIFICATION_DELIVER);
    await handler({ id: 'job-1', payload: { notificationId: 'n1', attempt: 1 }, signal: never() });

    expect(worker.stats()).toMatchObject({ notificationsSent: 1, jobsFailed: 0 });
    expect(worker.stats()['jobsProcessed']).toBeGreaterThanOrEqual(1);

    await worker.stop();
  });

  it('counts a failed delivery without letting it stop the worker', async () => {
    const { worker, queue, delivery } = harness();
    await worker.start();

    delivery.blockUntilAborted = false;
    const boom = new Error('database went away');
    delivery.deliver = async () => {
      throw boom;
    };

    const handler = queue.jobHandlerFor(QUEUE_NAMES.NOTIFICATION_DELIVER);
    await expect(
      handler({ id: 'job-1', payload: { notificationId: 'n1', attempt: 1 }, signal: never() }),
    ).rejects.toThrow('database went away');

    expect(worker.stats()['jobsFailed']).toBe(1);

    await worker.stop();
  });
});

function never(): AbortSignal {
  return new AbortController().signal;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
