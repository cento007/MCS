/**
 * Session title derivation — TDS 04 §6.11 (arbitration A13), implemented rule-for-rule.
 *
 * `sessions.title` is the primary human label for a Session on every surface, and the Backend
 * fills it because a client-only derivation would leave Telegram, Obsidian, exports and the
 * full-text index (rank class `A`) reading "Untitled" while the browser alone looked right.
 *
 * This is **deterministic string handling, not summarization**: no LLM call, no runtime
 * round-trip, no background job. It has to be computable inside the transaction that persists
 * the first user Message and it has to yield the same title on replay (§6.11).
 */

/** A derived title is never longer than this, counted in Unicode code points (§6.11.2). */
export const MAX_DERIVED_TITLE_CODE_POINTS = 60;

/** Truncation cuts within the first 59 code points, leaving room for the ellipsis. */
const TRUNCATE_AT_CODE_POINTS = MAX_DERIVED_TITLE_CODE_POINTS - 1;

const ELLIPSIS = '…';

/** Operator-set titles are bounded by the API, not by the derivation rule (§6.11.4, §16). */
export const MAX_TITLE_LENGTH = 200;

/** Only these count as whitespace for the collapse step (§6.11.2 step 3). */
const COLLAPSIBLE_WHITESPACE = /[ \t\u00A0]+/g;
const TRAILING_WHITESPACE = /[ \t\u00A0]+$/;

/** C0 and C1 control characters, dropped after the whitespace collapse (§6.11.2 step 3). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters IS the rule
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

const LEADING_BOM = /^\uFEFF/;
const LINE_ENDINGS = /\r\n?/g;

/**
 * A line that is nothing but a Markdown code fence — ``` or ~~~, with or without an info
 * string. Skipped while scanning for the first surviving line, so a prompt that opens with a
 * fenced code block titles itself from the first line of code rather than from "```ts".
 */
const CODE_FENCE_ONLY = /^(?:`{3,}[^`]*|~{3,}[^~]*)$/;

/**
 * Derive a title from a user Message's rendered text.
 *
 * @returns the title, or `null` when the rule produces nothing (§6.11.2 step 6) — in which
 *   case the caller writes nothing and the Session stays unnamed (§6.11.5 fallback applies).
 */
export function deriveSessionTitle(content: string): string | null {
  // 1. Normalize line endings and strip a leading BOM.
  const normalized = content.replace(LEADING_BOM, '').replace(LINE_ENDINGS, '\n');

  // 2. First line that is neither blank nor a bare code fence.
  const line = firstSurvivingLine(normalized);
  if (line === null) return null;

  // 3. Collapse whitespace runs, drop control characters, trim. This line only — the newline
  //    handling was step 2's job, so nothing from a later line can be folded in.
  const cleaned = line.replace(COLLAPSIBLE_WHITESPACE, ' ').replace(CONTROL_CHARACTERS, '').trim();

  // 6. Nothing left: write nothing.
  if (cleaned.length === 0) return null;

  // 4/5. Length is counted in code points, never UTF-16 units, so a cut can never split a
  // surrogate pair and the rule produces byte-identical output in any runtime.
  const codePoints = [...cleaned];
  if (codePoints.length <= MAX_DERIVED_TITLE_CODE_POINTS) return cleaned;

  const head = codePoints.slice(0, TRUNCATE_AT_CODE_POINTS);
  const lastSpace = head.lastIndexOf(' ');
  // No space in the first 59 code points (a path, a URL, a minified line): hard-cut.
  const cut = lastSpace === -1 ? head : head.slice(0, lastSpace);

  return `${cut.join('').replace(TRAILING_WHITESPACE, '')}${ELLIPSIS}`;
}

function firstSurvivingLine(normalized: string): string | null {
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (CODE_FENCE_ONLY.test(trimmed)) continue;
    return line;
  }
  return null;
}

/**
 * Normalize a title supplied by an operator (`POST /sessions`, `PATCH /sessions/{id}`).
 *
 * Empty and whitespace-only both become `NULL`, so "unnamed" has exactly one storage
 * representation and the `title IS NULL` derivation guard stays total (§6.11.3).
 */
export function normalizeOperatorTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined) return null;
  const trimmed = title.trim();
  return trimmed.length === 0 ? null : trimmed;
}
