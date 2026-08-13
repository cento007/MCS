import { renderNote, sanitizeNoteName, shortId } from '@mc/shared';
import type { SessionFilesReadModel } from '../files.js';
import type { CommitRead, MessageRead } from './evidence.js';
import { EXPORT_MAX_FILES, EXPORT_MAX_MESSAGE_CHARS, EXPORT_MAX_MESSAGES } from './evidence.js';
import {
  blockquote,
  closeOpenFences,
  code,
  countControlCharacters,
  fact,
  facts,
  sanitizeText,
} from './text.js';

/**
 * `POST /api/v1/sessions/{id}/export` (TDS 04 §6.7) — the whole Session as one Markdown
 * document.
 *
 * ## Markdown, and only Markdown
 *
 * §6.7 offers `format: 'markdown' | 'json'`. **Only `markdown` is implemented**, and that is a
 * decision rather than an unfinished half.
 *
 * A JSON export would be a *third* machine-readable shape for a record that already has two:
 * `GET /sessions/{id}` and `GET /sessions/{id}/messages` serve the canonical, cursor-paginated
 * JSON and are the documented way to read a Session programmatically. Nothing in V1 imports a
 * Session — there is no `POST /sessions/import`, no plan for one, and no migration story a JSON
 * blob would serve — so the format would exist to be produced and never consumed, while
 * guaranteeing that a field added to the resource in `serialize.ts` and forgotten here makes two
 * JSON documents that disagree about the same Session.
 *
 * Markdown does the thing the format is *for*: survive outside Mission Control. It is what the
 * Obsidian integration already writes (`packages/shared/src/obsidian/render.ts`), what a diff
 * reads, what a person reads, and what pastes cleanly into another session. So `format` stays in
 * the request — dropping the field would break a caller that sends it — with `markdown` as its
 * only accepted value, which fails loudly rather than accepting `json` and returning Markdown.
 * Recorded as a contract narrowing, not done quietly.
 *
 * ## What is in it
 *
 * The Session's facts, the operator's notes, **every** conversation turn in `ordinal` order, the
 * files it touched, and the commits attributed to it.
 *
 * ## What is deliberately not in it
 *
 * **Tool inputs and outputs.** A tool call is exported as its name and the file it named; the
 * payload is not. Those are the two unbounded columns in the whole schema — a `Write` input is a
 * whole file, a `Read` result is that file coming back, an image arrives base64-inlined — and an
 * export with them inlined is one nobody can read and that no editor will open. It is also the
 * only place a credential typed into a shell command could be copied into a document designed to
 * leave the machine. The document states the exclusion, in the document, with counts.
 *
 * **Anything not recorded.** No summary, no "what happened", no next steps. Every line here is
 * copied from a row.
 */

/** The only `format` this endpoint accepts. See the module header. */
export const EXPORT_FORMATS = ['markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportSessionFacts {
  readonly id: string;
  readonly title: string | null;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly repositoryName: string | null;
  readonly state: string;
  readonly sessionType: string;
  readonly runtime: string;
  readonly runtimeSessionId: string | null;
  readonly runtimeVersion: string | null;
  readonly model: string | null;
  readonly machine: string | null;
  readonly environment: string | null;
  readonly branch: string | null;
  readonly workingDir: string | null;
  readonly notes: string | null;
  readonly failureReason: string | null;
  readonly totalCostUsd: string | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly resumedFromSessionId: string | null;
  readonly lineageKind: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface SessionExportInput {
  readonly session: ExportSessionFacts;
  readonly transcript: MessageRead;
  readonly files: SessionFilesReadModel;
  readonly commits: CommitRead;
  readonly generatedAt: Date;
}

export interface SessionExportDocument {
  readonly format: ExportFormat;
  readonly filename: string;
  readonly content: string;
}

/** Rendered where a section has nothing to show — an empty `##` heading reads like a bug. */
const NOTHING_RECORDED = '_Nothing recorded._';

export function renderSessionExport(input: SessionExportInput): SessionExportDocument {
  const { session } = input;
  const title = displayTitle(session);
  const transcript = renderTranscript(input.transcript);

  const content = renderNote({
    /**
     * **Not `mcId` / `mcType`.** Those two keys are how the Obsidian sync engine claims a note as
     * one it owns (`noteIdentity` in `packages/shared/src/obsidian/note.ts`): an export dropped
     * into the vault's `Sessions/` folder carrying them would be adopted as the managed
     * projection of that Session and overwritten by the next sync run. `mcSessionId` and
     * `mcDocument` say the same thing to a human and nothing at all to the engine, so an export
     * filed in a vault stays the operator's file.
     */
    frontMatter: [
      ['mcSessionId', session.id],
      ['mcDocument', 'session-export'],
      ['project', session.projectName],
      ['repository', session.repositoryName],
      ['state', session.state],
      ['sessionType', session.sessionType],
      ['runtime', session.runtime],
      ['model', session.model],
      ['branch', session.branch],
      ['started', session.startedAt?.toISOString() ?? null],
      ['completed', session.completedAt?.toISOString() ?? null],
      ['exportedAt', input.generatedAt.toISOString()],
      ['tags', 'mission-control/session-export'],
    ],
    title,
    sections: [
      { heading: 'Session', body: renderFacts(session) },
      { heading: 'Notes', body: renderNotes(session) },
      { heading: 'Transcript', body: transcript.body },
      { heading: 'Files touched', body: renderFiles(input.files) },
      { heading: 'Commits', body: renderCommits(input.commits) },
      { heading: 'What this export leaves out', body: renderOmissions(input, transcript) },
    ],
  });

  return { format: 'markdown', filename: exportFilename(session), content };
}

/**
 * `session-2026-08-13-0199a3f1-Fix-the-login-redirect.md`.
 *
 * Deterministic in the Session: exporting the same Session twice produces the same name, so a
 * re-export overwrites its predecessor instead of accumulating `(1)` copies in a Downloads
 * folder. The date is the session's start in UTC, matching `sessionNotePath` — a file name that
 * depends on the reader's timezone changes when the operator travels.
 */
export function exportFilename(session: ExportSessionFacts): string {
  const day = (session.startedAt ?? session.createdAt).toISOString().slice(0, 10);
  const label = displayTitle(session);
  const base = sanitizeNoteName(`session ${day} ${shortId(session.id)} ${label}`);
  return `${base.replace(/ /g, '-')}.md`;
}

function displayTitle(session: ExportSessionFacts): string {
  const title = session.title?.trim() ?? '';
  return title.length === 0 ? `Session ${shortId(session.id)}` : title;
}

function renderFacts(session: ExportSessionFacts): string {
  return facts([
    fact('Session id', code(session.id)),
    fact('State', session.state),
    fact('Failure reason', session.failureReason),
    fact('Type', `${session.sessionType} (${session.runtime})`),
    fact('Project', session.projectName),
    fact('Repository', session.repositoryName),
    fact('Branch', session.branch),
    fact('Working directory', session.workingDir === null ? null : code(session.workingDir)),
    fact('Model', session.model),
    fact('Runtime version', session.runtimeVersion),
    fact(
      'Runtime session id',
      session.runtimeSessionId === null ? null : code(session.runtimeSessionId),
    ),
    fact('Machine', session.machine),
    fact('Environment', session.environment),
    fact('Created', session.createdAt.toISOString()),
    fact('Started', session.startedAt?.toISOString() ?? null),
    fact('Completed', session.completedAt?.toISOString() ?? null),
    fact('Archived', session.archivedAt?.toISOString() ?? null),
    fact('Duration', session.durationMs === null ? null : formatDuration(session.durationMs)),
    fact('Turns', session.numTurns === null ? null : String(session.numTurns)),
    fact('Cost', session.totalCostUsd === null ? null : `$${session.totalCostUsd}`),
    fact(
      session.lineageKind === 'cloned' ? 'Cloned from session' : 'Resumed from session',
      session.resumedFromSessionId === null ? null : code(session.resumedFromSessionId),
    ),
  ]);
}

function renderNotes(session: ExportSessionFacts): string {
  const notes = session.notes?.trim() ?? '';
  if (notes.length === 0) return NOTHING_RECORDED;
  // Quoted, not inlined: operator notes are free text and routinely contain pasted Markdown.
  return blockquote(sanitizeText(notes));
}

interface TranscriptRender {
  readonly body: string;
  readonly toolCalls: number;
  readonly toolResultsOmitted: number;
  readonly truncatedMessages: number;
  readonly fencesRepaired: number;
  readonly controlCharactersEscaped: number;
}

/**
 * Every recorded turn, in `ordinal` order.
 *
 * The three roles render differently because they *are* different, and flattening them would
 * lose the distinction that makes a transcript readable:
 *
 *   - **user** — block-quoted. Short, the highest-value text in the file, and the most likely to
 *     contain Markdown someone pasted; quoting contains all of it (see `text.ts`).
 *   - **assistant / system** — verbatim Markdown, because it *is* Markdown and rendering it as
 *     anything else destroys the code blocks that are usually the point. Control characters are
 *     escaped and an unterminated fence is closed, both announced.
 *   - **tool** — one line. Name and file for a call; for a result, nothing but the fact that it
 *     failed, if it did. See the module header for why the payload is not here.
 */
function renderTranscript(read: MessageRead): TranscriptRender {
  if (read.messages.length === 0) {
    return {
      body: '_This session recorded no messages._',
      toolCalls: 0,
      toolResultsOmitted: 0,
      truncatedMessages: 0,
      fencesRepaired: 0,
      controlCharactersEscaped: 0,
    };
  }

  const blocks: string[] = [];
  let toolCalls = 0;
  let toolResultsOmitted = 0;
  let truncatedMessages = 0;
  let fencesRepaired = 0;
  let controlCharactersEscaped = 0;

  for (const message of read.messages) {
    if (message.truncated) truncatedMessages += 1;
    controlCharactersEscaped += countControlCharacters(message.content);

    if (message.role === 'tool') {
      if (message.toolName !== null) {
        toolCalls += 1;
        blocks.push(toolCallLine(message.toolName, message.toolFilePath, message.occurredAt));
        continue;
      }
      if (message.toolFailed === true) {
        blocks.push('- ↳ **the tool reported an error** — its output is not exported');
        continue;
      }
      toolResultsOmitted += 1;
      continue;
    }

    const heading = `### ${String(message.ordinal)} · ${roleLabel(message.role)}${
      message.model === null ? '' : ` · ${message.model}`
    } · ${message.occurredAt.toISOString()}${message.status === 'complete' ? '' : ` · _${message.status}_`}`;

    const sanitized = sanitizeText(message.content);
    if (sanitized.trim().length === 0) {
      blocks.push(`${heading}\n\n_Empty message._`);
      continue;
    }

    if (message.role === 'user') {
      blocks.push(`${heading}\n\n${blockquote(sanitized)}${truncationNote(message.truncated)}`);
      continue;
    }

    const repair = closeOpenFences(sanitized);
    if (repair.repaired) fencesRepaired += 1;
    blocks.push(
      `${heading}\n\n${repair.text}${
        repair.repaired ? '\n\n_[export closed a code fence this message left open]_' : ''
      }${truncationNote(message.truncated)}`,
    );
  }

  if (read.total > read.messages.length) {
    blocks.push(
      `_${String(read.total - read.messages.length)} later message(s) are not in this export: ` +
        `it copies the first ${String(EXPORT_MAX_MESSAGES)} of ${String(read.total)}. ` +
        'The full transcript is in Mission Control._',
    );
  }

  return {
    body: blocks.join('\n\n'),
    toolCalls,
    toolResultsOmitted,
    truncatedMessages,
    fencesRepaired,
    controlCharactersEscaped,
  };
}

function truncationNote(truncated: boolean): string {
  return truncated ? `\n\n_[truncated at ${String(EXPORT_MAX_MESSAGE_CHARS)} characters]_` : '';
}

function toolCallLine(name: string, filePath: string | null, at: Date): string {
  const target = filePath === null ? '' : ` → ${code(filePath)}`;
  return `- **Tool** ${code(name)}${target} · ${at.toISOString()}`;
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return 'Operator';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    default:
      return role;
  }
}

function renderFiles(files: SessionFilesReadModel): string {
  if (files.files.length === 0) return NOTHING_RECORDED;

  const shown = files.files.slice(0, EXPORT_MAX_FILES);
  const lines = shown.map((file) => {
    const churn =
      file.additions === null && file.deletions === null
        ? ''
        : ` · +${String(file.additions ?? 0)} −${String(file.deletions ?? 0)}`;
    const where = file.outsideRoot ? ' _(outside the repository root)_' : '';
    return `- ${code(file.path)} — ${String(file.touchCount)} touch(es) [${file.sources.join(', ')}]${churn}${where}`;
  });

  if (files.totalFiles > shown.length) {
    lines.push(`- _…and ${String(files.totalFiles - shown.length)} more._`);
  }
  if (files.completeness === 'partial') {
    // Reported, never implied (§6.10.2). An observed Session whose fidelity dropped cannot
    // prove it saw every tool call, and the export must not claim otherwise.
    lines.push(
      '',
      `_This list is **partial** (${files.completenessReason ?? 'unknown reason'}): the ` +
        'observation channel for this Session was degraded, so tool touches may be missing.',
    );
  }

  return lines.join('\n');
}

function renderCommits(read: CommitRead): string {
  if (read.commits.length === 0) return NOTHING_RECORDED;

  const lines = read.commits.map(
    (commit) =>
      `- ${code(commit.sha.slice(0, 10))} ${commit.subject} — ${commit.authorName}, ` +
      `${commit.committedAt.toISOString()} (${String(commit.filesChanged)} file(s), ` +
      `+${String(commit.additions)} −${String(commit.deletions)})`,
  );

  if (read.total > read.commits.length) {
    lines.push(`- _…and ${String(read.total - read.commits.length)} more._`);
  }
  return lines.join('\n');
}

/**
 * The exclusions, named in the document with counts.
 *
 * This section is the difference between an export that is honestly partial and one that looks
 * complete. A reader who needs a tool payload has to know it was left out and where to go.
 */
function renderOmissions(input: SessionExportInput, transcript: TranscriptRender): string {
  const toolActivity = transcript.toolCalls + transcript.toolResultsOmitted > 0;

  const lines: string[] = [
    '- **Tool inputs and outputs.** ' +
      (toolActivity
        ? `${String(transcript.toolCalls)} tool call(s) are listed by name and file only, and ` +
          `${String(transcript.toolResultsOmitted)} tool result(s) are not shown at all. `
        : 'This session recorded no tool activity, so nothing was withheld here. ') +
      'Tool payloads are unbounded (a file write carries the whole file) and frequently ' +
      'binary; they stay in Mission Control.',
    '- **Anything not recorded.** There is no summary, no interpretation and no list of next ' +
      'steps in this document. Every line above is copied from a stored row.',
  ];

  if (transcript.truncatedMessages > 0) {
    lines.push(
      `- **${String(transcript.truncatedMessages)} message body/bodies** exceeded ` +
        `${String(EXPORT_MAX_MESSAGE_CHARS)} characters and were cut at that point; each is ` +
        'marked where it happened.',
    );
  }
  if (input.transcript.total > input.transcript.messages.length) {
    lines.push(
      `- **${String(input.transcript.total - input.transcript.messages.length)} message(s)** ` +
        `beyond the ${String(EXPORT_MAX_MESSAGES)}-message export cap.`,
    );
  }
  if (transcript.fencesRepaired > 0) {
    lines.push(
      `- **${String(transcript.fencesRepaired)} unterminated code fence(s)** were closed by the ` +
        'exporter so the rest of the document stayed readable. Each is marked.',
    );
  }
  if (transcript.controlCharactersEscaped > 0) {
    lines.push(
      `- **${String(transcript.controlCharactersEscaped)} control character(s)** were escaped as ` +
        '`<U+XXXX>` — usually ANSI colour codes from a terminal capture.',
    );
  }

  return lines.join('\n');
}

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
