/**
 * YAML front matter — parsed and re-emitted **preserving everything we do not understand**.
 *
 * This is not a YAML parser and must not become one. It is a line-oriented reader for the one
 * shape Obsidian's properties UI produces and the one shape we write: a `---` fenced block of
 * top-level `key: value` entries, some of which have indented continuation lines (a nested map
 * or a block list).
 *
 * ## Why not a YAML library
 *
 * Because the requirement is not "read YAML", it is **"round-trip an operator's YAML without
 * touching it"**. Every YAML library normalises on write — quoting style, key order, flow vs
 * block sequences, comments dropped entirely — and the diff lands in a file the operator owns
 * and very possibly has open. Keeping each entry as its **raw lines** and rewriting only the
 * handful of keys Mission Control owns means an unrelated property, a comment, or an anchor
 * comes back out byte-for-byte.
 *
 * What we read is deliberately tiny: the value of a top-level scalar key. Anything else is
 * opaque text that is carried along.
 */

/** One top-level entry, held as the raw lines it occupied. */
export interface FrontMatterEntry {
  readonly key: string;
  /** `key: value` plus any indented continuation lines, verbatim, without line endings. */
  readonly lines: readonly string[];
}

export interface FrontMatter {
  readonly entries: readonly FrontMatterEntry[];
}

export interface ParsedFrontMatter {
  /** `null` when the document has no front-matter block at all. */
  readonly frontMatter: FrontMatter | null;
  /** Everything after the closing fence (or the whole document when there is no block). */
  readonly body: string;
}

const FENCE = '---';

/** `key: value` at column 0. Keys are the usual Obsidian property characters. */
const ENTRY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_ -]*):(?:\s(.*))?$/;

export function parseFrontMatter(text: string): ParsedFrontMatter {
  const lines = text.split('\n');
  const first = lines[0]?.replace(/\r$/, '');
  if (first !== FENCE) return { frontMatter: null, body: text };

  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.replace(/\r$/, '') === FENCE) {
      closing = index;
      break;
    }
  }
  // An unterminated fence is not front matter — it is a document that happens to start with a
  // horizontal rule. Treating it as front matter would swallow the whole note.
  if (closing === -1) return { frontMatter: null, body: text };

  const entries: FrontMatterEntry[] = [];
  let current: { key: string; lines: string[] } | null = null;

  for (let index = 1; index < closing; index += 1) {
    const line = lines[index]?.replace(/\r$/, '') ?? '';
    const match = ENTRY_LINE.exec(line);

    if (match !== null && match[1] !== undefined) {
      if (current !== null) entries.push({ key: current.key, lines: current.lines });
      current = { key: match[1], lines: [line] };
      continue;
    }

    // A continuation (indented, blank, or a `- item`) belongs to the entry above it. A stray
    // line before any key is kept under an empty key so it still round-trips.
    if (current === null) current = { key: '', lines: [line] };
    else current.lines.push(line);
  }
  if (current !== null) entries.push({ key: current.key, lines: current.lines });

  return { frontMatter: { entries }, body: lines.slice(closing + 1).join('\n') };
}

/**
 * The scalar value of a top-level key, or `null` when the key is absent or not a scalar.
 *
 * Surrounding quotes are stripped (we write them; Obsidian sometimes does not) and a value
 * that spans continuation lines is refused rather than guessed at — a caller asking for
 * `mcId` wants an id, and half a block map is not one.
 */
export function frontMatterValue(frontMatter: FrontMatter | null, key: string): string | null {
  if (frontMatter === null) return null;

  for (const entry of frontMatter.entries) {
    if (entry.key !== key) continue;
    if (entry.lines.length !== 1) return null;

    const line = entry.lines[0] ?? '';
    const separator = line.indexOf(':');
    if (separator === -1) return null;

    const raw = line.slice(separator + 1).trim();
    if (raw.length === 0) return null;
    return unquote(raw);
  }

  return null;
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return raw;
}

/**
 * Render a value as a YAML scalar.
 *
 * Everything we emit is double-quoted apart from plain integers and booleans. Quoting by
 * default costs a couple of characters and removes an entire class of failure: an ADR titled
 * `Yes: use pg-boss` or `no` is a YAML landmine unquoted, and the file it corrupts is the
 * operator's.
 */
export function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Rewrite the managed keys of a front-matter block, preserving every other entry verbatim and
 * in place.
 *
 * Managed keys already present keep their position; new ones are appended in the order given.
 * A managed key whose new value is `null` is **removed**, which is how a field that stops
 * applying (an ADR that is no longer superseded) leaves the file instead of lingering as a
 * stale property.
 */
export function mergeFrontMatter(
  existing: FrontMatter | null,
  managed: readonly (readonly [string, string | number | boolean | null])[],
): FrontMatter {
  const managedValues = new Map(managed);
  const seen = new Set<string>();
  const entries: FrontMatterEntry[] = [];

  for (const entry of existing?.entries ?? []) {
    if (!managedValues.has(entry.key)) {
      entries.push(entry);
      continue;
    }

    seen.add(entry.key);
    const value = managedValues.get(entry.key) ?? null;
    if (value === null) continue;
    entries.push({ key: entry.key, lines: [`${entry.key}: ${yamlScalar(value)}`] });
  }

  for (const [key, value] of managed) {
    if (seen.has(key) || value === null) continue;
    entries.push({ key, lines: [`${key}: ${yamlScalar(value)}`] });
  }

  return { entries };
}

/** Serialize a front-matter block, fences included, with a trailing newline. */
export function renderFrontMatter(frontMatter: FrontMatter): string {
  const lines: string[] = [FENCE];
  for (const entry of frontMatter.entries) lines.push(...entry.lines);
  lines.push(FENCE);
  return `${lines.join('\n')}\n`;
}
