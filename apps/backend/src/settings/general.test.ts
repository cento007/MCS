import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, resolveTimezone } from './general.js';

/**
 * `general.timezone` is the calendar boundary for spend (§7.8) and the daily report (§7.7).
 * An unset or unparseable value falls back to UTC and *reports* UTC — the endpoint neither
 * fails nor silently adopts the host zone.
 */
describe('resolveTimezone', () => {
  it('passes a real IANA name through', () => {
    expect(resolveTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(resolveTimezone('Pacific/Kiritimati')).toBe('Pacific/Kiritimati');
    expect(resolveTimezone('UTC')).toBe('UTC');
  });

  it('falls back to UTC when the row is absent', () => {
    expect(resolveTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone(null)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('')).toBe(DEFAULT_TIMEZONE);
  });

  it('falls back to UTC on a zone no calendar knows', () => {
    // Reaching PostgreSQL as `AT TIME ZONE 'Mars/Olympus'` would raise 22023 and 500 the
    // Dashboard's most-read endpoint over one bad settings row.
    expect(resolveTimezone('Mars/Olympus')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('Not A Zone')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone(42)).toBe(DEFAULT_TIMEZONE);
  });

  it('refuses an absurdly long value rather than handing it to the database', () => {
    expect(resolveTimezone('A'.repeat(500))).toBe(DEFAULT_TIMEZONE);
  });
});
