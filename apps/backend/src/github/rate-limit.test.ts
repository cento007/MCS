import { describe, expect, it } from 'vitest';
import {
  isPrimaryExhaustion,
  parseRateLimit,
  RateLimitBudget,
  retryEligibleAt,
} from './rate-limit.js';

const NOW = new Date('2026-08-13T09:00:00.000Z');

describe('parseRateLimit', () => {
  it('reads the primary limit headers', () => {
    const snapshot = parseRateLimit(
      {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1786000000',
        'x-ratelimit-resource': 'core',
      },
      NOW,
    );

    expect(snapshot.limit).toBe(5000);
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.resetAt?.toISOString()).toBe(new Date(1786000000 * 1000).toISOString());
    expect(snapshot.resource).toBe('core');
    expect(snapshot.retryAfterAt).toBeNull();
    expect(isPrimaryExhaustion(snapshot)).toBe(true);
  });

  it('resolves retry-after against the supplied clock, not a real one', () => {
    const snapshot = parseRateLimit({ 'retry-after': '60' }, NOW);
    expect(snapshot.retryAfterAt?.toISOString()).toBe('2026-08-13T09:01:00.000Z');
  });

  it('treats a non-zero remaining as not exhausted', () => {
    expect(isPrimaryExhaustion(parseRateLimit({ 'x-ratelimit-remaining': '4999' }, NOW))).toBe(
      false,
    );
  });

  it('degrades to nulls rather than throwing on junk headers', () => {
    const snapshot = parseRateLimit(
      { 'x-ratelimit-limit': 'lots', 'x-ratelimit-remaining': '', 'x-ratelimit-reset': '-5' },
      NOW,
    );
    expect(snapshot).toMatchObject({ limit: null, remaining: null, resetAt: null });
    // Absent is not exhausted: a response with no headers must not look like an empty budget.
    expect(isPrimaryExhaustion(snapshot)).toBe(false);
  });

  it('picks the later of reset and retry-after', () => {
    const snapshot = parseRateLimit(
      { 'x-ratelimit-reset': String(Math.floor(NOW.getTime() / 1000) + 30), 'retry-after': '120' },
      NOW,
    );
    expect(retryEligibleAt(snapshot)?.toISOString()).toBe('2026-08-13T09:02:00.000Z');
  });

  it('has no retry instant when GitHub said nothing', () => {
    expect(retryEligibleAt(parseRateLimit({}, NOW))).toBeNull();
  });
});

describe('RateLimitBudget', () => {
  it('does not block before anything refused a call', () => {
    expect(new RateLimitBudget().blockedAt(NOW)).toBeNull();
  });

  it('blocks until the stated reset instant, then unblocks itself', () => {
    const budget = new RateLimitBudget();
    const resetAt = new Date(NOW.getTime() + 60_000);

    budget.block(parseRateLimit({ 'x-ratelimit-remaining': '0' }, NOW), resetAt);

    expect(budget.blockedAt(NOW)).toEqual(resetAt);
    expect(budget.blockedAt(new Date(NOW.getTime() + 59_999))).toEqual(resetAt);
    expect(budget.blockedAt(new Date(NOW.getTime() + 60_000))).toBeNull();
    // Having lapsed, it stays lapsed.
    expect(budget.blockedAt(NOW)).toBeNull();
  });

  it('falls back to a short block when GitHub stated no reset', () => {
    const budget = new RateLimitBudget();
    budget.block(parseRateLimit({}, NOW), null);

    const blocked = budget.blockedAt(new Date());
    expect(blocked).not.toBeNull();
    // A refusal with no instant must still stop a tight loop, and must still self-heal.
    expect(blocked?.getTime()).toBeGreaterThan(Date.now());
    expect(blocked?.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('observing a healthy response does not block', () => {
    const budget = new RateLimitBudget();
    budget.observe(parseRateLimit({ 'x-ratelimit-remaining': '1' }, NOW));
    expect(budget.blockedAt(NOW)).toBeNull();
    expect(budget.snapshot.remaining).toBe(1);
  });

  it('reset forgets both the block and the snapshot', () => {
    const budget = new RateLimitBudget();
    budget.block(
      parseRateLimit({ 'x-ratelimit-remaining': '0' }, NOW),
      new Date(2_000_000_000_000),
    );

    budget.reset();

    expect(budget.blockedAt(NOW)).toBeNull();
    expect(budget.snapshot.remaining).toBeNull();
  });
});
