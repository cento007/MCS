import { createLogger, createNoopQueue, QUEUE_NAMES } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { createWorker, SUBSCRIBED_QUEUES } from './worker.js';

const silentLogger = createLogger({ service: 'telegram-worker', level: 'silent' });

describe('telegram worker lifecycle', () => {
  it('subscribes to its declared queues on start', async () => {
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger });

    expect(queue.subscriptions).toEqual([]);
    await worker.start();
    expect(queue.subscriptions).toEqual([...SUBSCRIBED_QUEUES]);
    expect(SUBSCRIBED_QUEUES).toContain(QUEUE_NAMES.EVENTS);

    await worker.stop();
  });

  it('releases every subscription on stop — the signal handler path', async () => {
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger });

    await worker.start();
    await worker.stop();

    expect(queue.subscriptions).toEqual([]);
  });

  it('is idempotent: repeated start/stop does not double-subscribe or throw', async () => {
    const queue = createNoopQueue();
    const worker = createWorker({ queue, logger: silentLogger });

    await worker.start();
    await worker.start();
    expect(queue.subscriptions).toEqual([...SUBSCRIBED_QUEUES]);

    await worker.stop();
    await worker.stop();
    expect(queue.subscriptions).toEqual([]);
  });
});
