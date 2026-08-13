/**
 * Projections — what text actually *represents* an entity for retrieval.
 *
 * This is the decision that determines whether "When did we adopt pg-boss?" finds anything, and
 * it is upstream of every clever thing the vector store can do: a perfect index over the wrong
 * text answers nothing. So each of PRD §6.3's sources gets a deliberate answer to one question —
 * *if an operator remembered this entity, what words would they remember it by?*
 *
 * Every function here is **pure**: rows in, text out, no I/O, no clock, no randomness. That is
 * what makes the interesting half of ingestion a unit test, and it is what makes a projection
 * change auditable — the same row must produce the same text, or the content hash changes and
 * the whole source is silently re-embedded.
 *
 * ## The choices, per source
 *
 * | source         | tier      | projected text                                              |
 * |----------------|-----------|-------------------------------------------------------------|
 * | `session`      | `session` | title + user/assistant turns, in order, role-labelled        |
 * | `commit`       | `project` | subject, body, then the changed paths                        |
 * | `adr`          | `project` | the four PRD §7.3 sections under their own headings          |
 * | `pull_request` | `project` | `#42 title` + description                                    |
 * | `obsidian_note`| `global`  | the note body, front matter stripped                         |
 *
 * ### Sessions — turns, not tool traffic
 *
 * A Session's meaning lives in what the operator asked and what the assistant answered. Tool
 * calls and tool results are excluded, and that is the same call `messages.search_tsv` already
 * made for keyword search (TDS 03 §4.6: "tool payloads dominate volume and pollute ranking").
 * Here it matters more: a `Read` tool result is a *file*, so indexing it would fill the store
 * with fragments of source code attributed to a conversation, and "show me authentication
 * discussions" would return the auth module rather than the discussion of it.
 *
 * Turns are labelled `user:` / `assistant:` and separated by blank lines, so the chunker's
 * coarsest boundary lands between turns and a chunk is a run of whole turns.
 *
 * ### Commits — the message *and* the paths
 *
 * A commit message alone loses the thing an operator most often searches by: *where* the change
 * was. "the change to the websocket hub" is a path memory, not a prose memory. So the changed
 * paths are appended as a `Files:` block. Line stats are not — `+42/-13` is noise in a vector,
 * it is already on the row for anyone who fetches it, and it changes on every rebase while the
 * meaning does not.
 *
 * The 40-hex SHA is deliberately **not** projected. It tokenizes to ~35 junk tokens (measured:
 * hex SHAs run at 1.14 chars/token) and no one has ever recalled a commit by its hash in
 * natural language. It is on the row, one lookup away, for anyone who has one.
 *
 * ### ADRs — four sections, four headings
 *
 * Context / Decision / Alternatives / Consequences are separate columns because they are
 * separate thoughts (PRD §7.3), and the projection keeps them separate: each becomes a
 * `## Heading` block, so a long ADR chunks along its own section boundaries instead of
 * mid-argument. The `ADR-0007` label leads, because that is how they are referred to.
 *
 * ### Pull requests — title and description only
 *
 * `#42 Fix the relay gap policy` plus the description. Review comments are not in this database
 * (the GitHub sync stores metadata, not threads), so there is nothing else to project.
 *
 * ### Obsidian notes — the operator's own writing, and only that
 *
 * Notes that carry a Mission Control `mc-id` are *generated* from Sessions, Projects and ADRs
 * that this index already covers; indexing them too would return the same knowledge twice under
 * two source types and crowd out everything else in a top-5. So only **unmanaged** notes are
 * projected — the operator's own writing, which is exactly the knowledge that exists nowhere
 * else in this database. Front matter is stripped: it is metadata, and `tags: [x, y]` embedded
 * into a paragraph shifts the vector without adding meaning.
 */

import type { CommitFile } from '../db/index.js';
import type { MemorySourceType, MemoryTier } from '../entities/memory.js';

/** How many changed paths a commit projection lists before it stops. */
export const MAX_PROJECTED_COMMIT_FILES = 40;

/** How many turns a session projection includes, newest-last. */
export const MAX_PROJECTED_TURNS = 2_000;

/**
 * A source, reduced to the four things ingestion needs: where it belongs, what it is called,
 * and the text that stands for it.
 */
export interface SourceProjection {
  readonly sourceType: MemorySourceType;
  /** A row id, for row-backed sources. Mutually exclusive with `sourceRef`. */
  readonly sourceId: string | null;
  /** A vault-relative path, for file-backed sources. Mutually exclusive with `sourceId`. */
  readonly sourceRef: string | null;
  readonly tier: MemoryTier;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  /**
   * A human label for the source, carried into search results so a hit is nameable without a
   * second query. Never chunked, never embedded — it is display, not signal.
   */
  readonly title: string;
  /** The projected text. Empty means "nothing worth indexing" and the source is skipped. */
  readonly text: string;
  /**
   * When the source last meant something, for ordering and for "when did we…". Sessions use
   * their completion (or creation), commits their commit date, ADRs and PRs their update.
   */
  readonly occurredAt: Date;
}

// ------------------------------------------------------------------------------- sessions

export interface ProjectedTurn {
  readonly role: string;
  readonly content: string;
}

export interface SessionProjectionInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly turns: readonly ProjectedTurn[];
  readonly occurredAt: Date;
}

/** The roles that carry meaning. `tool` and `system` are excluded — see the header. */
export const PROJECTED_MESSAGE_ROLES = ['user', 'assistant'] as const;

export function projectSession(input: SessionProjectionInput): SourceProjection {
  const title = (input.title ?? '').trim();
  const lines: string[] = [];
  if (title.length > 0) lines.push(title);

  for (const turn of input.turns.slice(0, MAX_PROJECTED_TURNS)) {
    const content = turn.content.trim();
    if (content.length === 0) continue;
    lines.push(`${turn.role}: ${content}`);
  }

  return {
    sourceType: 'session',
    sourceId: input.sessionId,
    sourceRef: null,
    // Session tier: a conversation is remembered in the context of the conversation. The
    // Project is carried alongside anyway (denormalized on `memory_items`) so that "everything
    // this project remembers" needs no join — see the `memory_items` header.
    tier: 'session',
    projectId: input.projectId,
    sessionId: input.sessionId,
    title: title.length > 0 ? title : 'Untitled session',
    text: lines.join('\n\n'),
    occurredAt: input.occurredAt,
  };
}

// -------------------------------------------------------------------------------- commits

export interface CommitProjectionInput {
  readonly commitId: string;
  readonly projectId: string;
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly branch: string | null;
  readonly files: readonly CommitFile[];
  readonly committedAt: Date;
}

export function projectCommit(input: CommitProjectionInput): SourceProjection {
  const message = input.message.trim();
  const subject = message.split('\n', 1)[0] ?? '';

  const paths = input.files
    .map((file) => file.path)
    .filter((path) => path.length > 0)
    .slice(0, MAX_PROJECTED_COMMIT_FILES);

  const sections = [message];
  if (paths.length > 0) sections.push(`Files: ${paths.join(', ')}`);

  return {
    sourceType: 'commit',
    sourceId: input.commitId,
    sourceRef: null,
    // Project tier, even when the commit is attributed to a Session. PRD §6.1 calls project
    // memory "repository-specific", and a commit outlives the conversation that produced it —
    // scoping it to a Session would hide it from every project-wide question.
    tier: 'project',
    projectId: input.projectId,
    sessionId: null,
    title: subject.length > 0 ? subject : `${input.sha.slice(0, 7)} (no message)`,
    text: message.length === 0 && paths.length === 0 ? '' : sections.join('\n\n'),
    occurredAt: input.committedAt,
  };
}

// ------------------------------------------------------------------------------------ ADRs

export interface AdrProjectionInput {
  readonly adrId: string;
  readonly projectId: string;
  readonly adrNumber: number;
  readonly title: string;
  readonly status: string;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: string;
  readonly consequences: string;
  readonly updatedAt: Date;
}

/** `ADR-0007` — the label the product shows and an operator types. */
export function adrLabel(adrNumber: number): string {
  return `ADR-${String(adrNumber).padStart(4, '0')}`;
}

export function projectAdr(input: AdrProjectionInput): SourceProjection {
  const label = `${adrLabel(input.adrNumber)} — ${input.title.trim()}`;
  const sections: string[] = [`${label}\nStatus: ${input.status}`];

  const add = (heading: string, body: string): void => {
    const trimmed = body.trim();
    if (trimmed.length > 0) sections.push(`## ${heading}\n${trimmed}`);
  };

  add('Context', input.context);
  add('Decision', input.decision);
  add('Alternatives', input.alternatives);
  add('Consequences', input.consequences);

  return {
    sourceType: 'adr',
    sourceId: input.adrId,
    sourceRef: null,
    tier: 'project',
    projectId: input.projectId,
    sessionId: null,
    title: label,
    // One section only (just the header block) means an empty ADR: a title and a status embed
    // to almost nothing and would answer every query weakly. Skipped rather than indexed.
    text: sections.length === 1 ? '' : sections.join('\n\n'),
    occurredAt: input.updatedAt,
  };
}

// --------------------------------------------------------------------------- pull requests

export interface PullRequestProjectionInput {
  readonly pullRequestId: string;
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly updatedAt: Date;
}

export function projectPullRequest(input: PullRequestProjectionInput): SourceProjection {
  const heading = `#${String(input.number)} ${input.title.trim()}`;
  const description = (input.description ?? '').trim();

  return {
    sourceType: 'pull_request',
    sourceId: input.pullRequestId,
    sourceRef: null,
    tier: 'project',
    projectId: input.projectId,
    sessionId: null,
    title: heading,
    text: description.length === 0 ? heading : `${heading}\n\n${description}`,
    occurredAt: input.updatedAt,
  };
}

// -------------------------------------------------------------------------- Obsidian notes

export interface NoteProjectionInput {
  /** Vault-relative, forward slashes — the `memory_items.source_ref` value. */
  readonly vaultPath: string;
  /** The note body with front matter already removed (`parseNote` gives this). */
  readonly body: string;
  readonly mtime: Date;
}

export function projectNote(input: NoteProjectionInput): SourceProjection {
  const body = input.body.trim();
  const name = input.vaultPath.split('/').pop() ?? input.vaultPath;
  const title = name.replace(/\.md$/i, '');

  return {
    sourceType: 'obsidian_note',
    sourceId: null,
    sourceRef: input.vaultPath,
    // Global tier: a vault note has no Project unless the operator's folder layout implies one,
    // and inferring a Project from a path is a guess that would silently scope a note out of
    // every query that did not share the guess.
    tier: 'global',
    projectId: null,
    sessionId: null,
    title,
    // The filename leads because Obsidian users title by filename and rarely repeat it in the
    // body — without it, `Deployment checklist.md` is invisible to "deployment".
    text: body.length === 0 ? '' : `${title}\n\n${body}`,
    occurredAt: input.mtime,
  };
}
