/**
 * The concurrency semaphore behind `maxConcurrentSessions` (TDS 02 §4.3, PRD §4.4.2).
 *
 * FIFO by construction: waiters are served in arrival order, which is what makes the
 * `session.launch` queue's "serviced in enqueue order as slots free" claim true end to end.
 *
 * `resize` exists because the setting is live-editable (`setting.updated`, F8.2). Growing
 * releases waiters immediately; **shrinking never kills a running Session** — it simply stops
 * handing out slots until enough have been released, exactly as §4.3 requires.
 */

export class SlotAcquisitionAbortedError extends Error {
  constructor(message = 'Slot acquisition aborted') {
    super(message);
    this.name = 'SlotAcquisitionAbortedError';
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly detach: () => void;
}

export class Semaphore {
  #limit: number;
  #held = 0;
  readonly #waiters: Waiter[] = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.trunc(limit));
  }

  get limit(): number {
    return this.#limit;
  }

  get held(): number {
    return this.#held;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  get available(): number {
    return Math.max(0, this.#limit - this.#held);
  }

  /** Take a slot if one is free right now. Never waits — the `start`/`resume` request path. */
  tryAcquire(): boolean {
    if (this.#held >= this.#limit || this.#waiters.length > 0) return false;
    this.#held += 1;
    return true;
  }

  /**
   * Wait for a slot — the `session.launch` consumer path. Honour `signal` so a shutdown does
   * not leave a job held open (the job returns to the queue and is redelivered).
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new SlotAcquisitionAbortedError();

    if (this.#waiters.length === 0 && this.#held < this.#limit) {
      this.#held += 1;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => {
          signal?.removeEventListener('abort', onAbort);
        },
      };

      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        waiter.detach();
        reject(new SlotAcquisitionAbortedError());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  /** Give a slot back. Idempotent guards belong to the caller (see `ManagedSessionRegistry`). */
  release(): void {
    if (this.#held === 0) return;
    this.#held -= 1;
    this.#pump();
  }

  /** Apply a new `maxConcurrentSessions`. Takes effect as slots free (TDS 02 §4.3). */
  resize(limit: number): void {
    this.#limit = Math.max(1, Math.trunc(limit));
    this.#pump();
  }

  #pump(): void {
    while (this.#held < this.#limit) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      this.#held += 1;
      waiter.detach();
      waiter.resolve();
    }
  }
}
