import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';

/**
 * The Commit list's ordering key (F5.3 / TDS 04 §1.2: the cursor encodes "the stated ordering
 * key of that resource").
 *
 * **Commits are ordered by `committed_at`, not by the UUIDv7 `id`** — and the difference is not
 * cosmetic. `id` is insertion order, and the GitHub sync inserts in the order the API hands
 * rows over: a first sync of an existing repository (`github/sync.ts`) walks history backwards
 * and therefore writes the *oldest* commits **last**, so an `id`-ordered "newest first" list
 * would open on a 2019 commit. `committed_at` is the only column that means what the list
 * claims to show.
 *
 * `committed_at` is not unique — a rebase or a scripted batch stamps many commits with the same
 * second, and `ck_commits_sha` does nothing to prevent that — so the key is the composite
 * `(committedAt, id)`. Without the `id` tiebreak two commits sharing an instant can hide each
 * other across a page boundary: the page ends on one of them, the next page asks for
 * "everything older than that instant", and the sibling is never returned.
 *
 * This is the precedent §6.10.1 established for `GET /sessions/{id}/commits` (and the audit log
 * follows it on `(occurredAt, id)`); `GET /repositories/{id}/commits` uses the same key, the
 * same encoding, and the same tiebreak, so a cursor means one thing on both routes.
 */

export interface CommitCursor {
  readonly committedAt: Date;
  readonly id: string;
}

const SEPARATOR = '|';

export function encodeCommitCursor(cursor: CommitCursor): string {
  return encodeCursor(`${cursor.committedAt.toISOString()}${SEPARATOR}${cursor.id}`);
}

export function decodeCommitCursor(cursor: string | undefined): CommitCursor | undefined {
  if (cursor === undefined) return undefined;

  const key = decodeCursor(cursor);
  const separator = key.indexOf(SEPARATOR);
  if (separator === -1) throw invalidCursor();

  const committedAt = new Date(key.slice(0, separator));
  const id = key.slice(separator + 1);
  if (Number.isNaN(committedAt.getTime()) || id.length === 0) throw invalidCursor();

  return { committedAt, id };
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
}
