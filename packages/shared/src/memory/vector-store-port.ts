/**
 * `VectorStorePort` — upsert, search-by-vector with filters, delete-by-filter.
 *
 * ## Why the filter is a closed shape rather than pass-through JSON
 *
 * The obvious design is to let callers hand Qdrant's own filter DSL straight through. It is
 * rejected here for one reason: **the in-memory fake could not then implement it**. A fake that
 * accepts arbitrary Qdrant JSON and honours a subset of it is worse than no fake at all — every
 * test it passes is evidence about the fake's subset, not about the query. `MemoryFilter` is
 * deliberately small, total, and implemented exactly by both adapters, so a retrieval test run
 * against the fake means something about production.
 *
 * It is also the visibility boundary. "May this caller see it" is answered by tier and scope
 * (`memory_items` header), and a filter that cannot express anything else cannot accidentally
 * be widened by a caller reaching for an escape hatch.
 *
 * ## What throws and what does not
 *
 * Unreachable, timed out, refused: **data** (`VectorStoreOutcome`), because those are states of
 * an operator's machine and the Services panel exists to report them.
 *
 * Stamp mismatch and vector-width mismatch: **throws** (`EmbeddingStampMismatchError`,
 * `VectorDimensionError`), because their entire danger is that they are otherwise invisible.
 * `memory/stamp.ts` sets out the reasoning.
 */

import type { MemorySourceType, MemoryTier } from '../entities/memory.js';
import type { EmbeddingVector } from './embedding-port.js';
import type { EmbeddingStamp } from './stamp.js';

/**
 * The payload stored on every point.
 *
 * It duplicates most of `memory_items`, and that is deliberate rather than sloppy: filtering
 * has to happen *inside* the vector search or it degrades into "fetch 10 000 candidates and
 * discard them in PostgreSQL". The relational row stays authoritative — this is a filter index,
 * and anything shown to a user is read back from `memory_items` by `memoryItemId`.
 */
export interface MemoryPointPayload {
  /**
   * Discriminates real chunks from any bookkeeping point a driver may need. Every search filters
   * on it, so a bookkeeping point can never surface as a search result.
   */
  readonly kind: 'chunk';
  /** `memory_items.id`. The handle everything user-visible is read through. */
  readonly memoryItemId: string;
  readonly tier: MemoryTier;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly sourceType: MemorySourceType;
  readonly sourceId: string | null;
  readonly sourceRef: string | null;
  readonly chunkOrdinal: number;
  /**
   * The stamp, per point.
   *
   * Redundant with the collection stamp *by design*: the collection stamp is the gate, this is
   * the audit trail. If a collection is ever adopted or repaired by hand, these fields are what
   * make it possible to tell which points are trustworthy without re-embedding everything.
   */
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
}

export interface MemoryPoint {
  /** UUID. Equals `memory_items.qdrant_point_id`. */
  readonly id: string;
  readonly vector: EmbeddingVector;
  readonly payload: MemoryPointPayload;
}

/**
 * The closed filter vocabulary. Every field is an OR within itself and an AND across fields —
 * "tier in (project, global) AND projectId in (X)" — which is the shape every retrieval query
 * this product has described so far actually needs.
 *
 * An omitted field means "no constraint". An **empty array** means "no value can match", and it
 * is honoured as written rather than treated as absent: silently widening an empty allowlist
 * into "everything" is how scope filters leak.
 */
export interface MemoryFilter {
  readonly tiers?: readonly MemoryTier[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
  readonly sessionIds?: readonly string[] | undefined;
  readonly agentIds?: readonly string[] | undefined;
  readonly sourceTypes?: readonly MemorySourceType[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly memoryItemIds?: readonly string[] | undefined;
  /** Rows produced by a model other than this one — the re-index / cleanup selector. */
  readonly embeddingModels?: readonly string[] | undefined;
}

export interface MemorySearchQuery {
  readonly vector: EmbeddingVector;
  readonly limit: number;
  readonly filter?: MemoryFilter | undefined;
  /**
   * Drop hits below this cosine score. Absent means "no floor".
   *
   * Worth setting for retrieval: a similarity search always returns its `limit`, however bad
   * the matches are, so an unfiltered top-5 over an unrelated corpus is five confident
   * irrelevancies. The floor is the caller's, not the store's, because what counts as "related"
   * is a property of the corpus.
   */
  readonly minScore?: number | undefined;
}

export interface MemorySearchHit {
  readonly id: string;
  /** Cosine similarity in `[-1, 1]`; higher is nearer. Results are sorted descending. */
  readonly score: number;
  readonly payload: MemoryPointPayload;
}

export interface MemoryUpsertResult {
  readonly upserted: number;
}

export interface MemoryDeleteResult {
  /** `null` when the driver reports success without a count (Qdrant does not return one). */
  readonly deleted: number | null;
}

export interface MemoryCollectionInfo {
  readonly name: string;
  readonly exists: boolean;
  readonly pointCount: number;
  /** What the collection says it was built with. `null` when it carries no stamp. */
  readonly stamp: EmbeddingStamp | null;
  readonly schemaVersion: number | null;
  /**
   * The dimension the store itself enforces (`config.params.vectors.size` in Qdrant). Present
   * even where the metadata stamp is not, which is why it is reported separately.
   */
  readonly vectorSize: number | null;
}

export interface MemoryEnsureResult {
  readonly created: boolean;
  /** True when an existing empty, unstamped collection was stamped in place. */
  readonly adopted: boolean;
  readonly info: MemoryCollectionInfo;
}

/**
 * Every operation's answer. One generic union rather than six bespoke ones: the failure arms
 * are identical for all of them, and six copies is six chances for one to grow a subtly
 * different `unreachable`.
 */
export type VectorStoreOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'not_configured'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'failed'; readonly status: number | null; readonly reason: string };

export interface VectorStoreCallOptions {
  readonly timeoutMs?: number | undefined;
}

export interface VectorStorePort {
  /** The collection this port reads and writes. One per instance. */
  readonly collection: string;

  /**
   * Create the collection stamped with `stamp`, or verify that an existing one agrees.
   *
   * **Must be called before `upsert` or `search`**, and the implementations enforce that rather
   * than trusting it — an unverified write is exactly the silent corruption this layer exists
   * to prevent. Throws `EmbeddingStampMismatchError` when the collection disagrees.
   */
  ensureCollection(
    stamp: EmbeddingStamp,
    options?: VectorStoreCallOptions,
  ): Promise<VectorStoreOutcome<MemoryEnsureResult>>;

  /** Read the collection's state without creating or changing anything. Never throws on stamp. */
  describeCollection(
    options?: VectorStoreCallOptions,
  ): Promise<VectorStoreOutcome<MemoryCollectionInfo>>;

  upsert(
    points: readonly MemoryPoint[],
    options?: VectorStoreCallOptions,
  ): Promise<VectorStoreOutcome<MemoryUpsertResult>>;

  search(
    query: MemorySearchQuery,
    options?: VectorStoreCallOptions,
  ): Promise<VectorStoreOutcome<readonly MemorySearchHit[]>>;

  /**
   * Delete every point matching `filter`.
   *
   * An **empty** filter (`{}`) is rejected rather than treated as "delete everything": a filter
   * built from an object whose fields all happened to be `undefined` is a plausible bug, and
   * the blast radius of getting it wrong is the entire index.
   */
  deleteByFilter(
    filter: MemoryFilter,
    options?: VectorStoreCallOptions,
  ): Promise<VectorStoreOutcome<MemoryDeleteResult>>;
}

/** True when a filter constrains nothing — the "would delete everything" case. */
export function isEmptyFilter(filter: MemoryFilter): boolean {
  return (
    filter.tiers === undefined &&
    filter.projectIds === undefined &&
    filter.sessionIds === undefined &&
    filter.agentIds === undefined &&
    filter.sourceTypes === undefined &&
    filter.sourceIds === undefined &&
    filter.memoryItemIds === undefined &&
    filter.embeddingModels === undefined
  );
}

/** Does one payload satisfy one filter? The single definition both stores agree on. */
export function payloadMatchesFilter(
  payload: MemoryPointPayload,
  filter: MemoryFilter | undefined,
): boolean {
  if (filter === undefined) return true;

  return (
    matches(filter.tiers, payload.tier) &&
    matches(filter.projectIds, payload.projectId) &&
    matches(filter.sessionIds, payload.sessionId) &&
    matches(filter.agentIds, payload.agentId) &&
    matches(filter.sourceTypes, payload.sourceType) &&
    matches(filter.sourceIds, payload.sourceId) &&
    matches(filter.memoryItemIds, payload.memoryItemId) &&
    matches(filter.embeddingModels, payload.embeddingModel)
  );
}

/**
 * An absent constraint admits everything; a present one admits only its members — including
 * the empty list, which admits nothing. `null` on the payload side never matches a constraint,
 * because "this memory belongs to no project" is not a member of any project allowlist.
 */
function matches<T extends string>(
  allowed: readonly T[] | undefined,
  value: string | null,
): boolean {
  if (allowed === undefined) return true;
  if (value === null) return false;
  return (allowed as readonly string[]).includes(value);
}

/** Describe a failure arm in one line — the text a health row's `detail` shows. */
export function describeVectorStoreFailure(
  outcome: Exclude<VectorStoreOutcome<unknown>, { kind: 'ok' }>,
): string {
  switch (outcome.kind) {
    case 'not_configured':
      return outcome.reason;
    case 'unreachable':
      return outcome.reason;
    case 'timeout':
      return `Timed out after ${String(outcome.timeoutMs)} ms`;
    default:
      return outcome.status === null
        ? outcome.reason
        : `${outcome.reason} (HTTP ${String(outcome.status)})`;
  }
}
