import { adrNumberLabel, type ObsidianEntityType, shortId, VAULT_FOLDERS } from './layout.js';
import {
  FRONT_MATTER_ID_KEY,
  FRONT_MATTER_TYPE_KEY,
  type NoteSection,
  noteHash,
  type ParsedNote,
  renderNote,
} from './note.js';

/**
 * The projections: a database row rendered as the note Mission Control owns.
 *
 * Every renderer here is **pure and deterministic** — same row in, same bytes out. That is not
 * a style preference: `mc_hash` is the hash of this output, and a renderer that varied (a
 * locale-formatted date, a `Set` iteration order, "3 minutes ago") would report a change on
 * every run and rewrite the operator's vault forever.
 *
 * Two rendering rules follow from that:
 *  - **UTC ISO-8601 everywhere.** No local time, no relative time.
 *  - **No "generated at" stamp.** It is the single most tempting field to add and it would
 *    make every note differ from itself on every run.
 */

/** PRD §7.3, verbatim and in order. These four headings *are* the ADR template. */
export const ADR_SECTIONS = Object.freeze([
  'Context',
  'Decision',
  'Alternatives',
  'Consequences',
] as const);

export const SESSION_SECTIONS = Object.freeze(['Summary', 'Prompts', 'Outcome', 'Files'] as const);

/** Rendered when a template section is empty — an empty `##` heading reads like a bug. */
const EMPTY_SECTION = '_Not recorded._';

export interface AdrNoteInput {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly adrNumber: number;
  readonly title: string;
  readonly status: string;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: string;
  readonly consequences: string;
  readonly supersededByAdrId: string | null;
  readonly sourceSessionId: string | null;
  /**
   * The path already recorded on the row. Not rendered — it is here so the engine can skip an
   * `UPDATE` that would change nothing, because that write bumps `updated_at`, which is *in*
   * the projection, which would make every sync report a change and rewrite the vault forever.
   */
  readonly obsidianPath: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SessionNoteInput {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly repositoryName: string | null;
  readonly title: string | null;
  readonly state: string;
  readonly sessionType: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly branch: string | null;
  readonly workingDir: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly durationMs: number | null;
  readonly numTurns: number | null;
  readonly totalCostUsd: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Operator prompts, in order, already bounded and truncated by the reader. */
  readonly prompts: readonly string[];
  /** The final assistant message, already bounded. */
  readonly outcome: string | null;
  /** Absolute native paths a file-naming tool touched, de-duplicated and sorted. */
  readonly files: readonly string[];
  /** How many of each were dropped by the bound, so the note says so instead of lying. */
  readonly promptsOmitted: number;
  readonly filesOmitted: number;
}

export function renderAdrNote(
  adr: AdrNoteInput,
  existing: ParsedNote | null,
  extras: readonly NoteSection[] = [],
): string {
  return renderNote({
    frontMatter: [
      [FRONT_MATTER_ID_KEY, adr.id],
      [FRONT_MATTER_TYPE_KEY, 'adr' satisfies ObsidianEntityType],
      ['mcProjectId', adr.projectId],
      ['adrNumber', adr.adrNumber],
      ['status', adr.status],
      ['project', adr.projectName],
      ['sourceSessionId', adr.sourceSessionId],
      ['supersededBy', adr.supersededByAdrId],
      ['created', adr.createdAt.toISOString()],
      // **No `updated` key, deliberately.** `updated_at` moves on every write, including the
      // write that records where the note was filed — so a projection containing it differs
      // from itself on the next run, and the vault is rewritten on a timer. The row's
      // `updated_at` is still consulted for `newer_wins`; it just does not live in the file.
      ['tags', 'mission-control/adr'],
    ],
    existing: existing?.frontMatter ?? null,
    // The H1 is the title, and it is the *only* place the title lives in the file: two
    // sources would mean choosing one on import, and the operator edits the heading.
    title: adr.title,
    sections: [
      { heading: 'Context', body: orEmpty(adr.context) },
      { heading: 'Decision', body: orEmpty(adr.decision) },
      { heading: 'Alternatives', body: orEmpty(adr.alternatives) },
      { heading: 'Consequences', body: orEmpty(adr.consequences) },
    ],
    extras,
  });
}

export function renderSessionNote(
  session: SessionNoteInput,
  existing: ParsedNote | null,
  extras: readonly NoteSection[] = [],
): string {
  const title =
    session.title === null || session.title.trim().length === 0
      ? `Session ${shortId(session.id)}`
      : session.title.trim();

  return renderNote({
    frontMatter: [
      [FRONT_MATTER_ID_KEY, session.id],
      [FRONT_MATTER_TYPE_KEY, 'session' satisfies ObsidianEntityType],
      ['mcProjectId', session.projectId],
      ['state', session.state],
      ['sessionType', session.sessionType],
      ['project', session.projectName],
      ['repository', session.repositoryName],
      ['model', session.model],
      ['branch', session.branch],
      ['started', session.startedAt?.toISOString() ?? null],
      ['completed', session.completedAt?.toISOString() ?? null],
      ['tags', 'mission-control/session'],
    ],
    existing: existing?.frontMatter ?? null,
    title,
    sections: [
      { heading: 'Summary', body: sessionSummary(session) },
      { heading: 'Prompts', body: sessionPrompts(session) },
      { heading: 'Outcome', body: sessionOutcome(session) },
      { heading: 'Files', body: sessionFiles(session) },
    ],
    extras,
  });
}

function sessionSummary(session: SessionNoteInput): string {
  const lines = [
    bullet('State', session.state),
    bullet('Type', `${session.sessionType} (${session.runtime})`),
    bullet('Project', session.projectName),
    bullet('Repository', session.repositoryName),
    bullet('Branch', session.branch),
    bullet('Working directory', session.workingDir),
    bullet('Model', session.model),
    bullet('Started', session.startedAt?.toISOString() ?? null),
    bullet('Completed', session.completedAt?.toISOString() ?? null),
    bullet('Duration', session.durationMs === null ? null : formatDuration(session.durationMs)),
    bullet('Turns', session.numTurns === null ? null : String(session.numTurns)),
    bullet('Cost', session.totalCostUsd === null ? null : `$${session.totalCostUsd}`),
    bullet('Failure reason', session.failureReason),
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
}

function sessionPrompts(session: SessionNoteInput): string {
  if (session.prompts.length === 0) return EMPTY_SECTION;

  const blocks = session.prompts.map((prompt) => quoteBlock(prompt));
  if (session.promptsOmitted > 0) {
    blocks.push(
      `_${session.promptsOmitted} earlier prompt(s) omitted — see the session in Mission Control._`,
    );
  }
  return blocks.join('\n\n');
}

function sessionOutcome(session: SessionNoteInput): string {
  if (session.outcome === null || session.outcome.trim().length === 0) return EMPTY_SECTION;
  return session.outcome.trim();
}

function sessionFiles(session: SessionNoteInput): string {
  if (session.files.length === 0) return EMPTY_SECTION;

  const lines = session.files.map((file) => `- \`${file}\``);
  if (session.filesOmitted > 0) lines.push(`- _…and ${session.filesOmitted} more._`);
  return lines.join('\n');
}

function bullet(label: string, value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  return `- **${label}:** ${value}`;
}

function quoteBlock(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function orEmpty(text: string): string {
  return text.trim().length === 0 ? EMPTY_SECTION : text.trim();
}

/**
 * The canonical projection's hash — `obsidian_sync_states.mc_hash`.
 *
 * Taken over the note rendered **without** preserved extras and **without** the existing
 * front matter, so it measures the Mission Control side alone. See `note.ts` for why the two
 * hashes cannot be one.
 */
export function canonicalAdrHash(adr: AdrNoteInput): string {
  return noteHash(renderAdrNote(adr, null, []));
}

export function canonicalSessionHash(session: SessionNoteInput): string {
  return noteHash(renderSessionNote(session, null, []));
}

/** Where the folder for an entity type lives — re-exported so callers need one import. */
export const ENTITY_FOLDERS = VAULT_FOLDERS;

/** `ADR-0007` — used in log lines and conflict reports. */
export { adrNumberLabel };
