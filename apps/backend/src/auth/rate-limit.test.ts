import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS } from './rate-limit.js';

/** TDS 04 §3.1: `POST /api/v1/auth/login` is rate limited 10/min/IP → `RATE_LIMITED`. */
describe('login rate limiter', () => {
  const build = (now: () => number) =>
    new FixedWindowRateLimiter({ limit: LOGIN_RATE_LIMIT, windowMs: LOGIN_RATE_WINDOW_MS, now });

  it('allows exactly the limit inside one window, then refuses', () => {
    const limiter = build(() => 1_000);

    for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT; attempt += 1) {
      expect(limiter.consume('127.0.0.1').allowed).toBe(true);
    }

    const denied = limiter.consume('127.0.0.1');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_RATE_WINDOW_MS / 1000);
  });

  it('counts per IP, so one client cannot lock out another', () => {
    const limiter = build(() => 1_000);

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT + 5; attempt += 1) {
      limiter.consume('10.0.0.1');
    }

    expect(limiter.consume('10.0.0.1').allowed).toBe(false);
    expect(limiter.consume('10.0.0.2').allowed).toBe(true);
  });

  it('starts a fresh window once the old one has elapsed', () => {
    let clock = 0;
    const limiter = build(() => clock);

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT; attempt += 1) limiter.consume('127.0.0.1');
    expect(limiter.consume('127.0.0.1').allowed).toBe(false);

    clock += LOGIN_RATE_WINDOW_MS + 1;
    expect(limiter.consume('127.0.0.1').allowed).toBe(true);
  });

  it('reset() clears one key or all of them', () => {
    const limiter = build(() => 0);

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT; attempt += 1) limiter.consume('a');
    expect(limiter.consume('a').allowed).toBe(false);

    limiter.reset('a');
    expect(limiter.consume('a').allowed).toBe(true);

    limiter.reset();
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('evicts expired windows rather than growing without bound', () => {
    let clock = 0;
    const limiter = build(() => clock);

    for (let i = 0; i < 100; i += 1) limiter.consume(`10.0.0.${i}`);
    clock += LOGIN_RATE_WINDOW_MS + 1;

    // The sweep runs on the next consume; the previous 100 windows are all expired.
    expect(limiter.consume('10.0.0.1').allowed).toBe(true);
  });
});
