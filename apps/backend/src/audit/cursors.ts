import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';

/**
 * The audit list's ordering key (F5.3: the cursor encodes "the stated ordering key of that
 * resource").
 *
 * `GET /audit-log-entries` is **newest first by `created_at`** (§12), which is what
 * `ix_audit_created_at_brin` and both composite indexes are built on (TDS 03 §3.14). Ordering
 * by `id` instead would be *almost* the same order — UUIDv7 is time-ordered — while making
 * those indexes unusable for the filtered pages the audit view actually requests.
 *
 * `created_at` is not unique: a single settings save writes a `setting.updated` row and one
 * `secret_item.updated` row per secret, inside one transaction and therefore frequently within
 * the same millisecond. The key carries `id` as a tiebreak, exactly as the Notification and
 * Commit cursors do.
 */

export interface AuditCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

const SEPARATOR = '|';

export function encodeAuditCursor(cursor: AuditCursor): string {
  return encodeCursor(`${cursor.occurredAt.toISOString()}${SEPARATOR}${cursor.id}`);
}

export function decodeAuditCursor(cursor: string | undefined): AuditCursor | undefined {
  if (cursor === undefined) return undefined;

  const key = decodeCursor(cursor);
  const separator = key.indexOf(SEPARATOR);
  if (separator === -1) throw invalidCursor();

  const occurredAt = new Date(key.slice(0, separator));
  const id = key.slice(separator + 1);
  if (Number.isNaN(occurredAt.getTime()) || id.length === 0) throw invalidCursor();

  return { occurredAt, id };
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
}
