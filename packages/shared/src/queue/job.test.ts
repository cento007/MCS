import { describe, expect, it } from 'vitest';
import { createJob } from './job.js';
import { QUEUE_NAMES } from './names.js';
import { createNoopQueue } from './noop.js';

/**
 * The job half of `QueuePort` (see the header of `port.ts`): durable work requests that are
 * explicitly *not* F6 events. `session.launch` is the Phase 1 example and TDS 04 §15.2 says so
 * in as many words — "a pg-boss job name, not an event ... carries no F6 envelope".
 */

describe('createJob', () => {
  it('assigns a UUIDv7 that doubles as the de-duplication key', () => {
    const job = createJob({ sessionId: 'a' });

    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createJob({ sessionId: 'a' }).id).not.toBe(job.id);
  });

  it('accepts an explicit id so a caller can make an enqueue idempotent', () => {
    const id = '018f6b2e-1111-7abc-8def-0123456789ab';
    expect(createJob({ sessionId: 'a' }, id).id).toBe(id);
  });

  it('is frozen — a job payload is a message, not a mutable object', () => {
    expect(Object.isFrozen(createJob({ sessionId: 'a' }))).toBe(true);
  });
});

describe('createNoopQueue', () => {
  it('records events and jobs separately and delivers neither', async () => {
    const queue = createNoopQueue();
    const tx = {} as never;

    await queue.enqueueJob(tx, QUEUE_NAMES.SESSION_LAUNCH, createJob({ sessionId: 'a' }));

    expect(queue.enqueuedJobs).toHaveLength(1);
    expect(queue.enqueuedJobs[0]?.queue).toBe(QUEUE_NAMES.SESSION_LAUNCH);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('tracks subscriptions on both surfaces and lets them be cancelled', async () => {
    const queue = createNoopQueue();

    const stopEvents = await queue.subscribe(QUEUE_NAMES.EVENTS, async () => {});
    const stopJobs = await queue.subscribeJobs(QUEUE_NAMES.SESSION_LAUNCH, async () => {});

    expect([...queue.subscriptions].sort()).toEqual(
      [QUEUE_NAMES.EVENTS, QUEUE_NAMES.SESSION_LAUNCH].sort(),
    );

    await stopEvents();
    await stopJobs();
    expect(queue.subscriptions).toHaveLength(0);
  });
});
