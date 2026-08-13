import type { EntityId, IsoTimestamp, MemorySourceType, MemoryTier } from '@mc/shared/types';

/**
 * The `/api/v1/memory-items/*` payloads (TDS 04 §13.1), hand-written against
 * `apps/backend/src/memory/retrieval.ts` and `indexing.ts`.
 *
 * They live in the feature slice rather than in `lib/api/types.ts` for the reason
 * `features/settings/types.ts` gives for the same choice: `openapi.yaml` is generated from the
 * Fastify *request* schemas, and these three routes declare none of their responses
 * (`x-mc-response-schema: undeclared`), so nothing can be generated for them yet. Keeping the
 * provisional copy here makes the seam obvious and stops a shape verified only by reading the
 * Backend from settling into the shared API-type surface.
 *
 * The **vocabulary** is never re-declared — `MemoryTier` and `MemorySourceType` come from
 * `@mc/shared/types` (F4.1), so a tier the Backend can store and this client cannot name is a
 * compile error rather than a memory an operator can write and never read back.
 */

/**
 * Why a search came back empty — `EmptyReason` in `retrieval.ts`, verbatim.
 *
 * The whole point of the enum is that these are **not one state**. `not_configured` is fixed in
 * Settings, `index_empty` by running a backfill, `below_threshold` by rephrasing or lowering the
 * floor, and `unavailable` / `stamp_mismatch` are not empty results at all — they are the index
 * being unable to answer. A screen that renders all five as "No results" sends the operator to
 * the wrong place four times out of five.
 */
export const MEMORY_EMPTY_REASONS = [
  'none',
  'not_configured',
  'unavailable',
  'stamp_mismatch',
  'index_empty',
  'below_threshold',
] as const;

export type MemoryEmptyReason = (typeof MEMORY_EMPTY_REASONS)[number];

/** The ids a result needs to be *reachable*, not merely displayable (`retrieval.ts` header). */
export interface MemoryResultContext {
  readonly projectId: EntityId | null;
  readonly repositoryId: EntityId | null;
  readonly sessionId: EntityId | null;
}

export interface MemorySearchResult {
  readonly memoryItemId: EntityId;
  /** Raw cosine similarity. Compressed by design — see `relevance.ts` for how it is shown. */
  readonly score: number;
  readonly tier: MemoryTier;
  readonly sourceType: MemorySourceType;
  /** `null` for file-backed sources, which are addressed by `sourceRef` instead. */
  readonly sourceId: EntityId | null;
  /** A vault-relative path for `obsidian_note` / `document`; `null` for row-backed sources. */
  readonly sourceRef: string | null;
  readonly title: string;
  /**
   * The chunk text. **Plain text — rendered as text, never as HTML, and never highlighted.**
   * A semantic match has no matched *terms*, so keyword-style `<mark>`s would tell the operator
   * the wrong story about why the chunk matched.
   */
  readonly content: string;
  readonly chunkOrdinal: number;
  readonly chunkCount: number;
  readonly occurredAt: IsoTimestamp | null;
  readonly context: MemoryResultContext;
}

export interface MemorySearchResponse {
  readonly results: readonly MemorySearchResult[];
  readonly emptyReason: MemoryEmptyReason;
  /** The Backend's own operator-facing sentence. Rendered verbatim; never paraphrased. */
  readonly detail: string | null;
  /** The floor this answer was produced under — the request's, or the Backend default. */
  readonly minScore: number;
  /** The model the query vector came from: the answer to "why did this match?". */
  readonly embeddingModel: string | null;
  /** Hits the store offered before the floor dropped them. Makes the floor visible. */
  readonly candidatesConsidered: number;
}

/** The request body of `POST /memory-items/search`. Unknown fields are a `400`, not a no-op. */
export interface MemorySearchRequest {
  readonly q: string;
  readonly limit?: number;
  readonly projectId?: EntityId;
  readonly sessionId?: EntityId;
  readonly tiers?: readonly MemoryTier[];
  readonly sourceTypes?: readonly MemorySourceType[];
  readonly minScore?: number;
}

// ------------------------------------------------------------------------------ index state

/** `BackfillProgress` (`@mc/shared/memory/backfill.ts`) as it arrives on the wire. */
export interface MemoryBackfillProgress {
  readonly stage: string | null;
  readonly cursor: string | null;
  readonly sourcesSeen: number;
  readonly sourcesIndexed: number;
  readonly sourcesSkipped: number;
  readonly chunksEmbedded: number;
  readonly chunksDeleted: number;
  readonly failures: number;
  readonly lastError: string | null;
  readonly pruned: number;
  readonly notesDone: boolean;
}

export const MEMORY_RUN_STATES = ['queued', 'running', 'completed', 'failed'] as const;
export type MemoryRunState = (typeof MEMORY_RUN_STATES)[number];

export type MemoryRunMode = 'incremental' | 'rebuild';

/** `GET /memory-items/backfill` — the active run, or the most recent one, plus index facts. */
export interface MemoryBackfillStatus {
  /** All-`null` when no run has ever happened. That is not the same as nothing being indexed. */
  readonly runId: EntityId | null;
  readonly state: string | null;
  readonly mode: MemoryRunMode | null;
  readonly trigger: string | null;
  readonly startedAt: IsoTimestamp | null;
  readonly completedAt: IsoTimestamp | null;
  readonly error: string | null;
  readonly progress: MemoryBackfillProgress | null;
  readonly summary: string | null;
  /**
   * Distinct `embedding_model` values present in `memory_items` — the answer to "is anything
   * indexed at all", and the model-change signal when it holds more than one name.
   */
  readonly indexedModels: readonly string[];
  /** Rows embedded by a model that is not the current one. They cannot answer a query. */
  readonly rowsFromOtherModels: number;
}

/** `POST /memory-items/backfill` -> `202`. */
export interface MemoryBackfillTrigger {
  readonly runId: EntityId;
  readonly state: string;
  readonly mode: MemoryRunMode;
  readonly createdAt: IsoTimestamp;
}

/** A run the Backend is still working on. `null`/`completed`/`failed` are all finished. */
export function isRunActive(state: string | null): boolean {
  return state === 'queued' || state === 'running';
}
