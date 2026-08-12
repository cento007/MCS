import { describe, expect, it } from 'vitest';
import {
  booleanValue,
  enumValue,
  integerValue,
  moneyValue,
  objectValue,
  stringValue,
  timeOfDayValue,
} from './values.js';

/**
 * A stored settings row is untrusted input: `settings.value` is `jsonb` behind a value_type
 * CHECK and nothing more. Every helper here degrades to its documented default, because a
 * corrupt row must not be able to 500 a read model the Dashboard polls.
 */

describe('stringValue', () => {
  it('accepts a non-blank string and rejects everything else', () => {
    expect(stringValue('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(stringValue('   ')).toBeNull();
    expect(stringValue('')).toBeNull();
    expect(stringValue(42)).toBeNull();
    expect(stringValue(null)).toBeNull();
    expect(stringValue(undefined, 'fallback')).toBe('fallback');
  });
});

describe('integerValue', () => {
  it('floors, bounds, and falls back on anything unusable', () => {
    const bounds = { min: 0, max: 100 };
    expect(integerValue(15, 0, bounds)).toBe(15);
    expect(integerValue(15.9, 0, bounds)).toBe(15);
    expect(integerValue(-1, 7, bounds)).toBe(7);
    expect(integerValue(101, 7, bounds)).toBe(7);
    expect(integerValue('15', 7, bounds)).toBe(7);
    expect(integerValue(Number.NaN, 7, bounds)).toBe(7);
    expect(integerValue(undefined, 7, bounds)).toBe(7);
  });
});

describe('booleanValue / objectValue / enumValue', () => {
  it('takes only real booleans', () => {
    expect(booleanValue(true, false)).toBe(true);
    expect(booleanValue('true', false)).toBe(false);
    expect(booleanValue(undefined, true)).toBe(true);
  });

  it('takes only plain objects — arrays and scalars are not settings documents', () => {
    expect(objectValue({ a: 1 })).toEqual({ a: 1 });
    expect(objectValue([1, 2])).toBeNull();
    expect(objectValue(null)).toBeNull();
    expect(objectValue('{}')).toBeNull();
  });

  it('takes only members of the closed set', () => {
    const modes = ['two_way', 'one_way', 'paused'] as const;
    expect(enumValue('paused', modes, 'two_way')).toBe('paused');
    expect(enumValue('sideways', modes, 'two_way')).toBe('two_way');
    expect(enumValue(7, modes, 'two_way')).toBe('two_way');
  });
});

describe('timeOfDayValue', () => {
  it('accepts HH:mm on a 24-hour clock', () => {
    expect(timeOfDayValue('18:00', '09:00')).toBe('18:00');
    expect(timeOfDayValue('00:00', '09:00')).toBe('00:00');
    expect(timeOfDayValue('23:59', '09:00')).toBe('23:59');
  });

  it('falls back on anything a scheduler could not act on', () => {
    expect(timeOfDayValue('24:00', '09:00')).toBe('09:00');
    expect(timeOfDayValue('6pm', '09:00')).toBe('09:00');
    expect(timeOfDayValue('18:00:00', '09:00')).toBe('09:00');
    expect(timeOfDayValue(1800, '09:00')).toBe('09:00');
  });
});

describe('moneyValue', () => {
  it('keeps null distinct from zero — "no budget" is not "a budget of nothing"', () => {
    expect(moneyValue(10)).toBe(10);
    expect(moneyValue(0)).toBe(0);
    expect(moneyValue(null)).toBeNull();
    expect(moneyValue(-1)).toBeNull();
    expect(moneyValue('10')).toBeNull();
  });
});
