import { type Db, schema } from '@mc/shared';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { listCommits } from '../../commits/store.js';
import { buildSessionFiles, type SessionFilesReadModel } from '../files.js';
import type { SessionRow } from '../repository.js';
import { serializeObservation } from '../serialize.js';

/**
 * The reads behind `POST /sessions/{id}/export` and `POST /sessions/{id}/context-package`
 * (TDS 04 §6.7) — every one of them bounded, and every bound reported.
 *
 * ## Why the reads live apart from the rendering
 *
 * `render.ts` and `package.ts` are pure functions from these structures to a string, so the
 * unit tier can exercise the interesting half — an unbalanced fence, a session with no
 * messages, a memory layer that is not configured — with no database and no network at all
 * (TDS 07 §2.1). Everything that needs PostgreSQL is here, and it is integration-tested.
 *
 * ## What is deliberately never selected
 *
 * **`messages.tool_payload` and `messages.content_blocks`.** They are the two columns that hold
 * unbounded runtime data: a `Write` tool's input is the whole file, a `Read` tool's result is
 * the whole file back, a screenshot arrives base64-inlined, and a `Bash` invocation carries
 * whatever the operator's environment put on the command line. Selecting them would make the
 * *size* of these documents a property of what the session happened to run, and would make the
 * two of them the only place in this product where a credential pasted into a shell command
 * gets copied into a document designed to be moved somewhere else.
 *
 * The one thing read out of `tool_payload` is `isError`, projected to a boolean in SQL. "The
 * tool failed" is part of the narrative and is one bit; it cannot carry a payload.
 *
 * Nothing here reads `settings` or `secret_items`. There is no code path from a stored secret
 * to either document.
 */

/** Messages copied into an Export. Beyond this the document says how many it left out. */
export const EXPORT_MAX_MESSAGES = 2_000;

/** Per-message body cap, applied by `left()` in PostgreSQL so the bytes never cross the wire. */
export const EXPORT_MAX_MESSAGE_CHARS = 20_000;

/** Commits listed in either document. A session that made more has a different problem. */
export const EXPORT_MAX_COMMITS = 200;

/** Files listed. `buildSessionFiles` already caps its own read; this caps what is rendered. */
export const EXPORT_MAX_FILES = 200;

/** Operator prompts a context package copies — see `package.ts` for why it is a split window. */
export const PACKAGE_MAX_PROMPTS = 12;
export const PACKAGE_PROMPT_HEAD = 3;
export const PACKAGE_MAX_PROMPT_CHARS = 4_000;

/** The final assistant message, in a context package. Longer than a prompt, still bounded. */
export const PACKAGE_MAX_OUTCOME_CHARS = 8_000;

/** ADRs whose `source_session_id` is this Session. One is the norm; the cap is a guard. */
export const PACKAGE_MAX_ADRS = 20;

export interface ExportMessage {
  readonly ordinal: number;
  readonly role: string;
  readonly status: string;
  readonly content: string;
  /** True when `left()` cut the body — the document says so rather than trailing off. */
  readonly truncated: boolean;
  readonly model: string | null;
  readonly toolName: string | null;
  readonly toolFilePath: string | null;
  /** `true`/`false` from `tool_payload->>'isError'`; `null` when the row is not a tool result. */
  readonly toolFailed: boolean | null;
  readonly occurredAt: Date;
}

export interface ExportCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly committedAt: Date;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface ExportAdr {
  readonly adrNumber: number;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: Date;
}

export interface SessionContext {
  readonly session: SessionRow;
  readonly projectName: string | null;
  readonly repositoryName: string | null;
  readonly repositoryLocalPath: string | null;
}

/** The Session row plus the two names neither document can render without. */
export async function readSessionContext(db: Db, id: string): Promise<SessionContext | null> {
  const rows = await db
    .select({
      session: schema.sessions,
      projectName: schema.projects.name,
      repositoryName: schema.repositories.name,
      repositoryLocalPath: schema.repositories.localPath,
    })
    .from(schema.sessions)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .leftJoin(schema.repositories, eq(schema.repositories.id, schema.sessions.repositoryId))
    .where(eq(schema.sessions.id, id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return {
    session: row.session,
    projectName: row.projectName,
    repositoryName: row.repositoryName,
    repositoryLocalPath: row.repositoryLocalPath,
  };
}

export interface MessageRead {
  readonly messages: readonly ExportMessage[];
  readonly total: number;
}

/**
 * The transcript, in `ordinal` order — the only conversation order (§6.6) — capped at
 * `EXPORT_MAX_MESSAGES` with the true total alongside it.
 *
 * The cap is taken from the **start**, not the end: an export is read forwards, and a document
 * that began at message 3 001 with no explanation would be unreadable. The count of what was
 * dropped goes into the document.
 */
export async function readTranscript(db: Db, sessionId: string): Promise<MessageRead> {
  const [rows, total] = await Promise.all([
    db
      .select({
        ordinal: schema.messages.ordinal,
        role: schema.messages.role,
        status: schema.messages.status,
        content: sql<string>`left(${schema.messages.content}, ${EXPORT_MAX_MESSAGE_CHARS})`,
        // Compared in SQL so the untruncated body never leaves PostgreSQL just to be measured.
        truncated: sql<boolean>`length(${schema.messages.content}) > ${EXPORT_MAX_MESSAGE_CHARS}`,
        model: schema.messages.model,
        toolName: schema.messages.toolName,
        toolFilePath: schema.messages.toolFilePath,
        // A boolean projection of one key. See the module header: the payload itself is never
        // selected, here or anywhere else in this module.
        toolFailed: sql<
          boolean | null
        >`(${schema.messages.toolPayload} -> 'isError')::text::boolean`,
        occurredAt: schema.messages.occurredAt,
      })
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId))
      .orderBy(asc(schema.messages.ordinal))
      .limit(EXPORT_MAX_MESSAGES),
    countRows(db, schema.messages, eq(schema.messages.sessionId, sessionId)),
  ]);

  return {
    messages: rows.map((row) => ({
      ordinal: Number(row.ordinal),
      role: row.role,
      status: row.status,
      content: row.content,
      truncated: row.truncated === true,
      model: row.model,
      toolName: row.toolName,
      toolFilePath: row.toolFilePath,
      toolFailed: row.toolFailed === null ? null : row.toolFailed,
      occurredAt: asDate(row.occurredAt),
    })),
    total,
  };
}

export interface PromptRead {
  /** The window described in `package.ts` — first few plus most recent, never a blind head. */
  readonly head: readonly string[];
  readonly tail: readonly string[];
  readonly omitted: number;
  readonly total: number;
}

/**
 * Operator prompts for a context package.
 *
 * Two queries rather than one because the window is `first N` ∪ `last M`: the original intent
 * and the current thread are the two things a person resuming abandoned work needs, and a plain
 * "first 12" stops describing a long session a third of the way in.
 */
export async function readPrompts(db: Db, sessionId: string): Promise<PromptRead> {
  const where = and(eq(schema.messages.sessionId, sessionId), eq(schema.messages.role, 'user'));
  const tailSize = PACKAGE_MAX_PROMPTS - PACKAGE_PROMPT_HEAD;

  const [head, tail, total] = await Promise.all([
    db
      .select({ content: boundedContent(PACKAGE_MAX_PROMPT_CHARS) })
      .from(schema.messages)
      .where(where)
      .orderBy(asc(schema.messages.ordinal))
      .limit(PACKAGE_PROMPT_HEAD),
    db
      .select({ content: boundedContent(PACKAGE_MAX_PROMPT_CHARS) })
      .from(schema.messages)
      .where(where)
      .orderBy(desc(schema.messages.ordinal))
      .limit(tailSize),
    countRows(db, schema.messages, where),
  ]);

  // Under the cap the two windows overlap; the tail alone is then the whole list in order.
  if (total <= PACKAGE_MAX_PROMPTS) {
    return {
      head: [],
      tail: tail
        .map((row) => row.content)
        .reverse()
        .slice(-total),
      omitted: 0,
      total,
    };
  }

  return {
    head: head.map((row) => row.content),
    tail: tail.map((row) => row.content).reverse(),
    omitted: total - PACKAGE_PROMPT_HEAD - tailSize,
    total,
  };
}

/**
 * The last assistant message with any text in it.
 *
 * Labelled in both documents as exactly that — "the last thing the assistant said" — and never
 * as a summary or a conclusion. The ADR generator settled this question already
 * (`apps/sync-worker/src/adr-draft.ts`): the final message is evidence, and calling evidence a
 * summary is the first step towards inventing one.
 */
export async function readFinalAssistantMessage(
  db: Db,
  sessionId: string,
): Promise<{ content: string; occurredAt: Date } | null> {
  const rows = await db
    .select({
      content: boundedContent(PACKAGE_MAX_OUTCOME_CHARS),
      occurredAt: schema.messages.occurredAt,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        eq(schema.messages.role, 'assistant'),
        ne(schema.messages.content, ''),
      ),
    )
    .orderBy(desc(schema.messages.ordinal))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : { content: row.content, occurredAt: asDate(row.occurredAt) };
}

export interface CommitRead {
  readonly commits: readonly ExportCommit[];
  readonly total: number;
}

/** Commits attributed to this Session (§6.10.1), newest first, capped. */
export async function readCommits(db: Db, sessionId: string): Promise<CommitRead> {
  const [rows, total] = await Promise.all([
    listCommits(db, { sessionId, limit: EXPORT_MAX_COMMITS, order: 'desc' }),
    countRows(db, schema.commits, eq(schema.commits.sessionId, sessionId)),
  ]);

  return {
    commits: rows.map((row) => {
      const files = Array.isArray(row.files) ? row.files : [];
      return {
        sha: row.sha,
        subject: row.message.split('\n', 1)[0] ?? '',
        authorName: row.authorName,
        committedAt: asDate(row.committedAt),
        filesChanged: files.length,
        additions: sumField(files, 'additions'),
        deletions: sumField(files, 'deletions'),
      };
    }),
    total,
  };
}

/**
 * ADRs generated from this Session.
 *
 * **Titles and numbers only — never the bodies.** An ADR is a live document that the operator
 * edits after it is drafted and that Obsidian syncs both ways; pasting a copy of it into a
 * context package produces a second version with no way to tell which is current. A pointer
 * ("ADR-0007 exists, it is `accepted`, go and read it") is the honest inclusion.
 */
export async function readAdrs(db: Db, sessionId: string): Promise<readonly ExportAdr[]> {
  const rows = await db
    .select({
      adrNumber: schema.adrs.adrNumber,
      title: schema.adrs.title,
      status: schema.adrs.status,
      updatedAt: schema.adrs.updatedAt,
    })
    .from(schema.adrs)
    .where(eq(schema.adrs.sourceSessionId, sessionId))
    .orderBy(asc(schema.adrs.adrNumber))
    .limit(PACKAGE_MAX_ADRS);

  return rows.map((row) => ({
    adrNumber: row.adrNumber,
    title: row.title,
    status: row.status,
    updatedAt: asDate(row.updatedAt),
  }));
}

/**
 * The §6.10.2 read model, reused verbatim.
 *
 * It already reconciles the two path dialects (git's repository-relative POSIX paths against the
 * runtime's absolute native ones), already ranks by attention, and already reports its own
 * completeness for a degraded observed Session. A second implementation would be a second
 * chance to disagree with the Files tab about what a session touched.
 */
export async function readFiles(db: Db, session: SessionRow): Promise<SessionFilesReadModel> {
  const observation =
    session.sessionType === 'observed'
      ? serializeObservation(session, await findTailState(db, session.id))
      : null;
  return buildSessionFiles(db, session, observation);
}

async function findTailState(db: Db, sessionId: string) {
  const rows = await db
    .select()
    .from(schema.transcriptTailStates)
    .where(eq(schema.transcriptTailStates.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/** Distinct tool names used, with counts — the compact form the file list cannot express. */
export async function readToolUsage(
  db: Db,
  sessionId: string,
): Promise<readonly { name: string; count: number }[]> {
  const rows = await db
    .select({ name: schema.messages.toolName, count: sql<number>`count(*)::int` })
    .from(schema.messages)
    .where(and(eq(schema.messages.sessionId, sessionId), isNotNull(schema.messages.toolName)))
    .groupBy(schema.messages.toolName)
    .orderBy(desc(sql`count(*)`));

  return rows.flatMap((row) =>
    row.name === null ? [] : [{ name: row.name, count: Number(row.count) }],
  );
}

function boundedContent(limit: number) {
  return sql<string>`left(${schema.messages.content}, ${limit})`;
}

async function countRows(
  db: Db,
  table: typeof schema.messages | typeof schema.commits,
  where: ReturnType<typeof and>,
): Promise<number> {
  const rows = await db.select({ total: sql<string>`count(*)` }).from(table).where(where);
  return Number(rows[0]?.total ?? 0);
}

function sumField(files: readonly unknown[], key: 'additions' | 'deletions'): number {
  let total = 0;
  for (const file of files) {
    if (typeof file !== 'object' || file === null) continue;
    const value = (file as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
