import { describe, expect, it } from 'vitest';
import type { ApiError } from '../http/errors.js';
import { encodeCursor } from '../http/pagination.js';
import { decodeCommitCursor, encodeCommitCursor } from './cursors.js';

/**
 * The Commit ordering key (TDS 04 §1.2/§5.2): the composite `(committedAt, id)`, opaque on the
 * wire. A client that parses one is not our problem; a client that hands one back must get
 * either the right page or `INVALID_CURSOR`, never a silently different page.
 */

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as ApiError).code;
  }
  throw new Error('expected the call to throw');
};

describe('commit cursors (§5.2 / §6.10.1)', () => {
  it('round-trips the committedAt/id pair that breaks ties', () => {
    const cursor = {
      committedAt: new Date('2026-08-12T14:03:22.000Z'),
      id: '018f6b2e-1111-7abc-8def-0123456789ab',
    };

    const decoded = decodeCommitCursor(encodeCommitCursor(cursor));

    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.committedAt.toISOString()).toBe(cursor.committedAt.toISOString());
  });

  it('is opaque — base64url, not a readable pair', () => {
    const encoded = encodeCommitCursor({
      committedAt: new Date('2026-08-12T14:03:22.000Z'),
      id: '018f6b2e-1111-7abc-8def-0123456789ab',
    });

    expect(encoded).not.toContain('|');
    expect(encoded).not.toContain('2026-08-12');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('passes undefined through — no cursor means the first page', () => {
    expect(decodeCommitCursor(undefined)).toBeUndefined();
  });

  it('rejects a cursor missing the tiebreak, or carrying an unparseable instant', () => {
    // A bare instant: the shape the cursor would have had without the `id` tiebreak, which is
    // exactly the version that can drop a row across a page boundary.
    expect(codeOf(() => decodeCommitCursor(encodeCursor('2026-08-12T14:03:22.000Z')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodeCommitCursor(encodeCursor('not-a-date|018f6b2e')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodeCommitCursor(encodeCursor('2026-08-12T14:03:22.000Z|')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodeCommitCursor('not-base64url!!'))).toBe('INVALID_CURSOR');
  });
});
