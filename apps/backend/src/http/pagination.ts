import { Buffer } from 'node:buffer';
import { ApiError } from './errors.js';

/**
 * Cursor pagination (F5.3 / TDS 04 §1.2).
 *
 * The cursor is opaque and base64url-encoded; what it encodes is the stated ordering key of
 * the resource — the UUIDv7 `id` by default. It is deliberately NOT a JSON blob or an offset:
 * an offset is unstable under live inserts (F5.3's stated reason), and a structured cursor
 * invites clients to parse it.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function encodeCursor(orderingKey: string): string {
  return Buffer.from(orderingKey, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor to its ordering key.
 *
 * @throws {ApiError} `INVALID_CURSOR` (400) for an unparseable or foreign value (TDS 04 §1.3).
 */
export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // base64url decoding is lenient — the round-trip is what actually validates the input.
  if (decoded.length === 0 || encodeCursor(decoded) !== cursor) {
    throw new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
  }
  return decoded;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode a cursor whose ordering key is an entity id (the F5.3 default). */
export function decodeIdCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const key = decodeCursor(cursor);
  if (!UUID.test(key)) {
    throw new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
  }
  return key;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT);
}

/**
 * The F5.3 list envelope. `nextCursor` is non-null only when the page was filled to `limit`,
 * so a client stops on `null` rather than on an empty page.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  orderingKeyOf: (row: T) => string,
): { data: readonly T[]; meta: { nextCursor: string | null; limit: number } } {
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    data: rows,
    meta: {
      nextCursor: last === undefined ? null : encodeCursor(orderingKeyOf(last)),
      limit,
    },
  };
}
