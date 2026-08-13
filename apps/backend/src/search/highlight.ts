/**
 * Turning PostgreSQL's `ts_headline` output into a snippet a browser can render.
 *
 * TDS 04 §11 promises `<mark>` highlights in `snippet`, and TDS 03 §4.6 pins `ts_headline` with
 * `StartSel=<mark>, StopSel=</mark>` to produce them. That is the right function and the right
 * markup, and taken literally it is also an HTML injection:
 *
 *   - a `snippet` containing `<mark>` is markup, so a client **must** render it as HTML —
 *     escaping it would show the operator the characters `<mark>` instead of a highlight;
 *   - `ts_headline` copies the source document through **verbatim**. It does not escape
 *     anything. A commit message, ADR body, PR description or assistant Message containing
 *     `<img src=x onerror=…>` arrives in the snippet as live markup.
 *
 * Both facts are true at once, so `StartSel=<mark>` cannot survive: with it, there is no way to
 * tell a `<` PostgreSQL emitted from a `<` the corpus contained, and the client has to trust
 * every character or none of them.
 *
 * **The fix is one indirection.** PostgreSQL highlights with a private sentinel that means
 * nothing to a browser; the whole headline — sentinels and all — is HTML-escaped; and only then
 * is the *escaped sentinel* replaced by real `<mark>` tags. What comes out is a string in which
 * `<mark>` and `</mark>` are the only markup that can exist, because they are the only markup
 * introduced after escaping. Source text that happens to contain the sentinel literal produces a
 * stray (possibly unbalanced) `<mark>` and nothing else — a cosmetic defect, not an injection.
 *
 * This is a deviation from §4.6's pinned `StartSel`/`StopSel` values. It is deliberate, it
 * preserves §11's contract exactly (`<mark>` highlights, and now nothing but), and it is
 * recorded here rather than in a commit message.
 */

/**
 * The sentinels handed to `ts_headline`. Deliberately ASCII, deliberately comma-free (the
 * option string is comma-delimited), and deliberately not valid HTML — if this ever leaked
 * through unescaped it would render as inert text rather than as a tag.
 */
export const HEADLINE_START_SENTINEL = '<<<mc-hl>>>';
export const HEADLINE_STOP_SENTINEL = '<<</mc-hl>>>';

/**
 * `ts_headline` options (§4.6's `MaxFragments=2, MinWords=5, MaxWords=18`, with the sentinels
 * above substituted for the raw tags).
 *
 * `HighlightAll` is deliberately **not** set: it returns the whole document, which for a
 * Message means the entire turn.
 */
export const HEADLINE_OPTIONS =
  `StartSel=${HEADLINE_START_SENTINEL}, StopSel=${HEADLINE_STOP_SENTINEL}, ` +
  'MaxFragments=2, MinWords=5, MaxWords=18';

/**
 * Hard ceiling on a rendered snippet.
 *
 * `MaxWords=18` bounds the *word count*, not the character count, and a "word" is whatever the
 * text-search parser calls one — a base64 blob pasted into an assistant Message is a single
 * token tens of thousands of characters long. Without this, one such row makes a `limit=200`
 * page enormous, which is exactly the unbounded response the §4.6 `left(…, 100000)` guard exists
 * to prevent one layer down.
 */
export const SNIPPET_MAX_CHARS = 600;

const ELLIPSIS = '…';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** `&` first is not a style choice — escaping it after `<` would double-escape `&lt;`. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

const ESCAPED_START = escapeHtml(HEADLINE_START_SENTINEL);
const ESCAPED_STOP = escapeHtml(HEADLINE_STOP_SENTINEL);

/**
 * Raw `ts_headline` output -> the `snippet` field of TDS 04 §11.
 *
 * Escape-then-substitute, in that order. The reverse order (substitute `<mark>`, then escape)
 * would escape the tags it just introduced and show the operator literal `&lt;mark&gt;`.
 */
export function toSnippet(headline: string): string {
  return escapeHtml(truncateHeadline(headline))
    .replaceAll(ESCAPED_STOP, '</mark>')
    .replaceAll(ESCAPED_START, '<mark>');
}

/**
 * Cut an over-long headline **before** escaping, and repair what the cut broke.
 *
 * Truncating after escaping would slice through an entity (`&am`) or a tag (`<ma`); truncating
 * before it can only slice through a sentinel, which is a shape this module knows exactly. Two
 * repairs follow: drop a partial sentinel from the tail, then close a highlight the cut left
 * open, so the snippet is still balanced markup.
 */
function truncateHeadline(headline: string): string {
  if (headline.length <= SNIPPET_MAX_CHARS) return headline;

  const cut = dropPartialSentinelTail(headline.slice(0, SNIPPET_MAX_CHARS));
  const opened = countOccurrences(cut, HEADLINE_START_SENTINEL);
  const closed = countOccurrences(cut, HEADLINE_STOP_SENTINEL);

  return `${cut}${opened > closed ? HEADLINE_STOP_SENTINEL : ''}${ELLIPSIS}`;
}

/**
 * Remove a trailing fragment that is a proper prefix of either sentinel.
 *
 * Longest first, because both sentinels share the `<<<` prefix and the longer match is the one
 * that was actually cut. A snippet that genuinely ended in `<` loses that character — a
 * cosmetic cost paid only by snippets that were already truncated.
 */
function dropPartialSentinelTail(value: string): string {
  const longest = Math.max(HEADLINE_START_SENTINEL.length, HEADLINE_STOP_SENTINEL.length) - 1;

  for (let length = Math.min(longest, value.length); length > 0; length -= 1) {
    const tail = value.slice(value.length - length);
    if (HEADLINE_START_SENTINEL.startsWith(tail) || HEADLINE_STOP_SENTINEL.startsWith(tail)) {
      return value.slice(0, value.length - length);
    }
  }
  return value;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
