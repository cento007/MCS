import { adrNumberLabel, renderNote, shortId } from '@mc/shared';
import type { SessionFilesReadModel } from '../files.js';
import type { CommitRead, ExportAdr, PromptRead } from './evidence.js';
import { EXPORT_MAX_FILES, PACKAGE_MAX_PROMPTS } from './evidence.js';
import type { ExportSessionFacts } from './render.js';
import { blockquote, closeOpenFences, code, fact, facts, sanitizeText } from './text.js';

/**
 * `POST /api/v1/sessions/{id}/context-package` (TDS 04 §6.7) — everything needed to pick up
 * work a previous Session left, without reading its transcript.
 *
 * ## The design constraint that shaped every inclusion
 *
 * **A package that is the transcript plus more is worse than the transcript.** It costs more to
 * read and it buries the signal in the same volume of narration that made the transcript
 * unusable. So the test each section had to pass was not "is this true" — nearly everything in
 * the database is true — but *"would someone resuming abandoned work be worse off without it?"*
 *
 * Nine sections passed. Here is the case for each, and the case against what is missing.
 *
 *  1. **Where this left off** — state, failure reason, project, repository, branch, working
 *     directory, cost/turns/duration. You cannot resume work without knowing which checkout to
 *     open and whether the session ended or crashed. One row, a dozen lines.
 *
 *  2. **What was asked** — the operator's prompts, verbatim. This is the *intent*, and it is the
 *     highest signal-to-byte ratio in the entire record: a few hundred characters that state the
 *     goal, against megabytes of assistant narration restating work that the diff already shows.
 *     Copied verbatim rather than condensed, because a condensed prompt is a paraphrase of what
 *     the operator meant, which is precisely the invention this document refuses.
 *     **The window is first-few plus most-recent** (`readPrompts`), never a blind head: the
 *     original goal and the current thread are two different things and a long session needs
 *     both. What falls between them is counted, not silently dropped.
 *
 *  3. **Where it stopped** — the final assistant message, verbatim, labelled as *the last thing
 *     said* and never as a summary. It is the closest recorded thing to "here is what I was
 *     about to do", and it is one message rather than a thousand.
 *
 *  4. **Working tree, as of now** — branch, HEAD, uncommitted count, ahead/behind. This is the
 *     only fact in the package that is not in the transcript **at all**, and it is the one that
 *     decides whether resuming is safe: forty uncommitted files means the previous session left
 *     work in the tree, and nothing in a transcript can tell you that. Derived at read time and
 *     stamped with the moment it was read, because it is stale immediately.
 *
 *  5. **Files this session touched** — the §6.10.2 read model, ranked by attention. The concrete
 *     work product, and the shortest possible answer to "what part of the codebase is this
 *     about". Carries its own completeness flag, so a degraded observed Session says so.
 *
 *  6. **Commits** — what was actually saved. Together with (4) this separates "the work is
 *     committed" from "the work is loose in the tree", which are different resumption problems.
 *
 *  7. **Decisions already recorded** — ADRs generated from this Session, by number, title and
 *     status. Resuming without knowing a decision was recorded means re-deciding it. Titles
 *     only: an ADR is a live, two-way-synced document, and a copy pasted here would be a second
 *     version with no way to tell which is current.
 *
 *  8. **Related context from other work** — semantic memory across *other* sessions, ADRs,
 *     commits and vault notes. Nothing else in this product can answer "has this problem been
 *     touched before, somewhere I would not think to look". This session's own chunks are
 *     dropped: they are the transcript, and the transcript is what this document exists to avoid
 *     re-reading.
 *
 *  9. **What this package does not contain** — the omissions, named.
 *
 * ## What was rejected, and why
 *
 *  - **The transcript.** The entire point.
 *  - **Assistant narration other than the last message.** It restates what the file list and the
 *    commits already show, at ten to a hundred times the byte cost.
 *  - **Tool payloads.** Unbounded, frequently binary, and the file list already carries the fact
 *    that the tool ran (`evidence.ts`).
 *  - **The session timeline.** A list of `session.state_changed` rows says when the state moved;
 *    `state` and the timestamps in section 1 already say where it ended up, and the transitions
 *    in between tell you nothing about the *work*.
 *  - **A summary of what happened.** That needs a model. There is no model in this request path
 *    (F1.5 puts the Agent SDK behind `AgentRuntimePort`, per managed session, not in a read
 *    endpoint), and a summary assembled by string-joining would be a plausible fabrication.
 *    `apps/sync-worker/src/adr-draft.ts` settled this: an invented "Alternatives considered" is
 *    worse than an empty one, because only the empty one is true.
 *  - **Next steps / TODOs.** Not recoverable from a record. Same rule.
 */

export type RelatedGapReason =
  /** No embedding model is configured — memory has never been switched on. */
  | 'not_configured'
  /** Ollama or Qdrant could not be reached, or failed mid-query. */
  | 'unavailable'
  /** The collection was built by a different embedding model; its vectors are not comparable. */
  | 'stamp_mismatch'
  /** Memory is configured and reachable, but nothing is indexed for this scope yet. */
  | 'index_empty'
  /** Chunks were considered and none cleared the relevance floor. */
  | 'below_threshold'
  /** The retrieval budget expired. The package is generated anyway, saying so. */
  | 'timed_out'
  /** This Session has no title and no prompt, so there is nothing to search *with*. */
  | 'no_query'
  /** Every hit was this Session's own transcript, which the package deliberately excludes. */
  | 'only_own_session';

export interface RelatedItem {
  readonly title: string;
  readonly sourceType: string;
  readonly score: number;
  readonly occurredAt: string | null;
  readonly chunkOrdinal: number;
  readonly chunkCount: number;
  readonly content: string;
}

/**
 * The related-context section's input — **results and gaps in one shape, on purpose**.
 *
 * A package whose related-context section is silently absent because Ollama was off looks
 * complete and is not. `gap` is what makes the difference visible: it is `null` only when memory
 * answered, and every other value renders a named, actionable sentence in the document itself.
 */
export interface RelatedContext {
  /** What was asked of the index, verbatim. An empty answer is uninterpretable without it. */
  readonly query: string | null;
  readonly items: readonly RelatedItem[];
  readonly gap: { readonly reason: RelatedGapReason; readonly detail: string } | null;
  readonly embeddingModel: string | null;
  readonly minScore: number | null;
  /** Hits that were this Session's own chunks and were dropped. Counted, not hidden. */
  readonly ownChunksDropped: number;
}

/** The working tree as of generation, or the reason there is none to report. */
export interface PackageWorkingTree {
  readonly localPath: string;
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  readonly headSha: string | null;
  readonly uncommittedFiles: number | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  /** `null` iff the tree was read. Otherwise git's own reason, never an invented one. */
  readonly unavailableReason: string | null;
  readonly detail: string | null;
  readonly checkedAt: Date;
}

export interface ContextPackageInput {
  readonly session: ExportSessionFacts;
  readonly prompts: PromptRead;
  readonly finalMessage: { readonly content: string; readonly occurredAt: Date } | null;
  readonly files: SessionFilesReadModel;
  readonly commits: CommitRead;
  readonly adrs: readonly ExportAdr[];
  readonly tools: readonly { readonly name: string; readonly count: number }[];
  /** `null` when the Session names no Repository — there is no tree, and the document says so. */
  readonly workingTree: PackageWorkingTree | null;
  readonly related: RelatedContext;
  readonly generatedAt: Date;
}

/** Excerpt of one memory chunk. Long enough to judge relevance, short enough not to be a copy. */
export const RELATED_EXCERPT_CHARS = 600;

export function renderContextPackage(input: ContextPackageInput): string {
  const { session } = input;
  const title = session.title?.trim() ?? '';
  const label = title.length === 0 ? `Session ${shortId(session.id)}` : title;

  return renderNote({
    // `mcSessionId` / `mcDocument` rather than `mcId` / `mcType`, for the reason `render.ts`
    // gives: those two keys are how the vault sync engine claims ownership of a note.
    frontMatter: [
      ['mcSessionId', session.id],
      ['mcDocument', 'context-package'],
      ['project', session.projectName],
      ['repository', session.repositoryName],
      ['state', session.state],
      ['branch', session.branch],
      ['generatedAt', input.generatedAt.toISOString()],
      ['tags', 'mission-control/context-package'],
    ],
    title: `Context package — ${label}`,
    sections: [
      { heading: 'How to read this', body: PREAMBLE },
      { heading: 'Where this left off', body: renderWhere(session) },
      { heading: 'What was asked', body: renderPrompts(input.prompts) },
      { heading: 'Where it stopped', body: renderFinalMessage(input.finalMessage) },
      { heading: 'Working tree, as of now', body: renderWorkingTree(input.workingTree) },
      { heading: 'Files this session touched', body: renderFiles(input.files, input.tools) },
      { heading: 'Commits', body: renderCommits(input.commits) },
      { heading: 'Decisions already recorded', body: renderAdrs(input.adrs) },
      { heading: 'Related context from other work', body: renderRelated(input.related) },
      { heading: 'What this package does not contain', body: renderOmissions(input) },
    ],
  });
}

const PREAMBLE = [
  'Assembled from what this Session recorded. **Nothing here is summarised, inferred or',
  'generated** — every line is copied from a stored row, and a section with no source says so',
  'rather than being filled in. Where a source could not be read, the reason is stated in place',
  'of the content.',
].join('\n');

function renderWhere(session: ExportSessionFacts): string {
  const bullets = facts([
    fact('Session', code(session.id)),
    fact('State', session.state),
    fact('Failure reason', session.failureReason),
    fact('Project', session.projectName),
    fact('Repository', session.repositoryName),
    fact('Branch at the time', session.branch),
    fact('Working directory', session.workingDir === null ? null : code(session.workingDir)),
    fact('Model', session.model),
    fact('Started', session.startedAt?.toISOString() ?? null),
    fact(
      'Last activity',
      (session.completedAt ?? session.startedAt ?? session.createdAt).toISOString(),
    ),
    fact('Turns', session.numTurns === null ? null : String(session.numTurns)),
    fact('Cost', session.totalCostUsd === null ? null : `$${session.totalCostUsd}`),
  ]);

  // Operator notes are the one piece of free text an operator wrote *about* the session rather
  // than *to* the runtime, and they are frequently the only place a "why" is recorded. Quoted,
  // because they are free text (see `text.ts`).
  const notes = session.notes?.trim() ?? '';
  if (notes.length === 0) return bullets;
  return `${bullets}\n\n**Operator notes**\n\n${blockquote(sanitizeText(notes))}`;
}

function renderPrompts(prompts: PromptRead): string {
  if (prompts.total === 0) {
    return '_This session recorded no operator prompts._';
  }

  const blocks: string[] = [];
  for (const prompt of prompts.head) blocks.push(blockquote(sanitizeText(prompt)));

  if (prompts.omitted > 0) {
    blocks.push(
      `_${String(prompts.omitted)} prompt(s) between the opening and the most recent are not ` +
        `copied here — this package carries the first ${String(prompts.head.length)} and the ` +
        `last ${String(prompts.tail.length)} of ${String(prompts.total)}._`,
    );
  }

  for (const prompt of prompts.tail) blocks.push(blockquote(sanitizeText(prompt)));
  return blocks.join('\n\n');
}

function renderFinalMessage(
  final: { readonly content: string; readonly occurredAt: Date } | null,
): string {
  if (final === null) {
    return '_This session recorded no assistant message._';
  }

  const repair = closeOpenFences(sanitizeText(final.content.trim()));
  return [
    `_The last thing the assistant said, at ${final.occurredAt.toISOString()}, copied verbatim._`,
    '_It is not a summary of the session and may stop mid-thought._',
    '',
    repair.text,
    ...(repair.repaired ? ['', '_[an unterminated code fence was closed here]_'] : []),
  ].join('\n');
}

/**
 * The working tree, or why it could not be read.
 *
 * Three distinct answers, and conflating them would be the failure this section exists to
 * avoid: "this Session has no Repository" is not "git could not be run", and neither is "the
 * tree is clean".
 */
function renderWorkingTree(tree: PackageWorkingTree | null): string {
  if (tree === null) {
    return (
      '_This Session names no Repository, so there is no working tree to report. Its working ' +
      'directory is listed above._'
    );
  }

  if (tree.unavailableReason !== null) {
    return facts([
      fact('Repository path', code(tree.localPath)),
      fact('Could not be read', tree.unavailableReason),
      fact('git said', tree.detail === null ? null : code(tree.detail)),
      fact('Checked at', tree.checkedAt.toISOString()),
    ]);
  }

  return facts([
    fact('Repository path', code(tree.localPath)),
    fact('Branch', tree.detachedHead ? '_detached HEAD_' : tree.currentBranch),
    fact('HEAD', tree.headSha === null ? '_no commits yet_' : code(tree.headSha)),
    fact(
      'Uncommitted entries',
      tree.uncommittedFiles === null ? null : String(tree.uncommittedFiles),
    ),
    fact('Ahead of upstream', tree.ahead === null ? null : String(tree.ahead)),
    fact('Behind upstream', tree.behind === null ? null : String(tree.behind)),
    fact('Checked at', `${tree.checkedAt.toISOString()} — true at that instant and no longer`),
  ]);
}

function renderFiles(
  files: SessionFilesReadModel,
  tools: readonly { readonly name: string; readonly count: number }[],
): string {
  const lines: string[] = [];

  if (files.files.length === 0) {
    lines.push('_This session touched no files that Mission Control recorded._');
  } else {
    const shown = files.files.slice(0, EXPORT_MAX_FILES);
    for (const file of shown) {
      const churn =
        file.additions === null && file.deletions === null
          ? ''
          : ` · +${String(file.additions ?? 0)} −${String(file.deletions ?? 0)}`;
      const where = file.outsideRoot ? ' _(outside the repository root)_' : '';
      lines.push(
        `- ${code(file.path)} — ${String(file.touchCount)} touch(es) [${file.sources.join(', ')}]${churn}${where}`,
      );
    }
    if (files.totalFiles > shown.length) {
      lines.push(`- _…and ${String(files.totalFiles - shown.length)} more._`);
    }
    if (files.completeness === 'partial') {
      lines.push(
        '',
        `_This list is **partial** (\`${files.completenessReason ?? 'unknown'}\`): the ` +
          'observation channel for this Session was degraded, so tool touches may be missing._',
      );
    }
  }

  if (tools.length > 0) {
    lines.push(
      '',
      `**Tools used:** ${tools.map((tool) => `${code(tool.name)} ×${String(tool.count)}`).join(', ')}`,
    );
  }

  return lines.join('\n');
}

function renderCommits(read: CommitRead): string {
  if (read.commits.length === 0) {
    return '_No commits are attributed to this session._';
  }

  const lines = read.commits.map(
    (commit) =>
      `- ${code(commit.sha.slice(0, 10))} ${commit.subject} — ${commit.committedAt.toISOString()} ` +
      `(${String(commit.filesChanged)} file(s), +${String(commit.additions)} −${String(commit.deletions)})`,
  );
  if (read.total > read.commits.length) {
    lines.push(`- _…and ${String(read.total - read.commits.length)} more._`);
  }
  return lines.join('\n');
}

function renderAdrs(adrs: readonly ExportAdr[]): string {
  if (adrs.length === 0) {
    return '_No ADR has been recorded from this session._';
  }

  return adrs
    .map(
      (adr) =>
        `- **${adrNumberLabel(adr.adrNumber)}** — ${adr.title} (\`${adr.status}\`, updated ` +
        `${adr.updatedAt.toISOString()}). Read it before re-deciding; only the pointer is here.`,
    )
    .join('\n');
}

/**
 * The related-context section, and the honesty requirement it carries.
 *
 * Every degraded state renders a sentence naming the reason and what to do about it. The one
 * thing this section must never do is render nothing and look finished — a package that
 * silently lacks half its intended content is worse than one that names the gap, because the
 * reader has no way to know they are missing anything.
 */
function renderRelated(related: RelatedContext): string {
  const preface: string[] = [];
  if (related.query !== null) {
    preface.push(`_Searched semantic memory for:_ ${code(displayQuery(related.query))}`);
  }

  if (related.gap !== null) {
    preface.push(
      '',
      `> [!warning] This section is incomplete — \`${related.gap.reason}\``,
      `> ${related.gap.detail}`,
      '>',
      `> ${GAP_ADVICE[related.gap.reason]}`,
    );
  }

  if (related.items.length === 0) {
    if (related.gap === null) {
      // Not reachable from the service (an empty result always carries a reason), but a section
      // that could render blank is a section that will one day render blank.
      preface.push('', '_Semantic memory returned nothing for this session._');
    }
    if (related.ownChunksDropped > 0) {
      preface.push(
        '',
        `_${String(related.ownChunksDropped)} match(es) were this session's own transcript and ` +
          'were dropped — this package exists so that transcript does not have to be re-read._',
      );
    }
    return preface.join('\n').trim();
  }

  const items = related.items.map((item) => {
    const excerpt = sanitizeText(item.content).slice(0, RELATED_EXCERPT_CHARS);
    const more = item.content.length > RELATED_EXCERPT_CHARS ? '…' : '';
    const when = item.occurredAt === null ? '' : ` · ${item.occurredAt}`;
    return [
      `#### ${item.title}`,
      `_${item.sourceType} · chunk ${String(item.chunkOrdinal + 1)} of ${String(item.chunkCount)} · ` +
        `score ${item.score.toFixed(3)}${when}_`,
      '',
      blockquote(`${excerpt}${more}`),
    ].join('\n');
  });

  const footer: string[] = [];
  if (related.embeddingModel !== null && related.minScore !== null) {
    footer.push(
      '',
      `_Retrieved with \`${related.embeddingModel}\` at a relevance floor of ` +
        `${related.minScore.toFixed(2)}. Scores are cosine similarity, not confidence._`,
    );
  }
  if (related.ownChunksDropped > 0) {
    footer.push(
      `_${String(related.ownChunksDropped)} further match(es) were this session's own transcript ` +
        'and were dropped._',
    );
  }

  return [...preface, '', ...items, ...footer].join('\n').trim();
}

/**
 * The query, made fit for a one-line inline-code span.
 *
 * The query itself is the Session title joined to the first prompt, so it is routinely
 * multi-line and long. An inline code span cannot contain a newline — CommonMark turns each into
 * a space, but a raw newline inside backticks also lets the surrounding paragraph break in ways
 * that depend on the renderer. Collapsed and elided here, while the *search* still uses the
 * whole thing: this is a label, not the input.
 */
export const QUERY_ECHO_CHARS = 160;

function displayQuery(query: string): string {
  const collapsed = query.replace(/\s+/g, ' ').trim();
  return collapsed.length <= QUERY_ECHO_CHARS
    ? collapsed
    : `${collapsed.slice(0, QUERY_ECHO_CHARS)}…`;
}

/** One actionable sentence per gap. The reason alone tells the reader nothing to *do*. */
const GAP_ADVICE: Readonly<Record<RelatedGapReason, string>> = {
  not_configured:
    'Set it under Settings → Integrations → Memory. Everything else in this package was produced ' +
    'normally; only this section is missing.',
  unavailable:
    'Check Settings → Services, then regenerate this package — nothing else in it depends on ' +
    'Ollama or Qdrant.',
  stamp_mismatch:
    'The stored vectors were produced by a different embedding model, so they are not comparable ' +
    'to this query and were **not** searched. Rebuild the index from Settings → Memory.',
  index_empty: 'Run a memory backfill from Settings → Memory, then regenerate this package.',
  below_threshold:
    'Memory answered, and nothing was close enough to be worth showing. That is a real answer: ' +
    'no comparable prior work was found.',
  timed_out:
    'Semantic retrieval exceeded its budget and was abandoned so this package could still be ' +
    'produced. Retry, or check Settings → Services if it keeps happening.',
  no_query:
    'This Session has neither a title nor a recorded prompt, so there was nothing to search ' +
    'with. Nothing was searched; this is not an empty result.',
  only_own_session:
    'Every match was this session’s own transcript. No other session, ADR, commit or note in the ' +
    'index was close to this work.',
};

function renderOmissions(input: ContextPackageInput): string {
  const lines = [
    '- **The transcript.** This package exists so it does not have to be read. It is in Mission ' +
      'Control, and `POST /api/v1/sessions/{id}/export` produces the full Markdown record.',
    '- **Assistant narration** other than the final message, and **tool inputs and outputs**. ' +
      'Both are large and both restate work the file list and the commits already show.',
    '- **The session timeline.** State transitions say when the Session moved; they say nothing ' +
      'about the work.',
    '- **Any summary, conclusion or list of next steps.** None of those is recorded, and this ' +
      'endpoint does not call a model, so writing one would be invention rather than record.',
  ];

  if (input.prompts.omitted > 0) {
    lines.push(
      `- **${String(input.prompts.omitted)} operator prompt(s)** from the middle of the session, ` +
        `beyond the ${String(PACKAGE_MAX_PROMPTS)}-prompt window.`,
    );
  }
  if (input.adrs.length > 0) {
    lines.push('- **The bodies of the ADRs listed above** — they are live documents; read them.');
  }

  return lines.join('\n');
}
