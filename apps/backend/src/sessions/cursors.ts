import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';

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
 *
 * The commit cursor is **re-exported, not re-implemented**: `commits/cursors.ts` owns it, and
 * `GET /sessions/{id}/commits` and `GET /repositories/{id}/commits` must agree on what a cursor
 * for that resource means, byte for byte.
 */

export {
  type CommitCursor,
  decodeCommitCursor,
  encodeCommitCursor,
} from '../commits/cursors.js';

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
