import { describe, expect, it } from 'vitest';
import { Semaphore, SlotAcquisitionAbortedError } from './semaphore.js';

/**
 * The `maxConcurrentSessions` slot pool (TDS 02 §4.3). Two properties matter and both are
 * contractual: waiters are served in arrival order (that is what makes the `session.launch`
 * queue FIFO), and shrinking the limit never takes a slot back from a running Session.
 */

describe('Semaphore', () => {
  it('hands out slots up to the limit and refuses beyond it', () => {
    const semaphore = new Semaphore(2);

    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(false);
    expect(semaphore.held).toBe(2);
    expect(semaphore.available).toBe(0);
  });

  it('releases a slot back to the pool', () => {
    const semaphore = new Semaphore(1);

    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(false);
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(true);
  });

  it('ignores a release with nothing held', () => {
    const semaphore = new Semaphore(1);
    semaphore.release();
    expect(semaphore.held).toBe(0);
  });

  it('serves waiters in arrival order', async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];

    expect(semaphore.tryAcquire()).toBe(true);

    const waiters = [1, 2, 3].map(async (n) => {
      await semaphore.acquire();
      order.push(n);
    });

    expect(semaphore.waiting).toBe(3);

    for (let i = 0; i < 3; i += 1) {
      semaphore.release();
      await Promise.resolve();
    }
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
  });

  it('makes `tryAcquire` yield to queued waiters rather than jumping them', async () => {
    const semaphore = new Semaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);

    const waiter = semaphore.acquire();
    // A free slot exists after the release below, but a waiter is already queued for it.
    semaphore.release();
    await waiter;

    expect(semaphore.tryAcquire()).toBe(false);
  });

  it('growing the limit releases queued waiters immediately', async () => {
    const semaphore = new Semaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);

    const waiter = semaphore.acquire();
    semaphore.resize(2);

    await expect(waiter).resolves.toBeUndefined();
    expect(semaphore.held).toBe(2);
  });

  it('shrinking never takes a slot back from a holder — it only defers new launches', () => {
    const semaphore = new Semaphore(3);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(true);

    semaphore.resize(1);

    expect(semaphore.held).toBe(3);
    expect(semaphore.tryAcquire()).toBe(false);

    // Capacity comes back only as the running Sessions release.
    semaphore.release();
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(false);
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(true);
  });

  it('clamps a nonsensical limit to at least one slot', () => {
    expect(new Semaphore(0).limit).toBe(1);
    expect(new Semaphore(-4).limit).toBe(1);
  });

  it('aborts a waiter without leaking its place in the queue', async () => {
    const semaphore = new Semaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);

    const controller = new AbortController();
    const waiter = semaphore.acquire(controller.signal);
    expect(semaphore.waiting).toBe(1);

    controller.abort();
    await expect(waiter).rejects.toBeInstanceOf(SlotAcquisitionAbortedError);
    expect(semaphore.waiting).toBe(0);

    // The abandoned waiter must not consume the slot when it frees.
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(
      SlotAcquisitionAbortedError,
    );
  });
});
