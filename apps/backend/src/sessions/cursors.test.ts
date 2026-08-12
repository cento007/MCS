import { describe, expect, it } from 'vitest';
import type { ApiError } from '../http/errors.js';
import { encodeCursor } from '../http/pagination.js';
import {
  decodeCommitCursor,
  decodeOrdinalCursor,
  encodeCommitCursor,
  encodeOrdinalCursor,
} from './cursors.js';

/**
 * The two ordering keys under `/sessions/{id}` that are not the UUIDv7 `id` (TDS 04 §1.2):
 * the per-session message `ordinal` (arbitration A5) and the commit `(committedAt, id)` pair
 * (§6.10.1). Both stay opaque on the wire; a client that parses one is not our problem, but a
 * client that hands one back must always get either the right page or `INVALID_CURSOR`.
 */

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as ApiError).code;
  }
  throw new Error('expected the call to throw');
};

describe('ordinal cursors (§6.6)', () => {
  it('round-trips', () => {
    expect(decodeOrdinalCursor(encodeOrdinalCursor(0))).toBe(0);
    expect(decodeOrdinalCursor(encodeOrdinalCursor(4217))).toBe(4217);
  });

  it('passes undefined through — no cursor means the first page', () => {
    expect(decodeOrdinalCursor(undefined)).toBeUndefined();
  });

  it('rejects a foreign cursor with INVALID_CURSOR', () => {
    expect(codeOf(() => decodeOrdinalCursor('not-base64url!!'))).toBe('INVALID_CURSOR');
    // A well-formed cursor for a *different* resource: an id cursor handed to the message list.
    expect(
      codeOf(() => decodeOrdinalCursor(encodeCursor('018f6b2e-1111-7abc-8def-0123456789ab'))),
    ).toBe('INVALID_CURSOR');
    expect(codeOf(() => decodeOrdinalCursor(encodeCursor('-1')))).toBe('INVALID_CURSOR');
    expect(codeOf(() => decodeOrdinalCursor(encodeCursor('1.5')))).toBe('INVALID_CURSOR');
  });
});

describe('commit cursors (§6.10.1)', () => {
  it('round-trips the committedAt/id pair that breaks ties', () => {
    const cursor = {
      committedAt: new Date('2026-08-12T14:03:22.000Z'),
      id: '018f6b2e-1111-7abc-8def-0123456789ab',
    };

    const decoded = decodeCommitCursor(encodeCommitCursor(cursor));

    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.committedAt.toISOString()).toBe(cursor.committedAt.toISOString());
  });

  it('passes undefined through', () => {
    expect(decodeCommitCursor(undefined)).toBeUndefined();
  });

  it('rejects a cursor missing the tiebreak or carrying an unparseable instant', () => {
    expect(codeOf(() => decodeCommitCursor(encodeCursor('2026-08-12T14:03:22.000Z')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodeCommitCursor(encodeCursor('not-a-date|018f6b2e')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodeCommitCursor(encodeCursor('2026-08-12T14:03:22.000Z|')))).toBe(
      'INVALID_CURSOR',
    );
  });
});
