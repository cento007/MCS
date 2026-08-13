/**
 * The indexer — one source in, a consistent pair of stores out.
 *
 * It is the only thing in this codebase that writes vectors, and it exists to keep two
 * guarantees that are easy to state and easy to lose:
 *
 *  1. **Re-indexing unchanged content writes nothing and embeds nothing.**
 *  2. **Content that changed or went away stops answering queries.**
 *
 * ## Why (1) is not an optimisation
 *
 * Embedding is the expensive half of ingestion by two orders of magnitude: a chunk costs ~6 ms
 * of model time in a warm batch and ~0.05 ms of PostgreSQL. A backfill over a few thousand
 * sources that re-embeds everything it has already seen is not "slower" — it is the difference
 * between a backfill an operator runs and one they cancel. And the second run of a backfill is
 * the *common* case: the job is resumable, the poller re-enqueues, a settings change re-primes.
 *
 * So the diff is per **chunk**, not per source, and it is keyed on `content_hash`. A Session
 * that gained one turn re-embeds one chunk, not four hundred. The check is
 * `hash matches AND indexed_at IS NOT NULL` — the second half matters because a row whose
 * vector never landed must not be mistaken for one that is already searchable.
 *
 * ## Write order, and the two crash windows
 *
 * ```
 *   embed changed+new  ->  upsert points  ->  [tx] upsert rows, delete removed rows  ->  delete removed points
 * ```
 *
 * **Vectors before rows.** The point id is derived from `(source, ordinal, model)` (`store.ts`),
 * so a crash after the upsert and before the commit leaves a point that the next run computes
 * the same id for and overwrites. Nothing is stranded. The reverse order — row first — would
 * leave a row marked `indexed_at` with no vector behind it, which is invisible at query time and
 * self-perpetuating, because the very hash check above would then skip it forever.
 *
 * **Rows before removals.** A crash there leaves an orphan point, which cannot answer a query:
 * retrieval hydrates every hit from `memory_items` and drops a hit with no row. `pruneOrphans`
 * clears them at the next full backfill.
 *
 * ## What is *not* here
 *
 * No queue, no HTTP, no settings. This module takes a `Db`, an `EmbeddingPort`, a
 * `VectorStorePort` and a projection, and returns a value. That is what makes the whole of it
 * testable against `createFakeEmbedder` + `createInMemoryVectorStore` with no database mock and
 * no network — and it is why the Backend's job handler is thirty lines.
 */

import type { Db } from '../db/index.js';
import { type ChunkBudget, chunkText, type TextChunk } from './chunk.js';
import {
  describeEmbeddingFailure,
  type EmbeddingFailure,
  type EmbeddingPort,
} from './embedding-port.js';
import type { SourceProjection } from './projection.js';
import type { EmbeddingStamp } from './stamp.js';
import {
  deleteMemoryItemsByIds,
  deleteSourceRows,
  derivePointId,
  hashChunk,
  newMemoryItemId,
  readSourceRows,
  type SourceKey,
  upsertMemoryItem,
} from './store.js';
import {
  describeVectorStoreFailure,
  type MemoryPoint,
  type VectorStoreOutcome,
  type VectorStorePort,
} from './vector-store-port.js';

/**
 * What happened to one source. **Every arm is data** — the caller records it on a run row and
 * carries on with the next source, because one unreachable Ollama must not abort a backfill
 * that has already done four hundred sources of work.
 */
export type IndexOutcome =
  | {
      readonly kind: 'indexed';
      readonly chunks: number;
      /** Chunks that actually cost an embedding call. `0` with `chunks > 0` means "unchanged". */
      readonly embedded: number;
      readonly deleted: number;
      /** True when `maxChunks` cut the source short. Recorded, never silent. */
      readonly truncated: boolean;
    }
  /** The projection produced no text worth indexing (an empty ADR, a session with no turns). */
  | { readonly kind: 'skipped'; readonly reason: string }
  | {
      readonly kind: 'embedder_failed';
      readonly failure: EmbeddingFailure;
      readonly reason: string;
    }
  | {
      readonly kind: 'store_failed';
      readonly failure: Exclude<VectorStoreOutcome<never>, { kind: 'ok' }>;
      readonly reason: string;
    };

export interface IndexSourceOptions {
  readonly db: Db;
  readonly embedder: EmbeddingPort;
  readonly store: VectorStorePort;
  /** The verified stamp. `ensureCollection` must have succeeded before anything here runs. */
  readonly stamp: EmbeddingStamp;
  readonly budget: ChunkBudget;
  readonly projection: SourceProjection;
  readonly maxChunks?: number | undefined;
  /** Injectable clock so `indexed_at` is assertable without freezing the machine's. */
  readonly now?: (() => Date) | undefined;
}

/** Index (or re-index, or no-op) one source. Never throws for a dependency failure. */
export async function indexSource(options: IndexSourceOptions): Promise<IndexOutcome> {
  const { db, embedder, store, stamp, projection } = options;
  const now = options.now ?? (() => new Date());

  const key: SourceKey = {
    sourceType: projection.sourceType,
    sourceId: projection.sourceId,
    sourceRef: projection.sourceRef,
  };

  const text = projection.text.trim();
  const existing = await readSourceRows(db, key, stamp.model);

  if (text.length === 0) {
    // A source that used to have text and now has none is a *removal*, not a skip: an ADR
    // emptied out must stop answering queries with what it used to say.
    if (existing.length === 0) return { kind: 'skipped', reason: 'nothing to index' };
    const removed = await removeRows(
      options,
      existing.map((row) => row.id),
    );
    if (removed !== null) return removed;
    return { kind: 'indexed', chunks: 0, embedded: 0, deleted: existing.length, truncated: false };
  }

  const { chunks, truncated } = chunkText(text, {
    budget: options.budget,
    ...(options.maxChunks === undefined ? {} : { maxChunks: options.maxChunks }),
  });

  const byOrdinal = new Map(existing.map((row) => [row.chunkOrdinal, row]));
  const plan = planChunks(chunks, byOrdinal, key, stamp.model);
  const removedIds = [...byOrdinal.values()]
    .filter((row) => row.chunkOrdinal >= chunks.length)
    .map((row) => row.id);

  // The whole point of the hash diff: an unchanged source costs one SELECT and stops here,
  // before the model is woken at all.
  if (plan.pending.length === 0 && removedIds.length === 0) {
    return { kind: 'indexed', chunks: chunks.length, embedded: 0, deleted: 0, truncated };
  }

  let points: MemoryPoint[] = [];
  if (plan.pending.length > 0) {
    const embedded = await embedder.embed(plan.pending.map((entry) => entry.chunk.text));
    if (embedded.kind !== 'ok') {
      return {
        kind: 'embedder_failed',
        failure: embedded,
        reason: describeEmbeddingFailure(embedded),
      };
    }

    // A mid-run model swap would produce comparable-looking vectors that are not comparable.
    // The stamp gate caught it at `ensureCollection`; this catches it between two batches.
    if (embedded.stamp.model !== stamp.model || embedded.stamp.dimension !== stamp.dimension) {
      return {
        kind: 'embedder_failed',
        failure: {
          kind: 'failed',
          status: null,
          reason: `The embedder now reports ${embedded.stamp.model} (${String(embedded.stamp.dimension)}d) but this run is stamped ${stamp.model} (${String(stamp.dimension)}d).`,
        },
        reason: 'the embedding model changed mid-run',
      };
    }

    points = plan.pending.map((entry, index) => ({
      id: entry.pointId,
      vector: embedded.vectors[index] ?? [],
      payload: {
        kind: 'chunk' as const,
        memoryItemId: entry.id,
        tier: projection.tier,
        projectId: projection.projectId,
        sessionId: projection.sessionId,
        agentId: null,
        sourceType: projection.sourceType,
        sourceId: projection.sourceId,
        sourceRef: projection.sourceRef,
        chunkOrdinal: entry.chunk.ordinal,
        embeddingModel: stamp.model,
        embeddingDimension: stamp.dimension,
      },
    }));

    const upserted = await store.upsert(points);
    if (upserted.kind !== 'ok') {
      return {
        kind: 'store_failed',
        failure: upserted,
        reason: describeVectorStoreFailure(upserted),
      };
    }
  }

  const at = now();
  await db.transaction(async (tx) => {
    for (const entry of plan.pending) {
      await upsertMemoryItem(tx, {
        id: entry.id,
        tier: projection.tier,
        projectId: projection.projectId,
        sessionId: projection.sessionId,
        sourceType: projection.sourceType,
        sourceId: projection.sourceId,
        sourceRef: projection.sourceRef,
        chunkOrdinal: entry.chunk.ordinal,
        content: entry.chunk.text,
        contentHash: entry.hash,
        embeddingModel: stamp.model,
        embeddingDimension: stamp.dimension,
        qdrantPointId: entry.pointId,
        indexedAt: at,
      });
    }
    await deleteMemoryItemsByIds(tx, removedIds);
  });

  if (removedIds.length > 0) {
    const dropped = await store.deleteByFilter({ memoryItemIds: removedIds });
    if (dropped.kind !== 'ok') {
      // The rows are already gone, so these points can no longer answer anything (retrieval
      // hydrates by `memoryItemId`). Reported so the operator sees it; not retried, because
      // `pruneOrphans` is the sweep that owns exactly this case.
      return {
        kind: 'store_failed',
        failure: dropped,
        reason: describeVectorStoreFailure(dropped),
      };
    }
  }

  return {
    kind: 'indexed',
    chunks: chunks.length,
    embedded: plan.pending.length,
    deleted: removedIds.length,
    truncated,
  };
}

export interface PendingChunk {
  readonly chunk: TextChunk;
  readonly hash: string;
  /** The existing row's id when this is a re-embed, a fresh UUIDv7 when it is new. */
  readonly id: string;
  readonly pointId: string;
}

export interface ChunkPlan {
  readonly pending: readonly PendingChunk[];
}

/** The subset of a stored row the diff actually consults. */
export interface StoredChunkState {
  readonly id: string;
  readonly contentHash: string;
  readonly indexedAt: Date | null;
}

/**
 * Decide which chunks need work, given what is already stored.
 *
 * Exported and pure so the "unchanged costs nothing" claim is a unit test over a map, rather
 * than an assertion about how many times a fake happened to be called.
 *
 * `indexedAt === null` forces a re-embed even when the hash matches: that row's vector never
 * landed, and treating it as done is how a chunk disappears from search permanently.
 */
export function planChunks(
  chunks: readonly TextChunk[],
  byOrdinal: ReadonlyMap<number, StoredChunkState>,
  key: SourceKey,
  embeddingModel: string,
): ChunkPlan {
  const pending: PendingChunk[] = [];

  for (const chunk of chunks) {
    const hash = hashChunk(chunk.text);
    const row = byOrdinal.get(chunk.ordinal);
    if (row !== undefined && row.contentHash === hash && row.indexedAt !== null) continue;
    pending.push({
      chunk,
      hash,
      id: row?.id ?? newMemoryItemId(),
      pointId: derivePointId(key, chunk.ordinal, embeddingModel),
    });
  }

  return { pending };
}

/** Delete rows then points — see the header for why that order and not the other. */
async function removeRows(
  options: IndexSourceOptions,
  ids: readonly string[],
): Promise<IndexOutcome | null> {
  if (ids.length === 0) return null;

  await options.db.transaction(async (tx) => {
    await deleteMemoryItemsByIds(tx, ids);
  });

  const dropped = await options.store.deleteByFilter({ memoryItemIds: [...ids] });
  if (dropped.kind !== 'ok') {
    return { kind: 'store_failed', failure: dropped, reason: describeVectorStoreFailure(dropped) };
  }
  return null;
}

/**
 * Purge one source outright — the archive / delete path.
 *
 * Not "index it with empty text": that would leave the decision about *whether* a source should
 * be forgotten inside the projection, where it is invisible. Purging is a separate verb because
 * it is a separate intent.
 */
export async function purgeSource(options: {
  readonly db: Db;
  readonly store: VectorStorePort;
  readonly key: SourceKey;
}): Promise<{ readonly deleted: number; readonly storeFailure: string | null }> {
  const ids = await options.db.transaction(async (tx) => deleteSourceRows(tx, options.key));
  if (ids.length === 0) return { deleted: 0, storeFailure: null };

  const dropped = await options.store.deleteByFilter({ memoryItemIds: ids });
  return {
    deleted: ids.length,
    storeFailure: dropped.kind === 'ok' ? null : describeVectorStoreFailure(dropped),
  };
}
