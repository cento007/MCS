/**
 * Fixed-window rate limiter for `POST /api/v1/auth/login` — "Rate limited 10/min/IP →
 * `RATE_LIMITED`" (TDS 04 §3.1).
 *
 * In-memory on purpose. The limit is per *process* and per *IP*, and Mission Control is a
 * single-node, single-user system (D10: one Backend bound to loopback) — there is no second
 * instance for a shared counter to coordinate with, and paying a PostgreSQL round-trip on the
 * unauthenticated path would hand an attacker a cheaper DoS than the one being prevented.
 * The counter resets on restart, which costs at most one extra window of attempts.
 *
 * Not a general-purpose limiter: other routes' throttling is WS1 policy and is not this.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the current window ends. Only meaningful when `allowed` is false. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Injectable clock so the expiry behaviour is testable without waiting. */
  readonly now?: () => number;
}

/** TDS 04 §3.1. */
export const LOGIN_RATE_LIMIT = 10;
export const LOGIN_RATE_WINDOW_MS = 60_000;

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(options: RateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** Count one attempt against `key` and say whether it is allowed. */
  consume(key: string): RateLimitDecision {
    const now = this.#now();
    this.#sweep(now);

    const existing = this.#windows.get(key);
    const window =
      existing !== undefined && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + this.#windowMs };

    window.count += 1;
    this.#windows.set(key, window);

    return {
      allowed: window.count <= this.#limit,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  /** Drop the counter for a key (used after a successful login, and by tests). */
  reset(key?: string): void {
    if (key === undefined) this.#windows.clear();
    else this.#windows.delete(key);
  }

  /**
   * Expired windows are evicted opportunistically. The map is keyed by client IP on a
   * loopback-bound single-user server, so it cannot grow without an attacker who already
   * has arbitrary source addresses — and even then, entries live at most one window.
   */
  #sweep(now: number): void {
    if (this.#windows.size < 64) return;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }
}
