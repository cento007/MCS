import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';

/**
 * The Notification list's ordering key (F5.3: the cursor encodes "the stated ordering key of
 * that resource").
 *
 * `GET /notifications` is **newest first by `created_at`**, which is what both indexes are
 * built on — `ix_notifications_unread (user_id, created_at DESC) WHERE read_at IS NULL` and
 * `ix_notifications_user_created` (TDS 03 §4.2). Ordering by `id` instead would be *almost*
 * the same order (UUIDv7 is time-ordered) while making the partial index unusable for the
 * `?unread=true` page, which is the one the badge polls.
 *
 * `created_at` is not unique — two notifications from one event chain share a millisecond —
 * so the key carries the `id` as a tiebreak, exactly as the commits cursor does (§6.10.1).
 */

export interface NotificationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const SEPARATOR = '|';

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return encodeCursor(`${cursor.createdAt.toISOString()}${SEPARATOR}${cursor.id}`);
}

export function decodeNotificationCursor(
  cursor: string | undefined,
): NotificationCursor | undefined {
  if (cursor === undefined) return undefined;

  const key = decodeCursor(cursor);
  const separator = key.indexOf(SEPARATOR);
  if (separator === -1) throw invalidCursor();

  const createdAt = new Date(key.slice(0, separator));
  const id = key.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) throw invalidCursor();

  return { createdAt, id };
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
}
