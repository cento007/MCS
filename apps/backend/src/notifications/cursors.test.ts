import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { encodeCursor } from '../http/pagination.js';
import { decodeNotificationCursor, encodeNotificationCursor } from './cursors.js';

describe('notification cursor (§8 list, F5.3)', () => {
  it('round-trips the `(createdAt, id)` ordering key', () => {
    const cursor = {
      createdAt: new Date('2026-08-12T12:00:00.000Z'),
      id: '0198f6b2-1111-7abc-8def-0123456789ab',
    };

    const decoded = decodeNotificationCursor(encodeNotificationCursor(cursor));

    expect(decoded?.createdAt.toISOString()).toBe(cursor.createdAt.toISOString());
    expect(decoded?.id).toBe(cursor.id);
  });

  it('is opaque — the encoded value is not the key', () => {
    const encoded = encodeNotificationCursor({
      createdAt: new Date('2026-08-12T12:00:00.000Z'),
      id: '0198f6b2-1111-7abc-8def-0123456789ab',
    });

    expect(encoded).not.toContain('2026');
    expect(encoded).not.toContain('|');
  });

  it('returns undefined for an absent cursor (first page)', () => {
    expect(decodeNotificationCursor(undefined)).toBeUndefined();
  });

  it('rejects a foreign or malformed cursor with INVALID_CURSOR', () => {
    expect(() => decodeNotificationCursor('not-base64url!!')).toThrow(ApiError);
    // Well-formed base64url, but not this resource's key shape.
    expect(() => decodeNotificationCursor(encodeCursor('no-separator'))).toThrow(ApiError);
    expect(() => decodeNotificationCursor(encodeCursor('not-a-date|some-id'))).toThrow(ApiError);
    expect(() => decodeNotificationCursor(encodeCursor('2026-08-12T12:00:00.000Z|'))).toThrow(
      ApiError,
    );

    try {
      decodeNotificationCursor(encodeCursor('no-separator'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('INVALID_CURSOR');
      expect((error as ApiError).statusCode).toBe(400);
    }
  });
});
