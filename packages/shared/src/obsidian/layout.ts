/**
 * The vault layout (PRD §7.1) and the rules for turning an entity into a file name.
 *
 * ```
 * Projects/  Sessions/  ADRs/  Agents/  Features/  Daily/
 * ```
 *
 * **V1 manages two of those six folders**: `Sessions/` and `ADRs/`. The other four are named
 * here because the PRD names them and because a later phase will fill them, but nothing in
 * this release reads, writes, or creates them — an empty folder appearing in an operator's
 * vault for a feature that does not exist yet is noise, not layout.
 *
 * ## The rule that everything else hangs off: **Mission Control never renames a note**
 *
 * A note's identity is the `mcId` in its front matter, never its path (`note.ts`). Once a file
 * has been created for an entity, its name is fixed: retitling an ADR rewrites the `# heading`
 * and leaves the file where it is. Two reasons, both about the operator's vault rather than
 * our convenience:
 *
 *  1. Obsidian maintains its link index on *rename*. A file moved underneath it by another
 *     process leaves `[[wikilinks]]` pointing at nothing, and no amount of care on our side
 *     repairs a link we never saw.
 *  2. A rename is a delete plus a create to every tool that watches the folder — including a
 *     sync client, which is exactly where an operator's only copy goes missing.
 *
 * The reverse direction *is* honoured: if the operator renames or moves a managed note inside
 * Obsidian, the next scan finds it by its `mcId` and the ledger follows it there.
 */

/** PRD §7.1, verbatim. Order is the order the PRD lists them in. */
export const VAULT_FOLDERS = Object.freeze({
  project: 'Projects',
  session: 'Sessions',
  adr: 'ADRs',
  agent: 'Agents',
  feature: 'Features',
  daily: 'Daily',
} as const);

/** `obsidian_sync_states.entity_type` CHECK (TDS 03 §4.3), verbatim. */
export const OBSIDIAN_ENTITY_TYPES = [
  'project',
  'session',
  'adr',
  'agent',
  'feature',
  'daily',
] as const;

export type ObsidianEntityType = (typeof OBSIDIAN_ENTITY_TYPES)[number];

/**
 * The folders V1 actually syncs. Everything outside them is invisible to this engine: not
 * scanned, not hashed, not written, not deleted.
 */
export const MANAGED_FOLDERS: readonly string[] = Object.freeze([
  VAULT_FOLDERS.session,
  VAULT_FOLDERS.adr,
]);

/** The entity types V1 exports, in the order a run processes them. */
export const MANAGED_ENTITY_TYPES: readonly ObsidianEntityType[] = Object.freeze([
  'adr',
  'session',
]);

export function folderForEntityType(entityType: ObsidianEntityType): string {
  return VAULT_FOLDERS[entityType];
}

/**
 * Characters no note name may contain.
 *
 * The set is the union of what Windows forbids (`<>:"/\|?*`) and what
 * Obsidian treats as syntax (`#^[]|`) — a `#` in a file name becomes a heading reference in a
 * wikilink, and a `[` opens one. Building the union rather than branching per platform is
 * deliberate: a vault written on Ubuntu and opened on Windows must not contain a file that
 * cannot be checked out there (F8.1 dual-OS rule).
 */
const ILLEGAL_FILENAME_CHARACTERS = /[<>:"/\\|?*#^[\]]/g;

const LAST_CONTROL_CODE_POINT = 0x1f;

/**
 * Control characters, replaced by code point rather than by a regex range: embedding raw
 * control bytes in source is unreadable and a lint error, and a title containing one arrived
 * from somewhere unexpected in the first place.
 */
function stripControlCharacters(raw: string): string {
  let out = '';
  for (const character of raw) {
    out += (character.codePointAt(0) ?? 0) <= LAST_CONTROL_CODE_POINT ? ' ' : character;
  }
  return out;
}

/** Windows refuses these as *base* names regardless of extension. */
const RESERVED_WINDOWS_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Long enough for a real ADR title, short enough that
 * `<vault>/ADRs/<name>.conflict-20260813-101500.md` clears Windows' 260-character path limit
 * from a plausibly deep vault root.
 */
export const MAX_NOTE_BASENAME_LENGTH = 90;

/**
 * Make an arbitrary title safe as a file base name on both target platforms.
 *
 * Never returns an empty string: a title consisting entirely of illegal characters degrades to
 * `Untitled`, because a file called `.md` is not a note.
 */
export function sanitizeNoteName(raw: string): string {
  const collapsed = stripControlCharacters(raw)
    .replace(ILLEGAL_FILENAME_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently strips trailing dots and spaces from file names, which would make our
    // idea of the path and the filesystem's disagree forever.
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_NOTE_BASENAME_LENGTH)
    .replace(/[.\s]+$/, '');

  if (collapsed.length === 0) return 'Untitled';
  if (RESERVED_WINDOWS_NAMES.has(collapsed.toLowerCase())) return `${collapsed} note`;
  return collapsed;
}

/** `7` -> `ADR-0007`. Four digits because a single-user vault will not reach five. */
export function adrNumberLabel(adrNumber: number): string {
  return `ADR-${String(adrNumber).padStart(4, '0')}`;
}

/** `ADRs/ADR-0007 Use pg-boss for the job queue.md` — vault-relative, forward slashes. */
export function adrNotePath(adrNumber: number, title: string): string {
  return `${VAULT_FOLDERS.adr}/${sanitizeNoteName(`${adrNumberLabel(adrNumber)} ${title}`)}.md`;
}

/**
 * `Sessions/2026-08-13 Fix the login redirect.md` — vault-relative, forward slashes.
 *
 * The date prefix is the session's start (falling back to creation), rendered in **UTC**: a
 * note name that depends on the reader's timezone is a note name that changes when the
 * operator travels.
 */
export function sessionNotePath(startedAt: Date, title: string | null, sessionId: string): string {
  const day = startedAt.toISOString().slice(0, 10);
  const label = title === null || title.trim().length === 0 ? shortId(sessionId) : title;
  return `${VAULT_FOLDERS.session}/${sanitizeNoteName(`${day} ${label}`)}.md`;
}

/** First segment of a UUID — enough to disambiguate inside one vault, short enough to read. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Disambiguate a path already claimed by a different entity.
 *
 * `ADRs/ADR-0007 Title.md` -> `ADRs/ADR-0007 Title (0199a3f1).md`. Deterministic in the entity
 * id, so the same entity lands on the same fallback name on every run rather than growing a
 * new file each time.
 */
export function disambiguatePath(vaultPath: string, entityId: string): string {
  const suffix = ` (${shortId(entityId)})`;
  const dot = vaultPath.lastIndexOf('.');
  if (dot <= 0) return `${vaultPath}${suffix}`;
  return `${vaultPath.slice(0, dot)}${suffix}${vaultPath.slice(dot)}`;
}

/**
 * The conflict-copy path for a vault file — where a losing version goes so that it is still
 * there afterwards (see `apply.ts`).
 *
 * `ADRs/ADR-0007 Title.md` -> `ADRs/ADR-0007 Title.conflict-20260813-101500.md`
 *
 * It keeps the `.md` extension on purpose: Obsidian indexes it, so the operator *finds* the
 * copy by searching their own vault instead of having to be told a path they will not read.
 * `scan.ts` excludes the pattern, so a conflict copy is never mistaken for the note it came
 * from (both carry the same `mcId`).
 */
export function conflictCopyPath(vaultPath: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dot = vaultPath.lastIndexOf('.');
  const marker = `.conflict-${stamp}`;
  if (dot <= 0) return `${vaultPath}${marker}`;
  return `${vaultPath.slice(0, dot)}${marker}${vaultPath.slice(dot)}`;
}

/** Does this vault-relative path look like a conflict copy this engine wrote? */
export function isConflictCopyPath(vaultPath: string): boolean {
  return /\.conflict-\d{8}-\d{6}\./.test(vaultPath);
}
