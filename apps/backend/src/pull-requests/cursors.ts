import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';

/**
 * The PullRequest list's ordering key (F5.3 / TDS 04 §1.2).
 *
 * **Ordered by `opened_at` — GitHub's clock — not by the UUIDv7 `id`.** Same reasoning as the
 * Commit cursor next door: `id` is *our* insertion order, and the sync inserts whatever page
 * GitHub returned first, so a repository backfilled today would list a 2024 pull request as its
 * "newest". Whether a PR is recent is a fact about the PR, not about when Mission Control
 * happened to hear of it.
 *
 * `opened_at` is nullable (TDS 03 §3.8 — GitHub can omit `created_at`, and `github/map.ts`
 * refuses to invent one), so the ordering is `opened_at DESC NULLS LAST, id DESC`: an
 * undateable PR sorts after every dateable one instead of jumping to the top. The cursor
 * therefore encodes an **empty instant** for those rows, and the keyset predicate handles the
 * two cases separately. It carries `id` as a tiebreak for the same reason the Commit cursor
 * does — several PRs opened in the same second must not be able to hide each other across a
 * page boundary.
 *
 * There is no `?order=` on this resource: §5.3 states no ordering, and unlike §5.2 ("`order=desc`
 * default *here*") it implies no parameter either. Newest-opened-first is what the Repository
 * detail screen shows (TDS 06 §5.3.2), and an ascending variant of a NULLS-LAST keyset is
 * complexity bought for a caller that does not exist.
 */

export interface PullRequestCursor {
  /** `null` for a row with no `opened_at` — those sort last, after every dated PR. */
  readonly openedAt: Date | null;
  readonly id: string;
}

const SEPARATOR = '|';

export function encodePullRequestCursor(cursor: PullRequestCursor): string {
  return encodeCursor(`${cursor.openedAt?.toISOString() ?? ''}${SEPARATOR}${cursor.id}`);
}

export function decodePullRequestCursor(cursor: string | undefined): PullRequestCursor | undefined {
  if (cursor === undefined) return undefined;

  const key = decodeCursor(cursor);
  const separator = key.indexOf(SEPARATOR);
  if (separator === -1) throw invalidCursor();

  const instant = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (id.length === 0) throw invalidCursor();

  if (instant.length === 0) return { openedAt: null, id };

  const openedAt = new Date(instant);
  if (Number.isNaN(openedAt.getTime())) throw invalidCursor();
  return { openedAt, id };
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
}
