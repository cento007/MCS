import { desc, eq, inArray, sql } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import { isAdrStatus } from '../entities/adr.js';
import { adrNotePath, sessionNotePath } from './layout.js';
import { type ParsedNote, sectionText } from './note.js';
import type { AdrImport, DesiredNote } from './plan.js';
import {
  ADR_SECTIONS,
  type AdrNoteInput,
  canonicalAdrHash,
  canonicalSessionHash,
  renderAdrNote,
  renderSessionNote,
  SESSION_SECTIONS,
  type SessionNoteInput,
} from './render.js';

/**
 * The reads that turn database rows into `DesiredNote`s — "what should be in the vault".
 *
 * ## What V1 exports, and what it does not
 *
 * **ADRs** — every one of them. There are tens, they are the whole point of §7.3, and they
 * are the only note type this release imports back.
 *
 * **Sessions** — only sessions that have *finished* (`completed`, `failed`, `archived`), most
 * recent first, bounded. A Session Note is a record of what happened; writing one while the
 * session is still running means rewriting it on every sync for as long as the session lives,
 * which is churn in a folder the operator is reading. Bounding the count keeps a run's work
 * proportional to recent activity rather than to lifetime history — an older note already in
 * the vault is simply left alone, because a finished session cannot change.
 *
 * **Not exported at all in V1:** Projects, Agents, Features, Daily notes, and Requirements
 * documents (PRD §7.2 lists Feature Notes and Requirements; both need a source entity that
 * does not exist yet — there is no Feature entity in F4.1).
 *
 * ## The message reads are windowed, not looped
 *
 * A session note quotes the operator's prompts, the final assistant message and the files the
 * run touched. Fetching those per session would be three queries per note; instead each is one
 * windowed query over the whole batch, with the per-session cap expressed as a `row_number()`
 * filter and the text truncated in SQL. A vault sync must not be able to pull a megabyte of
 * transcript into memory per note.
 */

export const DEFAULT_MAX_SESSION_NOTES = 500;
export const MAX_PROMPTS_PER_NOTE = 10;
export const MAX_PROMPT_CHARACTERS = 2_000;
export const MAX_OUTCOME_CHARACTERS = 4_000;
export const MAX_FILES_PER_NOTE = 50;

/** The states whose sessions get a note. Anything still in flight is deliberately excluded. */
export const EXPORTED_SESSION_STATES = ['completed', 'failed', 'archived'] as const;

export type DbLike = Db | DbTransaction;

export interface DesiredNotes {
  readonly notes: readonly DesiredNote[];
  /** The ADR rows behind the notes, for the import path (audit `before`, re-hashing). */
  readonly adrs: ReadonlyMap<string, AdrNoteInput>;
}

export interface BuildDesiredOptions {
  readonly maxSessionNotes?: number;
}

export async function buildDesiredNotes(
  db: DbLike,
  options: BuildDesiredOptions = {},
): Promise<DesiredNotes> {
  const [adrs, sessions] = await Promise.all([
    readAdrNoteInputs(db),
    readSessionNoteInputs(db, options.maxSessionNotes ?? DEFAULT_MAX_SESSION_NOTES),
  ]);

  const notes: DesiredNote[] = [];
  const adrMap = new Map<string, AdrNoteInput>();

  for (const adr of adrs) {
    adrMap.set(adr.id, adr);
    notes.push(adrDesiredNote(adr));
  }
  for (const session of sessions) notes.push(sessionDesiredNote(session));

  return { notes, adrs: adrMap };
}

export function adrDesiredNote(adr: AdrNoteInput): DesiredNote {
  return {
    entityType: 'adr',
    entityId: adr.id,
    idealPath: adrNotePath(adr.adrNumber, adr.title),
    canonicalHash: canonicalAdrHash(adr),
    updatedAt: adr.updatedAt,
    canonicalSections: ADR_SECTIONS,
    render: (existing) => renderAdrNote(adr, existing, extrasOf(existing, ADR_SECTIONS)),
    parseImport: parseAdrImport,
  };
}

export function sessionDesiredNote(session: SessionNoteInput): DesiredNote {
  return {
    entityType: 'session',
    entityId: session.id,
    idealPath: sessionNotePath(session.startedAt ?? session.createdAt, session.title, session.id),
    canonicalHash: canonicalSessionHash(session),
    updatedAt: session.updatedAt,
    canonicalSections: SESSION_SECTIONS,
    render: (existing) =>
      renderSessionNote(session, existing, extrasOf(existing, SESSION_SECTIONS)),
    // No `parseImport`: Session Notes are an export-only mirror in V1 (see the header).
  };
}

function extrasOf(existing: ParsedNote | null, canonical: readonly string[]) {
  if (existing === null) return [];
  const owned = new Set(canonical.map((heading) => heading.toLowerCase()));
  return existing.sections.filter((section) => !owned.has(section.heading.toLowerCase()));
}

/**
 * Read a vault ADR note back into row fields.
 *
 * Deliberately conservative, in both directions:
 *
 *  - A **missing** section returns `null` for that field, which the applier reads as "leave the
 *    database value alone". Absence is not emptiness: an operator who deleted the `## Context`
 *    heading while reorganising has not asked us to erase the context.
 *  - Our own `_Not recorded._` placeholder maps back to the empty string, so a note that was
 *    exported and never touched round-trips to exactly the row it came from.
 *  - An unrecognised `status` is refused rather than coerced. The four values are a CHECK
 *    constraint; guessing which one `Accepted?` meant is not this function's business, so the
 *    field is skipped and the reason is carried out in `warning`.
 */
export function parseAdrImport(note: ParsedNote): AdrImport | null {
  const title = note.title === null || note.title.trim().length === 0 ? null : note.title.trim();

  const rawStatus = frontMatterStatus(note);
  const status = rawStatus !== null && isAdrStatus(rawStatus) ? rawStatus : null;
  const warning =
    rawStatus !== null && status === null
      ? `the note's status "${rawStatus}" is not one of proposed/accepted/rejected/superseded and was ignored`
      : null;

  const imported: AdrImport = {
    title,
    status,
    context: importedSection(note, 'Context'),
    decision: importedSection(note, 'Decision'),
    alternatives: importedSection(note, 'Alternatives'),
    consequences: importedSection(note, 'Consequences'),
    warning,
  };

  const hasField =
    imported.title !== null ||
    imported.status !== null ||
    imported.context !== null ||
    imported.decision !== null ||
    imported.alternatives !== null ||
    imported.consequences !== null;

  return hasField ? imported : null;
}

function frontMatterStatus(note: ParsedNote): string | null {
  for (const entry of note.frontMatter?.entries ?? []) {
    if (entry.key !== 'status' || entry.lines.length !== 1) continue;
    const line = entry.lines[0] ?? '';
    const value = line
      .slice(line.indexOf(':') + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    return value.length === 0 ? null : value;
  }
  return null;
}

function importedSection(note: ParsedNote, heading: string): string | null {
  const text = sectionText(note, heading);
  if (text === null) return null;
  return text.trim() === '_Not recorded._' ? '' : text;
}

// --------------------------------------------------------------------------------- DB reads

/** Every ADR, with its project name for the note's front matter. Ordered for stable planning. */
export async function readAdrNoteInputs(db: DbLike): Promise<AdrNoteInput[]> {
  const rows = await db
    .select({
      id: schema.adrs.id,
      projectId: schema.adrs.projectId,
      projectName: schema.projects.name,
      adrNumber: schema.adrs.adrNumber,
      title: schema.adrs.title,
      status: schema.adrs.status,
      context: schema.adrs.context,
      decision: schema.adrs.decision,
      alternatives: schema.adrs.alternatives,
      consequences: schema.adrs.consequences,
      supersededByAdrId: schema.adrs.supersededByAdrId,
      sourceSessionId: schema.adrs.sourceSessionId,
      obsidianPath: schema.adrs.obsidianPath,
      createdAt: schema.adrs.createdAt,
      updatedAt: schema.adrs.updatedAt,
    })
    .from(schema.adrs)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.adrs.projectId))
    .orderBy(schema.adrs.id);

  return rows;
}

export async function readSessionNoteInputs(
  db: DbLike,
  limit: number,
): Promise<SessionNoteInput[]> {
  const rows = await db
    .select({
      id: schema.sessions.id,
      projectId: schema.sessions.projectId,
      projectName: schema.projects.name,
      repositoryName: schema.repositories.name,
      title: schema.sessions.title,
      state: schema.sessions.state,
      sessionType: schema.sessions.sessionType,
      runtime: schema.sessions.runtime,
      model: schema.sessions.model,
      branch: schema.sessions.branch,
      workingDir: schema.sessions.workingDir,
      startedAt: schema.sessions.startedAt,
      completedAt: schema.sessions.completedAt,
      durationMs: schema.sessions.durationMs,
      numTurns: schema.sessions.numTurns,
      totalCostUsd: schema.sessions.totalCostUsd,
      failureReason: schema.sessions.failureReason,
      createdAt: schema.sessions.createdAt,
      updatedAt: schema.sessions.updatedAt,
    })
    .from(schema.sessions)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .leftJoin(schema.repositories, eq(schema.repositories.id, schema.sessions.repositoryId))
    .where(inArray(schema.sessions.state, [...EXPORTED_SESSION_STATES]))
    .orderBy(desc(schema.sessions.createdAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [prompts, outcomes, files] = await Promise.all([
    readPrompts(db, ids),
    readOutcomes(db, ids),
    readFiles(db, ids),
  ]);

  return rows.map((row) => {
    const promptRows = prompts.get(row.id) ?? { texts: [], total: 0 };
    const fileRows = files.get(row.id) ?? { paths: [], total: 0 };

    return {
      ...row,
      prompts: promptRows.texts,
      promptsOmitted: Math.max(0, promptRows.total - promptRows.texts.length),
      outcome: outcomes.get(row.id) ?? null,
      files: fileRows.paths,
      filesOmitted: Math.max(0, fileRows.total - fileRows.paths.length),
    };
  });
}

interface BoundedTexts {
  readonly texts: string[];
  readonly total: number;
}

async function readPrompts(
  db: DbLike,
  sessionIds: readonly string[],
): Promise<Map<string, BoundedTexts>> {
  const result = await db.execute<{
    session_id: string;
    content: string;
    rank: string | number;
    total: string | number;
  }>(sql`
    SELECT session_id, content, rank, total FROM (
      SELECT m.session_id,
             left(m.content, ${MAX_PROMPT_CHARACTERS}) AS content,
             row_number() OVER (PARTITION BY m.session_id ORDER BY m.ordinal) AS rank,
             count(*)     OVER (PARTITION BY m.session_id)                    AS total
      FROM messages m
      WHERE m.role = 'user' AND m.session_id IN ${idList(sessionIds)}
    ) ranked
    WHERE rank <= ${MAX_PROMPTS_PER_NOTE}
    ORDER BY session_id, rank
  `);

  const map = new Map<string, BoundedTexts>();
  for (const row of result.rows) {
    const existing = map.get(row.session_id);
    if (existing === undefined) {
      map.set(row.session_id, { texts: [row.content], total: Number(row.total) });
      continue;
    }
    existing.texts.push(row.content);
  }
  return map;
}

async function readOutcomes(
  db: DbLike,
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  const result = await db.execute<{ session_id: string; content: string }>(sql`
    SELECT session_id, content FROM (
      SELECT m.session_id,
             left(m.content, ${MAX_OUTCOME_CHARACTERS}) AS content,
             row_number() OVER (PARTITION BY m.session_id ORDER BY m.ordinal DESC) AS rank
      FROM messages m
      WHERE m.role = 'assistant' AND m.content <> '' AND m.session_id IN ${idList(sessionIds)}
    ) ranked
    WHERE rank = 1
  `);

  return new Map(result.rows.map((row) => [row.session_id, row.content]));
}

async function readFiles(
  db: DbLike,
  sessionIds: readonly string[],
): Promise<Map<string, { paths: string[]; total: number }>> {
  const result = await db.execute<{
    session_id: string;
    tool_file_path: string;
    rank: string | number;
    total: string | number;
  }>(sql`
    SELECT session_id, tool_file_path, rank, total FROM (
      SELECT session_id,
             tool_file_path,
             row_number() OVER (PARTITION BY session_id ORDER BY tool_file_path) AS rank,
             count(*)     OVER (PARTITION BY session_id)                          AS total
      FROM (
        SELECT DISTINCT m.session_id, m.tool_file_path
        FROM messages m
        WHERE m.tool_file_path IS NOT NULL AND m.session_id IN ${idList(sessionIds)}
      ) distinct_paths
    ) ranked
    WHERE rank <= ${MAX_FILES_PER_NOTE}
    ORDER BY session_id, rank
  `);

  const map = new Map<string, { paths: string[]; total: number }>();
  for (const row of result.rows) {
    const existing = map.get(row.session_id);
    if (existing === undefined) {
      map.set(row.session_id, { paths: [row.tool_file_path], total: Number(row.total) });
      continue;
    }
    existing.paths.push(row.tool_file_path);
  }
  return map;
}

/** `IN (…)` with every id bound as a parameter — no interpolation reaches the SQL text. */
function idList(sessionIds: readonly string[]) {
  return sql`(${sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}
