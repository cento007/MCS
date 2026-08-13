import { describe, expect, it } from 'vitest';
import { tickJobId } from './poller.js';

/**
 * The tick id is the whole restart-safety story of the poll chain, so it gets its own test.
 *
 * pg-boss inserts jobs with `ON CONFLICT (name, id) DO NOTHING`. If two callers that mean "a
 * tick in the same interval slot" produce the same id, a restart priming the chain while the
 * previous chain's tick is still pending is a no-op. If they do not, every `tsx watch` reload
 * adds another poller.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('tickJobId', () => {
  it('is a well-formed UUID (pg-boss’s `id` column is `uuid`)', () => {
    expect(tickJobId(new Date('2026-08-13T09:15:00Z'), 900_000)).toMatch(UUID);
  });

  it('is identical for two targets inside the same interval bucket', () => {
    // The restart case: the process died at 09:03 with a tick pending for ~09:15, and the new
    // process primes at 09:07 for ~09:22. Same 15-minute bucket, same id, one job.
    const bucket = 15 * 60_000;
    const first = tickJobId(new Date('2026-08-13T09:15:00Z'), bucket);
    const second = tickJobId(new Date('2026-08-13T09:22:00Z'), bucket);
    expect(second).toBe(first);
  });

  it('differs for the next bucket, so the chain advances', () => {
    const bucket = 15 * 60_000;
    expect(tickJobId(new Date('2026-08-13T09:30:00Z'), bucket)).not.toBe(
      tickJobId(new Date('2026-08-13T09:15:00Z'), bucket),
    );
  });

  it('differs when the interval changes, so a settings change is not swallowed', () => {
    const at = new Date('2026-08-13T09:15:00Z');
    expect(tickJobId(at, 15 * 60_000)).not.toBe(tickJobId(at, 5 * 60_000));
  });

  it('is deterministic across calls (it is a hash, not a random id)', () => {
    const at = new Date('2026-08-13T09:15:00Z');
    expect(tickJobId(at, 60_000)).toBe(tickJobId(at, 60_000));
  });

  it('does not divide by zero for a degenerate bucket', () => {
    expect(tickJobId(new Date('2026-08-13T09:15:00Z'), 0)).toMatch(UUID);
  });
});
