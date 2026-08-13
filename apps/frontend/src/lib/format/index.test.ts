import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCostUsd,
  formatDuration,
  formatFrozenDuration,
  formatTokenCount,
  sessionIdTail,
  sessionLabel,
} from './index.js';

describe('formatBytes', () => {
  it('uses binary units, and one decimal above the kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(49_360)).toBe('48.2 KB');
    expect(formatBytes(2_411_724)).toBe('2.3 MB');
  });

  it('renders an em dash for absent or nonsensical values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('always renders three fields so a duration column stays scannable', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(61)).toBe('00:01:01');
    expect(formatDuration(3_930)).toBe('01:05:30');
    expect(formatDuration(360_000)).toBe('100:00:00');
  });

  it('renders an em dash for absent or nonsensical values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('marks a frozen duration with `~` (TDS 06 §3.3)', () => {
    expect(formatFrozenDuration(2_530)).toBe('~00:42:10');
    expect(formatFrozenDuration(null)).toBe('—');
  });
});

describe('formatCostUsd', () => {
  it('renders four decimals, which is the granularity a token cost actually has', () => {
    expect(formatCostUsd(0.4821)).toBe('$0.4821');
    expect(formatCostUsd(0)).toBe('$0.0000');
    expect(formatCostUsd(null)).toBe('—');
  });
});

describe('formatTokenCount', () => {
  it('compacts large counts for dense rows', () => {
    expect(formatTokenCount(934)).toBe('934');
    expect(formatTokenCount(1_240)).toBe('1.2k');
    expect(formatTokenCount(3_400_000)).toBe('3.4M');
  });
});

describe('session identity (§9.3)', () => {
  it('renders the RANDOM tail of a UUIDv7, never the timestamp prefix', () => {
    // The leading hex of a UUIDv7 is a millisecond timestamp: every Session started in the
    // same hour shares it, so a prefix is the least discriminating substring available.
    const a = '0198a2f3-4c2a-7d31-9e44-2f1a09b7c001';
    const b = '0198a2f9-1111-7abc-8def-0123453f9a1c';
    expect(sessionIdTail(a)).toBe('…b7c001');
    expect(sessionIdTail(b)).toBe('…3f9a1c');
    expect(sessionIdTail(a)).not.toBe(sessionIdTail(b));
  });

  it('never renders a blank label', () => {
    expect(
      sessionLabel({ id: '0198a2f3-4c2a-7d31-9e44-2f1a09b7c001', title: 'Refactor queue' }),
    ).toBe('Refactor queue');
    expect(sessionLabel({ id: '0198a2f3-4c2a-7d31-9e44-2f1a09b7c001', title: '' })).toBe(
      'Untitled session · …b7c001',
    );
    expect(sessionLabel({ id: '0198a2f3-4c2a-7d31-9e44-2f1a09b7c001', title: null })).toBe(
      'Untitled session · …b7c001',
    );
  });
});
