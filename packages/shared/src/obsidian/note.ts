import { createHash } from 'node:crypto';
import {
  type FrontMatter,
  frontMatterValue,
  mergeFrontMatter,
  parseFrontMatter,
  renderFrontMatter,
} from './front-matter.js';
import { OBSIDIAN_ENTITY_TYPES, type ObsidianEntityType } from './layout.js';

/**
 * The note format: front matter carrying the entity identity, one `#` title, and `##` sections.
 *
 * ## Identity lives in the front matter, never in the file name
 *
 * ```yaml
 * ---
 * mcId: "0199a3f1-6c2e-7a10-9f01-3d4e5f607182"
 * mcType: "adr"
 * ---
 * ```
 *
 * `mcId` + `mcType` are what let a note be matched back to its row after the operator renames
 * it, moves it into a sub-folder, or restores it from a backup under a different name. Nothing
 * in this engine derives identity from a path.
 *
 * ## Unknown sections survive a round trip, and that is the whole point
 *
 * A note is parsed into an ordered list of `##` sections. Mission Control owns a fixed set of
 * headings per note type; **every other section is carried through to the rewritten file
 * unchanged**, after the canonical ones. Without this, the first export after an operator adds
 * `## Notes to self` to an ADR would delete it — silently, in a file the operator believes is
 * theirs. The same rule applies to unrecognised front-matter keys (`front-matter.ts`).
 *
 * ## Two hashes, and they measure different things (TDS 03 §4.3)
 *
 *  - **`mc_hash`** is the hash of the **canonical projection**: the note as Mission Control
 *    would render it from the database, *excluding* preserved extras. It answers "has the
 *    Mission Control side of this note changed since the last sync".
 *  - **`vault_hash`** is the hash of the file's own text. It answers "has the vault side
 *    changed since the last sync".
 *
 * Collapsing the two into one hash is the mistake that turns a preserved operator section into
 * a permanent false positive: the file legitimately differs from our projection, forever.
 *
 * Both hashes are taken over text with line endings normalised to `\n`. Obsidian on Windows
 * may rewrite a file with CRLF without changing a single character of content, and a sync that
 * called that a change would fight the editor on every run.
 */

/** Managed front-matter keys. `mc`-prefixed so they cannot collide with an operator property. */
export const FRONT_MATTER_ID_KEY = 'mcId';
export const FRONT_MATTER_TYPE_KEY = 'mcType';

export interface NoteSection {
  /** Heading text with the `##` and surrounding whitespace removed. */
  readonly heading: string;
  /** Heading level (2 for `##`). Only level-2 sections are treated as structure. */
  readonly level: number;
  /** Body lines, verbatim, without the heading line and without trailing blank padding. */
  readonly lines: readonly string[];
}

export interface ParsedNote {
  readonly frontMatter: FrontMatter | null;
  /** The first `# ` heading, trimmed. `null` when the note has none. */
  readonly title: string | null;
  /** Body lines before the first `##` section (excluding the title line). */
  readonly preamble: readonly string[];
  readonly sections: readonly NoteSection[];
}

export interface NoteIdentity {
  readonly entityId: string;
  readonly entityType: ObsidianEntityType;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

export function parseNote(text: string): ParsedNote {
  const { frontMatter, body } = parseFrontMatter(normalizeLineEndings(text));
  const lines = body.split('\n');

  let title: string | null = null;
  const preamble: string[] = [];
  const sections: NoteSection[] = [];
  let current: { heading: string; level: number; lines: string[] } | null = null;

  for (const line of lines) {
    const match = HEADING.exec(line);
    const level = match?.[1]?.length ?? 0;

    if (match !== null && level === 1 && title === null && current === null) {
      title = (match[2] ?? '').trim();
      continue;
    }

    if (match !== null && level === 2) {
      if (current !== null) sections.push(finishSection(current));
      current = { heading: (match[2] ?? '').trim(), level, lines: [] };
      continue;
    }

    if (current === null) preamble.push(line);
    else current.lines.push(line);
  }

  if (current !== null) sections.push(finishSection(current));

  return { frontMatter, title, preamble: trimBlankEdges(preamble), sections };
}

function finishSection(section: { heading: string; level: number; lines: string[] }): NoteSection {
  return { heading: section.heading, level: section.level, lines: trimBlankEdges(section.lines) };
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim().length === 0) start += 1;
  while (end > start && (lines[end - 1] ?? '').trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

/** The Mission Control identity a note claims, or `null` when it claims none. */
export function noteIdentity(note: ParsedNote): NoteIdentity | null {
  const entityId = frontMatterValue(note.frontMatter, FRONT_MATTER_ID_KEY);
  const entityType = frontMatterValue(note.frontMatter, FRONT_MATTER_TYPE_KEY);
  if (entityId === null || entityType === null) return null;
  if (!(OBSIDIAN_ENTITY_TYPES as readonly string[]).includes(entityType)) return null;
  return { entityId, entityType: entityType as ObsidianEntityType };
}

/** The body of a named section, `null` when the note has no such heading. Case-insensitive. */
export function sectionText(note: ParsedNote, heading: string): string | null {
  const wanted = heading.toLowerCase();
  for (const section of note.sections) {
    if (section.heading.toLowerCase() === wanted) return section.lines.join('\n').trim();
  }
  return null;
}

/** Sections whose headings are not in `canonical` — the operator's own, preserved on export. */
export function extraSections(
  note: ParsedNote | null,
  canonical: readonly string[],
): readonly NoteSection[] {
  if (note === null) return [];
  const owned = new Set(canonical.map((heading) => heading.toLowerCase()));
  return note.sections.filter((section) => !owned.has(section.heading.toLowerCase()));
}

export interface RenderNoteInput {
  /** Managed front-matter keys, in the order they should first appear. */
  readonly frontMatter: readonly (readonly [string, string | number | boolean | null])[];
  /** The front matter of the file being replaced, so unknown keys survive. */
  readonly existing?: FrontMatter | null | undefined;
  readonly title: string;
  /** Canonical sections, in canonical order. A section with empty text still renders. */
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
  /** Operator-owned sections to re-emit after the canonical ones. */
  readonly extras?: readonly NoteSection[] | undefined;
}

/**
 * Render a note. Always ends with exactly one trailing newline and uses `\n` throughout —
 * git, Obsidian and every editor on both target platforms read that identically.
 */
export function renderNote(input: RenderNoteInput): string {
  const frontMatter = mergeFrontMatter(input.existing ?? null, input.frontMatter);
  const parts: string[] = [renderFrontMatter(frontMatter), `\n# ${input.title}\n`];

  for (const section of input.sections) {
    parts.push(`\n## ${section.heading}\n\n${section.body.trim()}\n`);
  }

  for (const extra of input.extras ?? []) {
    parts.push(
      `\n${'#'.repeat(extra.level)} ${extra.heading}\n\n${extra.lines.join('\n').trim()}\n`,
    );
  }

  return parts.join('');
}

/** sha256 over line-ending-normalised text — the value stored in both ledger hash columns. */
export function noteHash(text: string): string {
  return createHash('sha256').update(normalizeLineEndings(text), 'utf8').digest('hex');
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
