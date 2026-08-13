import { describe, expect, it } from 'vitest';
import type { ApiError } from '../http/errors.js';
import { encodeCursor } from '../http/pagination.js';
import { decodeAuditCursor, encodeAuditCursor } from './cursors.js';

/**
 * The audit cursor (F5.3 / TDS 04 §12) — pure, no database.
 *
 * The `(occurredAt, id)` pair is not decoration: one settings save writes a `setting.updated`
 * row and a `secret_item.updated` row inside the same transaction, so two entries sharing a
 * millisecond is the normal case here, not an edge case. A cursor keyed on the timestamp alone
 * would skip or repeat one of them at every page boundary.
 */

describe('audit cursors', () => {
  it('round-trips an instant and an id', () => {
    const cursor = {
      occurredAt: new Date('2026-08-13T07:14:22.123Z'),
      id: '018f6b30-4c2a-7d31-9e44-2f1a09b7c001',
    };

    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it('is opaque — base64url, not a readable timestamp', () => {
    const encoded = encodeAuditCursor({
      occurredAt: new Date('2026-08-13T07:14:22.123Z'),
      id: 'abc',
    });

    expect(encoded).not.toContain('2026');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('passes `undefined` through — the first page has no cursor', () => {
    expect(decodeAuditCursor(undefined)).toBeUndefined();
  });

  it('rejects anything that is not one of ours', () => {
    const cases = ['not-base64url!!', encodeCursor('no-separator'), encodeCursor('nope|'), ''];

    for (const cursor of cases) {
      let thrown: ApiError | null = null;
      try {
        decodeAuditCursor(cursor);
      } catch (error) {
        thrown = error as ApiError;
      }
      expect(thrown?.code).toBe('INVALID_CURSOR');
    }
  });

  it('rejects a cursor whose instant is not one', () => {
    let thrown: ApiError | null = null;
    try {
      decodeAuditCursor(encodeCursor('sometime|018f6b30-4c2a-7d31-9e44-2f1a09b7c001'));
    } catch (error) {
      thrown = error as ApiError;
    }

    expect(thrown?.code).toBe('INVALID_CURSOR');
  });
});
