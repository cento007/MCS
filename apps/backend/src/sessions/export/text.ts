/**
 * Making arbitrary recorded text safe to put inside a Markdown document — the shared half of
 * `render.ts` (Export) and `package.ts` (Context package).
 *
 * Everything these two documents embed came from somewhere Mission Control does not control:
 * an operator's prompt, an assistant's Markdown, a tool result that was really a terminal
 * capture. Three of those can break the *container* rather than merely look odd, and each is
 * handled here once so both documents behave identically.
 *
 *  1. **Control characters.** `messages.content` is PostgreSQL `text`, so `U+0000` cannot be in
 *     there (the driver rejects it), but every other C0 control can — and `ESC` in particular
 *     arrives routinely, because a tool result is frequently a terminal capture complete with
 *     ANSI colour sequences. Written straight into a `.md` file those either vanish in a viewer
 *     or reprogram a terminal that `cat`s it. They are **escaped, not stripped**: `<U+001B>` is
 *     visible, unambiguous and countable, whereas silent removal would leave the reader unable
 *     to tell a clean transcript from a scrubbed one.
 *
 *  2. **Unbalanced code fences.** An assistant message that opens a fence and never closes it
 *     turns the entire remainder of the document into one code block — every later section
 *     swallowed and invisible. `closeOpenFences` repairs it and **says that it did**, because a
 *     silent repair is a document that differs from the record without admitting it.
 *
 *  3. **Front-matter and structural delimiters.** A line of `---` after a paragraph is a setext
 *     `<h2>`; a line of `## Files` inside a message is indistinguishable from one of this
 *     document's own headings. `blockquote` neutralises both, and it is why operator prompts —
 *     short, high-value, and the text most likely to contain Markdown someone pasted — are
 *     always quoted rather than inlined. A code fence inside a block quote is closed by the end
 *     of the quote (CommonMark: the quote's lazy continuation ends it), so quoting also contains
 *     an unbalanced fence by construction.
 *
 * None of this rewrites meaning. It escapes, it closes, and it announces; it never summarises,
 * paraphrases or drops.
 */

/**
 * Tested by code point rather than by a character-class regex.
 *
 * A regex over a range of unprintable characters has to *contain* those characters or an escape
 * for them, and both forms are things a future editor cannot see and can therefore break by
 * accident. `9` and `10` are tab and newline, which are structural in Markdown; `0x7F` is DEL,
 * which is not a C0 control but behaves like one in every viewer.
 */
function isControlCode(code: number): boolean {
  if (code === 9 || code === 10) return false;
  return code < 0x20 || code === 0x7f;
}

/** Opening/closing fence of a fenced code block: 3+ backticks or 3+ tildes, ≤ 3 spaces indent. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Normalise line endings and make control characters visible.
 *
 * CRLF collapses to LF first so a Windows-recorded transcript does not produce a `<U+000D>` on
 * every line; a *lone* `\r` survives that and is escaped, which is correct — it is a carriage
 * return used as a control character (a progress bar), not a line ending.
 */
export function sanitizeText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');

  let out = '';
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    out += isControlCode(code) ? escapeControl(code) : character;
  }
  return out;
}

function escapeControl(code: number): string {
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** How many control characters `sanitizeText` would escape. Reported, never guessed. */
export function countControlCharacters(text: string): number {
  let total = 0;
  for (const character of text.replace(/\r\n/g, '\n')) {
    if (isControlCode(character.codePointAt(0) ?? 0)) total += 1;
  }
  return total;
}

export interface FenceRepair {
  readonly text: string;
  /** True when a fence was left open and this function closed it. */
  readonly repaired: boolean;
}

/**
 * Close any code fence the text left open.
 *
 * CommonMark's rule is that a fence is closed by a run of the *same* character at least as long
 * as the opener, so the repair emits exactly the opener that is outstanding. Only one fence can
 * be open at a time — a fence line inside an open block is a closer or ordinary content, never a
 * second opener — which is what makes this a single-state scan rather than a parser.
 */
export function closeOpenFences(text: string): FenceRepair {
  let open: string | null = null;

  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? '';

    if (open === null) {
      open = marker;
      continue;
    }
    // A closer must be the same character, at least as long, and carry no info string.
    if (marker[0] === open[0] && marker.length >= open.length && (match[2] ?? '').trim() === '') {
      open = null;
    }
  }

  if (open === null) return { text, repaired: false };
  return { text: `${text}\n${open}`, repaired: true };
}

/**
 * Quote every line, including blank ones.
 *
 * Blank lines carry the `>` too: without it the quote ends and the rest of the prompt becomes
 * document-level Markdown again, which is the exact containment this function exists to provide.
 */
export function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Wrap text in a fence long enough that nothing inside can close it.
 *
 * Used where the content is *not* Markdown and must not be rendered as any. The fence length is
 * `longest run of backticks + 1`, floor 3, which is CommonMark's own escape hatch rather than an
 * invention.
 */
export function fenced(text: string, info = ''): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** `` `text` `` with a backtick run that the content cannot terminate. */
export function code(text: string): string {
  const longest = longestBacktickRun(text);
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const character of text) {
    if (character === '`') {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return longest;
}

/** `- **Label:** value`, or nothing at all when there is no value. Never `- **Label:** null`. */
export function fact(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) return null;
  return `- **${label}:** ${value}`;
}

/** The bullets that have a value, joined. Empty when every one of them was empty. */
export function facts(entries: readonly (string | null)[]): string {
  return entries.filter((line): line is string => line !== null).join('\n');
}

/**
 * A rough token count for the rendered document (TDS 04 §6.7's `tokenEstimate`).
 *
 * **It is an estimate and the name says so.** ~4 UTF-8 bytes per token is the widely-observed
 * ratio for English prose under a BPE tokenizer; code and JSON run denser (nearer 2.5–3), prose
 * with long words sparser. The only value that is a *guarantee* rather than an estimate is
 * `utf8Bytes` itself — a byte-level BPE can never emit more tokens than bytes, which is the
 * bound `packages/shared/src/memory/chunk.ts` derives and relies on — so both numbers are
 * reported and the caller can choose which one to trust.
 */
export function estimateTokens(utf8Bytes: number): number {
  return Math.ceil(utf8Bytes / 4);
}
