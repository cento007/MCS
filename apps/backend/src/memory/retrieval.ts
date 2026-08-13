import {
  type Db,
  describeEmbeddingFailure,
  type MemoryFilter,
  type MemoryItemRow,
  type MemorySourceType,
  type MemoryTier,
  PRODUCIBLE_MEMORY_TIERS,
  readMemoryItemsByIds,
  schema,
} from '@mc/shared';
import { eq, inArray, or } from 'drizzle-orm';
import { ApiError } from '../http/errors.js';
import type { MemoryRuntime } from './runtime.js';

/**
 * Semantic retrieval — `POST /api/v1/memory-items/search` (TDS 04 §13.1).
 *
 * ## A separate route from `GET /search`, on purpose
 *
 * §13.1 keeps semantic memory on its own route and §11 says so from the other side ("Semantic
 * memory search is a Phase 3 concern and does not share this route"). They are not two
 * implementations of one feature. Keyword search is exact, instant, spans five *live* tables and
 * ranks by `ts_rank_cd`; this ranks *chunks* of a possibly-stale index by cosine distance, costs
 * an embedding call per query, and can return nothing at all for a query that FTS would answer
 * perfectly. Merging them would mean one result list whose entries have incomparable scores and
 * one latency floor set by the slower half.
 *
 * ## Scope filtering is a correctness property
 *
 * `MemoryFilter` is closed (`vector-store-port.ts`) and the filter is applied **inside** the
 * vector search, not after it. That matters twice over: filtering afterwards would mean asking
 * for `limit` hits and discarding most of them (so a project with few memories returns nothing
 * while the store has plenty), and it would put the visibility decision in application code
 * where a missing `if` is invisible. A `projectId` in a request becomes a `must` clause in
 * Qdrant, and the in-memory fake applies the identical shared predicate.
 *
 * The negative case is the one worth testing and it is tested: a project-scoped query must not
 * return another project's vectors.
 *
 * ### `projectId` widens to global, and that is deliberate
 *
 * Asking for one project's memory returns that project's chunks **and** `global`-tier ones
 * (vault notes), because global memory is by definition not another project's. It never returns
 * a *different* project's chunks. Expressed as two `MemoryFilter` clauses rather than one,
 * because the closed filter ANDs across fields: `tiers` is left unconstrained and `projectIds`
 * is `[id]` for the scoped half, and the global half is a second query the results are merged
 * from. One query cannot express "(project = X) OR (tier = global)" in a shape whose whole value
 * is that it is small enough for the fake to implement exactly.
 *
 * ## Being honest about relevance
 *
 * Cosine similarity always returns something. An unfiltered top-5 over an unrelated corpus is
 * five confident irrelevancies, and the operator cannot tell them from five good answers. So
 * there is a **floor**, and an empty result is a first-class answer with a reason attached
 * (`emptyReason`), not an empty array the client has to interpret.
 *
 * The floor is **0.52** by default, and it is a *measured* number rather than a guessed one —
 * see `DEFAULT_MIN_SCORE`, which records the score table it came from.
 */

/**
 * The relevance floor, in cosine similarity.
 *
 * **Measured, not guessed** — and the first guess (0.45, from the usual rule of thumb) was
 * wrong in the direction that matters. Against 758 chunks of this repository's own content
 * (18 real commits, the TDS and PRD split into 354 decision-shaped sections, 8 pull requests
 * and a session transcript), indexed with `nomic-embed-text` and queried with the top-5 scores
 * recorded:
 *
 * | query                                                    | top-5 cosine scores               |
 * |----------------------------------------------------------|-----------------------------------|
 * | "How do WebSocket clients recover after the relay drops?" | 0.660 0.642 0.639 0.637 0.634     |
 * | "When did we adopt pg-boss instead of Redis?"             | 0.654 0.646 0.633 0.629 0.621     |
 * | "Why is there no Docker anywhere in this project?"        | 0.653 0.569 0.567 0.565 0.559     |
 * | "Find deployment decisions"                               | 0.614 0.611 0.606 0.605 0.599     |
 * | "Show me authentication discussions"                      | 0.587 0.570 0.561 0.554 **0.552** |
 * | *"What is the best recipe for sourdough bread?"*          | **0.509** 0.502 0.473 0.472 0.468 |
 * | *"Which football team won the league in 1997?"*           | 0.472 0.452 0.441 0.439 0.437     |
 *
 * On-topic bottoms out at **0.552**; off-topic tops out at **0.509**. The gap is real but it is
 * **narrow — 0.043 wide**, and at 0.45 the sourdough query returned five confident irrelevancies.
 * 0.52 sits inside it.
 *
 * ## Why the band is so compressed, and what would widen it
 *
 * `nomic-embed-text` is trained for *asymmetric* retrieval with task prefixes —
 * `search_query: …` on the query and `search_document: …` on the passage. Ollama's `/api/embed`
 * applies neither, so both sides are embedded as plain passages and every pair sits high on the
 * cosine scale. Adding the prefixes would separate the bands considerably, and it is **not** done
 * here for one reason: the prefix is baked into the stored vector, so it is a property of the
 * *index*, not of the query — adopting it later would require a full rebuild, and adopting it
 * now would hard-code one model family's convention into a port that is meant to accept any
 * embedder. It is recorded as the first thing to try if retrieval quality needs work, alongside
 * a per-model floor.
 *
 * It is a **default**, not a constant: the gap is a property of the corpus as much as of the
 * model, and `minScore` is a request field. It is not zero, because "here are five bad matches"
 * and "nothing relevant" are different answers and only one of them is useful.
 */
export const DEFAULT_MIN_SCORE = 0.52;

export const MAX_MEMORY_QUERY_LENGTH = 2_000;
export const DEFAULT_MEMORY_SEARCH_LIMIT = 10;
export const MAX_MEMORY_SEARCH_LIMIT = 50;

export interface MemorySearchInput {
  readonly q: string;
  readonly limit?: number | undefined;
  readonly tiers?: readonly MemoryTier[] | undefined;
  readonly projectId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sourceTypes?: readonly MemorySourceType[] | undefined;
  readonly minScore?: number | undefined;
}

/**
 * Everything a client needs to *reach* the thing that matched.
 *
 * ⚠ **Additive to TDS 04 §13.1, flagged rather than invented quietly** — §13.1 is an interface
 * stub with "no payload detail", so this is the first concrete shape and it is written down
 * here. The design constraint comes from the Phase 2 search, which learned it the hard way:
 * three of its five result types were unclickable because an id alone cannot build a link
 * (`search/types.ts`). A memory hit is worse off than a search hit — it is a *chunk*, so even
 * its own identity ("ADR-0007, section 2 of 5") is not derivable from a row id.
 *
 * So each result carries:
 *
 *   - `sourceType` + `sourceId`/`sourceRef` — what matched, in the client's own vocabulary;
 *   - `projectId` / `sessionId` — the route parameters TDS 05 §2.2 actually has pages for.
 *     There is no `/commits/:id` or `/pull-requests/:id` route: a commit is rendered under its
 *     Repository under its Project, and a Message inside its Session. Without these two ids a
 *     commit hit is unreachable text;
 *   - `repositoryId` for commits and pull requests, which is the level their pages live at;
 *   - `title` — a nameable label (`ADR-0007 — Use pg-boss`, `#42 Fix the relay gap`, the Session
 *     title) so a result can be listed before anything is fetched;
 *   - `chunkOrdinal` + `chunkCount`, because "the 4th of 9 chunks" is what makes a long-document
 *     hit meaningful rather than mysteriously partial;
 *   - `content`, the chunk text itself. **Plain text — render it as text, never as HTML.** There
 *     is deliberately no `<mark>` highlighting: a semantic match has no matched *terms* to
 *     highlight, and inventing keyword highlights on a vector hit would tell the operator the
 *     wrong story about why it matched.
 */
export interface MemorySearchResult {
  readonly memoryItemId: string;
  readonly score: number;
  readonly tier: MemoryTier;
  readonly sourceType: MemorySourceType;
  readonly sourceId: string | null;
  readonly sourceRef: string | null;
  readonly title: string;
  readonly content: string;
  readonly chunkOrdinal: number;
  readonly chunkCount: number;
  readonly occurredAt: string | null;
  readonly context: {
    readonly projectId: string | null;
    readonly repositoryId: string | null;
    readonly sessionId: string | null;
  };
}

/**
 * Why a search came back empty. Four different situations that all render as "no results" and
 * for which the operator's next action is completely different.
 */
export type EmptyReason =
  | 'none'
  | 'not_configured'
  | 'unavailable'
  | 'stamp_mismatch'
  | 'index_empty'
  | 'below_threshold';

export interface MemorySearchResponse {
  readonly results: readonly MemorySearchResult[];
  readonly emptyReason: EmptyReason;
  /** Operator-facing sentence when `emptyReason` is not `none`. */
  readonly detail: string | null;
  readonly minScore: number;
  /** The model the query vector was produced by — the answer to "why did this match?". */
  readonly embeddingModel: string | null;
  /** Hits the store returned before the floor dropped them. Makes the floor visible. */
  readonly candidatesConsidered: number;
}

export interface MemorySearchServiceOptions {
  readonly db: Db;
  readonly runtime: MemoryRuntime;
  /** Bounds the query's embedding call. Far tighter than an index run's — a person is waiting. */
  readonly timeoutMs?: number | undefined;
}

/** An interactive query gets a tight bound; a cold model will simply have to be woken by a job. */
export const MEMORY_QUERY_TIMEOUT_MS = 15_000;

export class MemorySearchService {
  readonly #db: Db;
  readonly #runtime: MemoryRuntime;
  readonly #timeoutMs: number;

  constructor(options: MemorySearchServiceOptions) {
    this.#db = options.db;
    this.#runtime = options.runtime;
    this.#timeoutMs = options.timeoutMs ?? MEMORY_QUERY_TIMEOUT_MS;
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResponse> {
    const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
    const limit = clampSearchLimit(input.limit);

    const state = await this.#runtime.ready();
    if (state.kind !== 'ready') {
      return {
        results: [],
        // Not an error response: a Memory panel on a machine whose Ollama is off should say so,
        // not show a 503. The reason is the actionable part and it is carried as data.
        emptyReason: state.kind === 'not_configured' ? 'not_configured' : state.kind,
        detail: state.reason,
        minScore,
        embeddingModel: null,
        candidatesConsidered: 0,
      };
    }

    const embedded = await state.embedder.embed([input.q], { timeoutMs: this.#timeoutMs });
    if (embedded.kind !== 'ok') {
      // The embedder went away between `ready()` and here. Drop the cached runtime so the next
      // query re-probes rather than failing the same way for the life of the process.
      this.#runtime.invalidate();
      return {
        results: [],
        emptyReason: 'unavailable',
        detail: describeEmbeddingFailure(embedded),
        minScore,
        embeddingModel: state.stamp.model,
        candidatesConsidered: 0,
      };
    }

    const vector = embedded.vectors[0];
    if (vector === undefined) {
      throw new ApiError('INTERNAL', 'The embedder returned no vector for the query');
    }

    const filters = buildFilters(input);
    const seen = new Map<string, { score: number; ordinal: number }>();
    let candidates = 0;

    for (const filter of filters) {
      const hits = await state.store.search(
        // No `minScore` here: the floor is applied after merging, so `candidatesConsidered`
        // can honestly report how many the store offered rather than how many survived.
        { vector, limit, filter },
        { timeoutMs: this.#timeoutMs },
      );
      if (hits.kind !== 'ok') {
        this.#runtime.invalidate();
        return {
          results: [],
          emptyReason: 'unavailable',
          detail: `The vector store could not be queried (${hits.kind})`,
          minScore,
          embeddingModel: state.stamp.model,
          candidatesConsidered: 0,
        };
      }

      for (const hit of hits.value) {
        candidates += 1;
        const existing = seen.get(hit.payload.memoryItemId);
        if (existing === undefined || hit.score > existing.score) {
          seen.set(hit.payload.memoryItemId, {
            score: hit.score,
            ordinal: hit.payload.chunkOrdinal,
          });
        }
      }
    }

    if (candidates === 0) {
      return {
        results: [],
        emptyReason: 'index_empty',
        detail:
          'Nothing is indexed for this scope yet. Run a memory backfill from Settings, or wait ' +
          'for the next session to complete.',
        minScore,
        embeddingModel: state.stamp.model,
        candidatesConsidered: 0,
      };
    }

    const above = [...seen.entries()]
      .filter(([, hit]) => hit.score >= minScore)
      .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
      .slice(0, limit);

    if (above.length === 0) {
      return {
        results: [],
        emptyReason: 'below_threshold',
        detail:
          `Nothing scored above ${minScore.toFixed(2)}. ${String(candidates)} chunk` +
          `${candidates === 1 ? ' was' : 's were'} considered — the closest were not close ` +
          'enough to be worth showing.',
        minScore,
        embeddingModel: state.stamp.model,
        candidatesConsidered: candidates,
      };
    }

    const results = await this.#hydrate(above);
    return {
      results,
      // Hydration can empty a non-empty hit list when every hit's row has gone — the mechanism
      // that makes an orphan point unable to answer a query. Reported honestly.
      emptyReason: results.length === 0 ? 'index_empty' : 'none',
      detail:
        results.length === 0
          ? 'The matching chunks refer to sources that no longer exist; they will be cleared by ' +
            'the next backfill.'
          : null,
      minScore,
      embeddingModel: state.stamp.model,
      candidatesConsidered: candidates,
    };
  }

  /** `GET /api/v1/memory-items/{id}` — one chunk, with the same reachable context. */
  async get(id: string): Promise<MemorySearchResult> {
    const rows = await readMemoryItemsByIds(this.#db, [id]);
    const row = rows.get(id);
    if (row === undefined) throw new ApiError('NOT_FOUND', `No memory item with id ${id}`);

    const hydrated = await this.#decorate([row], new Map([[id, { score: 1, ordinal: 0 }]]));
    const result = hydrated[0];
    /* c8 ignore next */
    if (result === undefined) throw new ApiError('NOT_FOUND', `No memory item with id ${id}`);
    return result;
  }

  /**
   * Turn scored ids into results.
   *
   * **A hit whose row is absent is dropped.** That is not defensive coding, it is the mechanism
   * that makes the crash windows in `indexer.ts` survivable: an orphan point — one whose row was
   * deleted before its vector was — cannot answer a query, because there is nothing to show for
   * it and nothing to link to.
   */
  async #hydrate(
    scored: readonly (readonly [string, { score: number; ordinal: number }])[],
  ): Promise<MemorySearchResult[]> {
    const byId = await readMemoryItemsByIds(
      this.#db,
      scored.map(([id]) => id),
    );
    const order = new Map(scored);
    const rows = scored
      .map(([id]) => byId.get(id))
      .filter((row): row is MemoryItemRow => row !== undefined);

    return this.#decorate(rows, order);
  }

  /** Attach the title, the chunk count and the routing ids each source type needs. */
  async #decorate(
    rows: readonly MemoryItemRow[],
    scores: ReadonlyMap<string, { score: number; ordinal: number }>,
  ): Promise<MemorySearchResult[]> {
    const [titles, chunkCounts] = await Promise.all([this.#titles(rows), this.#chunkCounts(rows)]);

    return rows.map((row) => {
      const key = `${row.sourceType}:${row.sourceId ?? row.sourceRef ?? ''}`;
      const meta = titles.get(key);
      return {
        memoryItemId: row.id,
        score: scores.get(row.id)?.score ?? 0,
        tier: row.tier as MemoryTier,
        sourceType: row.sourceType as MemorySourceType,
        sourceId: row.sourceId,
        sourceRef: row.sourceRef,
        title: meta?.title ?? fallbackTitle(row),
        content: row.content ?? '',
        chunkOrdinal: row.chunkOrdinal,
        chunkCount: chunkCounts.get(key) ?? row.chunkOrdinal + 1,
        occurredAt: meta?.occurredAt ?? null,
        context: {
          projectId: row.projectId ?? meta?.projectId ?? null,
          repositoryId: meta?.repositoryId ?? null,
          sessionId: row.sessionId ?? meta?.sessionId ?? null,
        },
      };
    });
  }

  /** How many chunks each hit's source has — the "4 of 9" a long-document hit needs. */
  async #chunkCounts(rows: readonly MemoryItemRow[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (rows.length === 0) return counts;

    const ids = [
      ...new Set(rows.map((row) => row.sourceId).filter((id): id is string => id !== null)),
    ];
    const refs = [
      ...new Set(rows.map((row) => row.sourceRef).filter((ref): ref is string => ref !== null)),
    ];

    const conditions = [];
    if (ids.length > 0) conditions.push(inArray(schema.memoryItems.sourceId, ids));
    if (refs.length > 0) conditions.push(inArray(schema.memoryItems.sourceRef, refs));
    if (conditions.length === 0) return counts;

    const all = await this.#db
      .select({
        sourceType: schema.memoryItems.sourceType,
        sourceId: schema.memoryItems.sourceId,
        sourceRef: schema.memoryItems.sourceRef,
        chunkOrdinal: schema.memoryItems.chunkOrdinal,
      })
      .from(schema.memoryItems)
      .where(or(...conditions));

    for (const row of all) {
      const key = `${row.sourceType}:${row.sourceId ?? row.sourceRef ?? ''}`;
      counts.set(key, Math.max(counts.get(key) ?? 0, row.chunkOrdinal + 1));
    }
    return counts;
  }

  /** Per-source display metadata, one query per source type present in the hits. */
  async #titles(rows: readonly MemoryItemRow[]): Promise<Map<string, SourceMeta>> {
    const meta = new Map<string, SourceMeta>();
    const idsOf = (type: string): string[] => [
      ...new Set(
        rows
          .filter((row) => row.sourceType === type && row.sourceId !== null)
          .map((row) => row.sourceId as string),
      ),
    ];

    const sessionIds = idsOf('session');
    if (sessionIds.length > 0) {
      const found = await this.#db
        .select({
          id: schema.sessions.id,
          title: schema.sessions.title,
          projectId: schema.sessions.projectId,
          repositoryId: schema.sessions.repositoryId,
          completedAt: schema.sessions.completedAt,
          createdAt: schema.sessions.createdAt,
        })
        .from(schema.sessions)
        .where(inArray(schema.sessions.id, sessionIds));
      for (const row of found) {
        meta.set(`session:${row.id}`, {
          title: row.title ?? 'Untitled session',
          projectId: row.projectId,
          repositoryId: row.repositoryId,
          sessionId: row.id,
          occurredAt: (row.completedAt ?? row.createdAt).toISOString(),
        });
      }
    }

    const adrIds = idsOf('adr');
    if (adrIds.length > 0) {
      const found = await this.#db
        .select({
          id: schema.adrs.id,
          adrNumber: schema.adrs.adrNumber,
          title: schema.adrs.title,
          projectId: schema.adrs.projectId,
          updatedAt: schema.adrs.updatedAt,
        })
        .from(schema.adrs)
        .where(inArray(schema.adrs.id, adrIds));
      for (const row of found) {
        meta.set(`adr:${row.id}`, {
          title: `ADR-${String(row.adrNumber).padStart(4, '0')} — ${row.title}`,
          projectId: row.projectId,
          repositoryId: null,
          sessionId: null,
          occurredAt: row.updatedAt.toISOString(),
        });
      }
    }

    const commitIds = idsOf('commit');
    if (commitIds.length > 0) {
      const found = await this.#db
        .select({
          id: schema.commits.id,
          message: schema.commits.message,
          sha: schema.commits.sha,
          repositoryId: schema.commits.repositoryId,
          projectId: schema.repositories.projectId,
          sessionId: schema.commits.sessionId,
          committedAt: schema.commits.committedAt,
        })
        .from(schema.commits)
        .innerJoin(schema.repositories, eq(schema.repositories.id, schema.commits.repositoryId))
        .where(inArray(schema.commits.id, commitIds));
      for (const row of found) {
        meta.set(`commit:${row.id}`, {
          title: `${row.sha.slice(0, 7)} ${row.message.split('\n', 1)[0] ?? ''}`.trim(),
          projectId: row.projectId,
          repositoryId: row.repositoryId,
          sessionId: row.sessionId,
          occurredAt: row.committedAt.toISOString(),
        });
      }
    }

    const prIds = idsOf('pull_request');
    if (prIds.length > 0) {
      const found = await this.#db
        .select({
          id: schema.pullRequests.id,
          number: schema.pullRequests.number,
          title: schema.pullRequests.title,
          repositoryId: schema.pullRequests.repositoryId,
          projectId: schema.repositories.projectId,
          updatedAt: schema.pullRequests.updatedAt,
        })
        .from(schema.pullRequests)
        .innerJoin(
          schema.repositories,
          eq(schema.repositories.id, schema.pullRequests.repositoryId),
        )
        .where(inArray(schema.pullRequests.id, prIds));
      for (const row of found) {
        meta.set(`pull_request:${row.id}`, {
          title: `#${String(row.number)} ${row.title}`,
          projectId: row.projectId,
          repositoryId: row.repositoryId,
          sessionId: null,
          occurredAt: row.updatedAt.toISOString(),
        });
      }
    }

    return meta;
  }
}

interface SourceMeta {
  readonly title: string;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly sessionId: string | null;
  readonly occurredAt: string | null;
}

/** A file-backed source has no row to look a title up in; its path is its name. */
function fallbackTitle(row: MemoryItemRow): string {
  if (row.sourceRef !== null) {
    const name = row.sourceRef.split('/').pop() ?? row.sourceRef;
    return name.replace(/\.md$/i, '');
  }
  return row.sourceType;
}

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MEMORY_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_MEMORY_SEARCH_LIMIT, Math.trunc(limit)));
}

/**
 * The filters one request becomes.
 *
 * Usually one. Two when a `projectId` is given without an explicit tier list, because
 * "this project's memory" means the project's chunks **plus** global ones, and the closed
 * filter ANDs across fields so a single `MemoryFilter` cannot express the OR. Two bounded
 * queries against a loopback store is a better trade than widening the filter vocabulary that
 * the in-memory fake has to implement exactly — see `vector-store-port.ts`.
 */
export function buildFilters(input: MemorySearchInput): readonly MemoryFilter[] {
  const shared: MemoryFilter = {
    ...(input.sourceTypes === undefined ? {} : { sourceTypes: input.sourceTypes }),
    ...(input.sessionId === undefined ? {} : { sessionIds: [input.sessionId] }),
  };

  if (input.sessionId !== undefined) {
    // A session-scoped query is the narrowest thing this API offers and it means exactly that.
    return [{ ...shared, tiers: ['session'] }];
  }

  const tiers = input.tiers ?? PRODUCIBLE_MEMORY_TIERS;

  if (input.projectId === undefined) {
    return [{ ...shared, tiers }];
  }

  const scopedTiers = tiers.filter((tier) => tier !== 'global');
  const filters: MemoryFilter[] = [];
  if (scopedTiers.length > 0) {
    filters.push({ ...shared, tiers: scopedTiers, projectIds: [input.projectId] });
  }
  if (tiers.includes('global')) {
    // Global memory belongs to no project, so `projectIds` cannot be applied to it — an
    // allowlist never matches a `null` payload field (`payloadMatchesFilter`). It is a separate
    // clause, not a widening of the first.
    filters.push({ ...shared, tiers: ['global'] });
  }
  return filters;
}
