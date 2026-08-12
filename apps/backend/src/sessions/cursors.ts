import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import type { CommitCursor } from './service.js';

/**
 * Resource-specific ordering keys behind the opaque F5.3 cursor (TDS 04 §1.2: "what it encodes
 * is the *stated ordering key of that resource*").
 *
 * Two resources under `/sessions/{id}` do not order by `id`:
 *
 *   - **Messages** order by the per-session `ordinal` (arbitration A5). Neither `id` (UUIDv7 =
 *     ingest time) nor `createdAt` orders a transcript, because observed sessions ingest
 *     through two channels that can deliver the same burst out of order.
 *   - **Commits** order by `committedAt DESC` (§6.10.1), which is not unique — so the key
 *     carries the `id` as a tiebreak. Without it, two commits sharing a second could hide each
 *     other across a page boundary.
 */

export function encodeOrdinalCursor(ordinal: number): string {
  return encodeCursor(String(ordinal));
}

export function decodeOrdinalCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;

  const key = decodeCursor(cursor);
  const ordinal = Number(key);
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
  }
  return ordinal;
}

const COMMIT_CURSOR_SEPARATOR = '|';

export function encodeCommitCursor(cursor: CommitCursor): string {
  return encodeCursor(`${cursor.committedAt.toISOString()}${COMMIT_CURSOR_SEPARATOR}${cursor.id}`);
}

export function decodeCommitCursor(cursor: string | undefined): CommitCursor | undefined {
  if (cursor === undefined) return undefined;

  const key = decodeCursor(cursor);
  const separator = key.indexOf(COMMIT_CURSOR_SEPARATOR);
  if (separator === -1) throw invalidCommitCursor();

  const committedAt = new Date(key.slice(0, separator));
  const id = key.slice(separator + 1);
  if (Number.isNaN(committedAt.getTime()) || id.length === 0) throw invalidCommitCursor();

  return { committedAt, id };
}

function invalidCommitCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
}
