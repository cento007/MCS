import { describe, expect, it } from 'vitest';
import { DEFAULT_QUIET_HOURS } from '../settings/registry.js';
import { deferralSeconds, isWithinQuietHours, minutesOfDay } from './quiet-hours.js';

const at = (hhmm: string): number => {
  const minutes = minutesOfDay(hhmm);
  if (minutes === null) throw new Error(`not a time: ${hhmm}`);
  return minutes;
};

describe('minutesOfDay', () => {
  it('parses a 24-hour HH:mm', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('07:30')).toBe(450);
    expect(minutesOfDay('23:59')).toBe(1439);
  });

  it('rejects anything that is not one', () => {
    for (const value of ['24:00', '7:30', '07:60', '', 'noon', '07:30:00']) {
      expect(minutesOfDay(value)).toBeNull();
    }
  });
});

describe('isWithinQuietHours', () => {
  it('handles the default overnight window (23:00 → 07:30)', () => {
    const { start, end } = DEFAULT_QUIET_HOURS;

    expect(isWithinQuietHours(at('23:00'), start, end)).toBe(true);
    expect(isWithinQuietHours(at('23:59'), start, end)).toBe(true);
    expect(isWithinQuietHours(at('00:00'), start, end)).toBe(true);
    expect(isWithinQuietHours(at('02:00'), start, end)).toBe(true);
    expect(isWithinQuietHours(at('07:29'), start, end)).toBe(true);

    // The window is half-open: the end minute is already outside it.
    expect(isWithinQuietHours(at('07:30'), start, end)).toBe(false);
    expect(isWithinQuietHours(at('22:59'), start, end)).toBe(false);
    expect(isWithinQuietHours(at('12:00'), start, end)).toBe(false);
  });

  it('handles a same-day window (09:00 → 17:00)', () => {
    expect(isWithinQuietHours(at('08:59'), '09:00', '17:00')).toBe(false);
    expect(isWithinQuietHours(at('09:00'), '09:00', '17:00')).toBe(true);
    expect(isWithinQuietHours(at('16:59'), '09:00', '17:00')).toBe(true);
    expect(isWithinQuietHours(at('17:00'), '09:00', '17:00')).toBe(false);
    expect(isWithinQuietHours(at('23:00'), '09:00', '17:00')).toBe(false);
  });

  it('treats a zero-length window as empty, never as all day', () => {
    // An operator who set both ends to the same minute did not ask to be silenced forever.
    for (const minute of [0, at('12:00'), at('22:00'), 1439]) {
      expect(isWithinQuietHours(minute, '22:00', '22:00')).toBe(false);
    }
  });

  it('treats an unparseable window as no window', () => {
    expect(isWithinQuietHours(at('02:00'), 'bedtime', '07:30')).toBe(false);
    expect(isWithinQuietHours(at('02:00'), '23:00', '25:00')).toBe(false);
  });
});

describe('deferralSeconds', () => {
  it('rounds up to the next whole second', () => {
    const from = new Date('2026-08-13T22:00:00.000Z');
    expect(deferralSeconds(new Date('2026-08-13T22:00:30.400Z'), from)).toBe(31);
  });

  it('never returns zero or a negative delay for a boundary already past', () => {
    const from = new Date('2026-08-13T22:00:00.000Z');
    expect(deferralSeconds(new Date('2026-08-13T21:00:00.000Z'), from)).toBe(1);
    expect(deferralSeconds(from, from)).toBe(1);
  });
});
