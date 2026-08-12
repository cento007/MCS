import { QUEUE_NAMES, type QueueJob, type QueuePort } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import type { OutboxTransaction } from '../../events/index.js';
import type { RateLimitedTurn } from './ports.js';
import {
  createTurnRetryScheduler,
  DEFAULT_BASE_DELAY_SECONDS,
  type RetryOutbox,
  retryDelaySeconds,
} from './retry.js';

/**
 * Rate-limit backoff (WS1 §4.3) at the unit tier — no database, no queue driver.
 *
 * The behaviour under test is a policy, not plumbing: how long to wait, when to stop waiting,
 * and the invariant that none of it ever touches Session state.
 */

interface EnqueuedJob {
  readonly queue: string;
  readonly job: QueueJob;
}

function fakeQueue(): { port: QueuePort; jobs: EnqueuedJob[] } {
  const jobs: EnqueuedJob[] = [];
  return {
    jobs,
    port: {
      async enqueue(): Promise<void> {
        throw new Error('the retry scheduler enqueues jobs, never events');
      },
      async enqueueJob(_tx, queue, job): Promise<void> {
        jobs.push({ queue, job });
      },
    },
  };
}

/** The transaction is never used by the scheduler; only the enqueue rides on it. */
const fakeOutbox: RetryOutbox = {
  async run<T>(work: (ctx: OutboxTransaction) => Promise<T>): Promise<T> {
    return work({
      tx: null as unknown as OutboxTransaction['tx'],
      emit: async () => undefined,
      emitted: [],
    });
  },
};

function turn(overrides: Partial<RateLimitedTurn> = {}): RateLimitedTurn {
  return {
    sessionId: '019ff000-0000-7000-8000-000000000001',
    content: 'refactor the queue consumer',
    messageId: '019ff000-0000-7000-8000-000000000002',
    attempt: 1,
    reason: 'rate_limit',
    ...overrides,
  };
}

describe('retryDelaySeconds', () => {
  it('doubles per attempt from the base delay', () => {
    const options = { base: 30, max: 900, random: () => 0 };
    expect(retryDelaySeconds(1, options)).toBe(30);
    expect(retryDelaySeconds(2, options)).toBe(60);
    expect(retryDelaySeconds(3, options)).toBe(120);
    expect(retryDelaySeconds(4, options)).toBe(240);
  });

  it('caps at the ceiling instead of growing without bound', () => {
    expect(retryDelaySeconds(20, { base: 30, max: 900, random: () => 0 })).toBe(900);
  });

  it('adds up to 20% jitter, so simultaneous sessions do not re-collide', () => {
    expect(retryDelaySeconds(1, { base: 100, max: 900, random: () => 1 })).toBe(120);
    expect(retryDelaySeconds(1, { base: 100, max: 900, random: () => 0.5 })).toBe(110);
  });
});

describe('createTurnRetryScheduler', () => {
  it('enqueues a delayed session.prompt.retry job carrying the original Message id', async () => {
    const queue = fakeQueue();
    const scheduler = createTurnRetryScheduler({
      queue: queue.port,
      outbox: fakeOutbox,
      random: () => 0,
    });

    await scheduler.schedule(turn());

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.queue).toBe(QUEUE_NAMES.SESSION_PROMPT_RETRY);
    expect(queue.jobs[0]?.job.startAfterSeconds).toBe(DEFAULT_BASE_DELAY_SECONDS);
    expect(queue.jobs[0]?.job.payload).toEqual({
      sessionId: '019ff000-0000-7000-8000-000000000001',
      content: 'refactor the queue consumer',
      // The prompt is already a `pending` Message; the retry must not create a second one.
      messageId: '019ff000-0000-7000-8000-000000000002',
      attempt: 1,
      reason: 'rate_limit',
    });
  });

  it('gives up past the attempt ceiling and reports it, without enqueueing again', async () => {
    const queue = fakeQueue();
    const exhausted: RateLimitedTurn[] = [];
    const scheduler = createTurnRetryScheduler({
      queue: queue.port,
      outbox: fakeOutbox,
      maxAttempts: 2,
      onExhausted: (value) => exhausted.push(value),
    });

    await scheduler.schedule(turn({ attempt: 3 }));

    expect(queue.jobs).toEqual([]);
    expect(exhausted).toHaveLength(1);
    // §4.3: exhaustion "marks that prompt's turn failed and notifies … it does not transition
    // the Session to `failed`". Nothing in this module can transition anything — by design, it
    // has no state machine to call.
  });

  it('does not schedule a retry for a turn that no Mission Control prompt started', async () => {
    const queue = fakeQueue();
    const exhausted: RateLimitedTurn[] = [];
    const scheduler = createTurnRetryScheduler({
      queue: queue.port,
      outbox: fakeOutbox,
      onExhausted: (value) => exhausted.push(value),
    });

    await scheduler.schedule(turn({ content: null }));

    expect(queue.jobs).toEqual([]);
    expect(exhausted).toHaveLength(1);
  });
});
