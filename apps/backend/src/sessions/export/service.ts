import { type Db, utf8Bytes } from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import type { MemorySearchResponse, MemorySearchService } from '../../memory/retrieval.js';
import { probeWorkingTree, type WorkingTreeStatus } from '../../repositories/git.js';
import type { SessionRow } from '../repository.js';
import {
  readAdrs,
  readCommits,
  readFiles,
  readFinalAssistantMessage,
  readPrompts,
  readSessionContext,
  readToolUsage,
  readTranscript,
  type SessionContext,
} from './evidence.js';
import {
  type ContextPackageInput,
  type PackageWorkingTree,
  type RelatedContext,
  type RelatedGapReason,
  type RelatedItem,
  renderContextPackage,
} from './package.js';
import {
  type ExportFormat,
  type ExportSessionFacts,
  renderSessionExport,
  type SessionExportDocument,
} from './render.js';
import { estimateTokens } from './text.js';

/**
 * The two §6.7 endpoints, assembled.
 *
 * `render.ts` and `package.ts` are pure; `evidence.ts` is bounded SQL. This file is the part
 * that reaches outside the database — one semantic-memory query and one `git status` — and it
 * exists to guarantee one property:
 *
 * **Neither endpoint can hang, and neither can fail because a dependency did.**
 *
 * Semantic retrieval reaches Ollama and Qdrant; a `git status` reaches a filesystem that may be
 * a disconnected network share. Both are bounded twice — the adapters carry their own timeouts,
 * and this file wraps each in a deadline of its own so a bound that is missed inside cannot
 * become an unbounded request out here. When either budget expires, the *document still
 * generates*, with the failure written into it as prose. That is the difference between a
 * package an operator can act on and a 503 they cannot.
 *
 * Failures are data (`RelatedContext.gap`, `PackageWorkingTree.unavailableReason`). Nothing
 * here throws except `NOT_FOUND` for a Session that does not exist and `CONFLICT` for one that
 * has nothing to describe.
 */

/**
 * The whole related-context step, end to end: the embedding call plus one or two vector queries.
 *
 * Deliberately larger than the retrieval service's own 15 s per-call bound and deliberately
 * finite: a cold `nomic-embed-text` genuinely takes seconds to load, and a package that gave up
 * at three would report a gap on a machine that was merely slow. Past this, the honest answer is
 * that memory did not answer in time.
 */
export const MEMORY_BUDGET_MS = 25_000;

/** One `git status --porcelain=v2`. `repositories/git.ts` defaults to the same figure. */
export const GIT_BUDGET_MS = 10_000;

/** Memory hits copied into a package. Enough to be useful; short of being a second transcript. */
export const RELATED_LIMIT = 6;

/** `MemorySearchService` caps the query at 2 000 characters; this stays comfortably inside. */
const MAX_QUERY_CHARS = 1_000;

export interface ContextPackageResult {
  readonly content: string;
  /** §6.7's field. An estimate, and `text.ts` says exactly what kind — `bytes` is the fact. */
  readonly tokenEstimate: number;
  readonly bytes: number;
  readonly generatedAt: string;
  /**
   * ⚠ Additive to §6.7, and flagged rather than added quietly. §6.7 gives
   * `{ content, tokenEstimate, generatedAt }`, which cannot tell a client whether the package it
   * just received is whole. The Memory screen and the session overflow menu both need to badge a
   * degraded package without parsing Markdown for a warning callout, and a UI that has to
   * regex-match prose to find out is a UI that will get it wrong.
   */
  readonly relatedContext: {
    readonly resultCount: number;
    readonly gapReason: RelatedGapReason | null;
    readonly gapDetail: string | null;
    readonly embeddingModel: string | null;
  };
}

export interface SessionExportServiceOptions {
  readonly db: Db;
  /** `null` builds a service that always reports `not_configured`, never one that omits. */
  readonly memory: MemorySearchService | null;
  readonly memoryBudgetMs?: number | undefined;
  readonly gitBudgetMs?: number | undefined;
  /** Injected by tests so a package can be generated without running `git`. */
  readonly probe?:
    | ((localPath: string, options: { timeoutMs: number }) => Promise<WorkingTreeStatus>)
    | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export class SessionExportService {
  readonly #db: Db;
  readonly #memory: MemorySearchService | null;
  readonly #memoryBudgetMs: number;
  readonly #gitBudgetMs: number;
  readonly #probe: (
    localPath: string,
    options: { timeoutMs: number },
  ) => Promise<WorkingTreeStatus>;
  readonly #now: () => Date;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  constructor(options: SessionExportServiceOptions) {
    this.#db = options.db;
    this.#memory = options.memory;
    this.#memoryBudgetMs = options.memoryBudgetMs ?? MEMORY_BUDGET_MS;
    this.#gitBudgetMs = options.gitBudgetMs ?? GIT_BUDGET_MS;
    this.#probe = options.probe ?? probeWorkingTree;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
  }

  /** `POST /api/v1/sessions/{id}/export`. */
  async export(id: string, format: ExportFormat): Promise<SessionExportDocument> {
    const context = await this.#require(id, 'export');

    const [transcript, files, commits] = await Promise.all([
      readTranscript(this.#db, id),
      readFiles(this.#db, context.session),
      readCommits(this.#db, id),
    ]);

    // One format today, and `render.ts` explains why. The parameter is threaded through rather
    // than ignored so adding a second one is a change to the renderer, not to the contract.
    void format;

    return renderSessionExport({
      session: sessionFacts(context),
      transcript,
      files,
      commits,
      generatedAt: this.#now(),
    });
  }

  /** `POST /api/v1/sessions/{id}/context-package`. */
  async contextPackage(id: string): Promise<ContextPackageResult> {
    const context = await this.#require(id, 'context-package');
    const generatedAt = this.#now();

    const [prompts, finalMessage, files, commits, adrs, tools] = await Promise.all([
      readPrompts(this.#db, id),
      readFinalAssistantMessage(this.#db, id),
      readFiles(this.#db, context.session),
      readCommits(this.#db, id),
      readAdrs(this.#db, id),
      readToolUsage(this.#db, id),
    ]);

    // The two outbound edges run together: they share no state, and a package that waited for
    // git *then* Ollama would take the sum of two budgets rather than the larger of them.
    const [workingTree, related] = await Promise.all([
      this.#readWorkingTree(context, generatedAt),
      this.#readRelated(context, prompts.head[0] ?? prompts.tail[0] ?? null),
    ]);

    const input: ContextPackageInput = {
      session: sessionFacts(context),
      prompts,
      finalMessage,
      files,
      commits,
      adrs,
      tools,
      workingTree,
      related,
      generatedAt,
    };

    const content = renderContextPackage(input);
    const bytes = utf8Bytes(content);

    return {
      content,
      tokenEstimate: estimateTokens(bytes),
      bytes,
      generatedAt: generatedAt.toISOString(),
      relatedContext: {
        resultCount: related.items.length,
        gapReason: related.gap?.reason ?? null,
        gapDetail: related.gap?.detail ?? null,
        embeddingModel: related.embeddingModel,
      },
    };
  }

  // ------------------------------------------------------------------------------ internals

  async #require(id: string, action: string): Promise<SessionContext> {
    const context = await readSessionContext(this.#db, id);
    if (context === null) throw new ApiError('NOT_FOUND', `No session with id ${id}`);

    // §6.7: "CONFLICT if state = created (nothing to export)". A Session that has never started
    // has no messages, no files and no commits, so both documents would be a header followed by
    // nine "nothing recorded" sections — an answer that looks like a product defect. The refusal
    // names the state so the caller can tell it from a missing Session.
    if (context.session.state === 'created') {
      throw new ApiError(
        'CONFLICT',
        'This session has not started, so there is nothing to export yet',
        { state: context.session.state, action },
      );
    }

    return context;
  }

  /**
   * `git status` in the Repository's local path — the one fact in a context package that is not
   * in the transcript at all.
   *
   * `probeWorkingTree` never throws: an unreadable tree comes back as a reason. The deadline
   * here is the second bound, for the case its own timeout cannot cover — a directory on a
   * network share where the `stat` that precedes the child process is what blocks.
   */
  async #readWorkingTree(
    context: SessionContext,
    checkedAt: Date,
  ): Promise<PackageWorkingTree | null> {
    const localPath = context.repositoryLocalPath;
    if (localPath === null) return null;

    const status = await this.#withDeadline(
      this.#probe(localPath, { timeoutMs: this.#gitBudgetMs }),
      this.#gitBudgetMs + 1_000,
      'git',
    );

    if (status === null) {
      return {
        localPath,
        currentBranch: null,
        detachedHead: false,
        headSha: null,
        uncommittedFiles: null,
        ahead: null,
        behind: null,
        unavailableReason: 'timed_out',
        detail: `git did not answer within ${String(this.#gitBudgetMs)}ms`,
        checkedAt,
      };
    }

    return {
      localPath,
      currentBranch: status.currentBranch,
      detachedHead: status.detachedHead,
      headSha: status.headSha,
      uncommittedFiles: status.uncommittedFiles,
      ahead: status.ahead,
      behind: status.behind,
      unavailableReason: status.unavailableReason,
      detail: status.detail,
      checkedAt,
    };
  }

  /**
   * One semantic query, scoped to this Session's Project, with this Session's own chunks removed.
   *
   * **One query, not one per section.** N queries means N embedding calls and N chances to hang
   * for a section that is supporting evidence rather than the point of the document.
   *
   * **Its own chunks are dropped afterwards** because `MemoryFilter` is closed by design
   * (`vector-store-port.ts`) and has no "not this session" clause. Filtering after the fact
   * costs at most `RELATED_LIMIT` wasted hits and keeps the filter vocabulary small enough that
   * the in-memory fake implements it exactly — the trade `retrieval.ts` already made.
   *
   * Every failure arm produces a **named gap**, never an omission.
   */
  async #readRelated(context: SessionContext, firstPrompt: string | null): Promise<RelatedContext> {
    const query = buildQuery(context, firstPrompt);

    if (query === null) {
      return gap(
        null,
        'no_query',
        'This Session has no title and recorded no operator prompt, so there was no query to run.',
      );
    }

    if (this.#memory === null) {
      return gap(
        query,
        'not_configured',
        'This Backend was built without the memory layer, so no semantic search was performed.',
      );
    }

    let response: MemorySearchResponse | null;
    try {
      response = await this.#withDeadline(
        this.#memory.search({
          q: query,
          limit: RELATED_LIMIT + 4,
          projectId: context.session.projectId,
        }),
        this.#memoryBudgetMs,
        'memory',
      );
    } catch (error) {
      // `MemorySearchService` answers most failures as data; the residue (an embedder that
      // returned no vector at all) throws. A context package must survive that too.
      this.#onError?.(error, 'context-package.memory');
      return gap(
        query,
        'unavailable',
        'Semantic retrieval failed while this package was being generated.',
      );
    }

    if (response === null) {
      return gap(
        query,
        'timed_out',
        `Semantic retrieval did not answer within ${String(this.#memoryBudgetMs)}ms and was ` +
          'abandoned so this package could still be produced.',
      );
    }

    return toRelatedContext(query, response, context.session.id);
  }

  /**
   * Race a promise against a deadline.
   *
   * `null` means the deadline won. The loser is not cancelled — neither adapter exposes an abort
   * handle at this seam — but both carry their own timeouts, so it settles on its own; the
   * `catch` is there purely so a late rejection cannot surface as an unhandled one after the
   * response has already gone out.
   */
  async #withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, ms);
      timer.unref?.();
    });

    work.catch((error: unknown) => {
      this.#onError?.(error, `context-package.${label}`);
    });

    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * A retrieval response, turned into the section's input.
 *
 * Pure and exported so the unit tier can exercise every degraded arm — not configured, Ollama
 * down, stamp mismatch, empty index, everything below the floor, and "the only matches were this
 * session's own transcript" — without a database, a vector store or an embedder. Those six
 * branches are the honesty requirement of this feature, and a branch that can only be reached by
 * turning a real service off is a branch that will not be tested.
 *
 * `emptyReason: 'none'` with no surviving results is the one case retrieval itself cannot name:
 * memory answered perfectly and every hit was this Session. That becomes `only_own_session`,
 * which reads very differently to the operator than "nothing was found".
 */
export function toRelatedContext(
  query: string,
  response: MemorySearchResponse,
  sessionId: string,
): RelatedContext {
  const own = response.results.filter((result) => result.context.sessionId === sessionId).length;

  const items: RelatedItem[] = response.results
    .filter((result) => result.context.sessionId !== sessionId)
    .slice(0, RELATED_LIMIT)
    .map((result) => ({
      title: result.title,
      sourceType: result.sourceType,
      score: result.score,
      occurredAt: result.occurredAt,
      chunkOrdinal: result.chunkOrdinal,
      chunkCount: result.chunkCount,
      content: result.content,
    }));

  if (items.length === 0) {
    const reason: RelatedGapReason =
      response.emptyReason === 'none' ? 'only_own_session' : response.emptyReason;
    return {
      query,
      items: [],
      gap: {
        reason,
        detail:
          response.detail ??
          'Every match was this session’s own transcript, which this package excludes.',
      },
      embeddingModel: response.embeddingModel,
      minScore: response.minScore,
      ownChunksDropped: own,
    };
  }

  return {
    query,
    items,
    gap: null,
    embeddingModel: response.embeddingModel,
    minScore: response.minScore,
    ownChunksDropped: own,
  };
}

function gap(query: string | null, reason: RelatedGapReason, detail: string): RelatedContext {
  return {
    query,
    items: [],
    gap: { reason, detail },
    embeddingModel: null,
    minScore: null,
    ownChunksDropped: 0,
  };
}

/**
 * What to ask semantic memory about this Session.
 *
 * The Session's own title and its first operator prompt, and nothing else — both are recorded
 * text, so the query is evidence rather than a guess at what the session was "about". A
 * generated topic description would be the invention this whole module refuses; an embedding of
 * the operator's own words is not.
 *
 * `null` when neither exists, which renders as the `no_query` gap. That is a different answer
 * from "nothing matched" and the document says which.
 */
export function buildQuery(context: SessionContext, firstPrompt: string | null): string | null {
  const parts = [context.session.title?.trim() ?? '', firstPrompt?.trim() ?? ''].filter(
    (part) => part.length > 0,
  );
  if (parts.length === 0) return null;
  return parts.join('\n\n').slice(0, MAX_QUERY_CHARS);
}

/** The Session row projected onto the shape both renderers take. */
function sessionFacts(context: SessionContext): ExportSessionFacts {
  const row: SessionRow = context.session;
  return {
    id: row.id,
    title: row.title,
    projectId: row.projectId,
    projectName: context.projectName,
    repositoryName: context.repositoryName,
    state: row.state,
    sessionType: row.sessionType,
    runtime: row.runtime,
    runtimeSessionId: row.runtimeSessionId,
    runtimeVersion: row.runtimeVersion,
    model: row.model,
    machine: row.machine,
    environment: row.environment,
    branch: row.branch,
    workingDir: row.workingDir,
    notes: row.notes,
    failureReason: row.failureReason,
    totalCostUsd: row.totalCostUsd,
    numTurns: row.numTurns,
    durationMs: row.durationMs,
    resumedFromSessionId: row.resumedFromSessionId,
    lineageKind: row.lineageKind,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    archivedAt: row.archivedAt,
  };
}
