/**
 * The in-memory `VectorStorePort` — what retrieval logic is tested against.
 *
 * It is a **fake**, not a mock: it does the real thing on a smaller substrate. Cosine
 * similarity is computed properly, filters are applied with the same shared predicate the
 * Qdrant adapter's translation is checked against, ranking is a real sort, and the stamp gate
 * is the same `verifyStamp` the real adapter calls. A test that says "a near-duplicate outranks
 * a loose match" is therefore testing arithmetic that would give the same answer in Qdrant,
 * rather than a stub that returns whatever the test told it to.
 *
 * Two things it deliberately does not have, and both absences are the point:
 *
 *   - **No approximation.** Qdrant's HNSW index is approximate; this is exhaustive. For a test
 *     corpus of a few dozen points that difference is invisible, and exhaustive means a ranking
 *     assertion is a statement about the vectors rather than about an index's recall.
 *   - **No network, no install, no persistence.** `pnpm test` must be green on a machine with
 *     nothing installed, so this is what the unit tier binds to.
 *
 * The failure arms are reachable: `failWith` makes the store answer `unreachable`, `timeout` or
 * `failed` on demand, so the "a broken dependency is data" path is exercised without unplugging
 * anything.
 */

import { cosineSimilarity } from './embedding-port.js';
import {
  assertVectorDimension,
  type EmbeddingStamp,
  MEMORY_SCHEMA_VERSION,
  verifyStamp,
} from './stamp.js';
import {
  isEmptyFilter,
  type MemoryCollectionInfo,
  type MemoryDeleteResult,
  type MemoryEnsureResult,
  type MemoryFilter,
  type MemoryPoint,
  type MemorySearchHit,
  type MemorySearchQuery,
  type MemoryUpsertResult,
  payloadMatchesFilter,
  type VectorStoreOutcome,
  type VectorStorePort,
} from './vector-store-port.js';

export const DEFAULT_TEST_COLLECTION = 'mc_memory_test';

/** Every non-`ok` arm, as something a test can hand the store to make it answer that way. */
export type InMemoryStoreFailure = Exclude<VectorStoreOutcome<never>, { kind: 'ok' }>;

export interface InMemoryVectorStoreOptions {
  readonly collection?: string;
  /**
   * Pre-stamp the collection as if it already existed — the "an operator changed the model"
   * fixture. Without it the store starts with no collection at all, and `ensureCollection`
   * creates one.
   */
  readonly existingStamp?: EmbeddingStamp | undefined;
  /** Points already present, used with `existingStamp` to make an unstamped store non-empty. */
  readonly existingPointCount?: number | undefined;
  readonly existingSchemaVersion?: number | null | undefined;
}

export interface InMemoryVectorStore extends VectorStorePort {
  /** Every stored point, insertion-ordered. Read-only view for assertions. */
  readonly points: readonly MemoryPoint[];
  /** Make every subsequent call answer with this failure, or `null` to stop. */
  failWith(failure: InMemoryStoreFailure | null): void;
  /** Calls made, by method name — proves `ensureCollection` really gates the others. */
  readonly calls: readonly string[];
  reset(): void;
}

export function createInMemoryVectorStore(
  options: InMemoryVectorStoreOptions = {},
): InMemoryVectorStore {
  const collection = options.collection ?? DEFAULT_TEST_COLLECTION;

  let stored = new Map<string, MemoryPoint>();
  let collectionStamp: EmbeddingStamp | null = options.existingStamp ?? null;
  let schemaVersion: number | null =
    options.existingSchemaVersion === undefined
      ? options.existingStamp === undefined
        ? null
        : MEMORY_SCHEMA_VERSION
      : options.existingSchemaVersion;
  let exists = options.existingStamp !== undefined || (options.existingPointCount ?? 0) > 0;
  let phantomPoints = options.existingPointCount ?? 0;
  /** Set by `ensureCollection`; nothing may write or query before it is. */
  let verified: EmbeddingStamp | null = null;
  let failure: InMemoryStoreFailure | null = null;
  const calls: string[] = [];

  function pointCount(): number {
    return stored.size + phantomPoints;
  }

  function info(): MemoryCollectionInfo {
    return {
      name: collection,
      exists,
      pointCount: pointCount(),
      stamp: collectionStamp,
      schemaVersion,
      vectorSize: collectionStamp?.dimension ?? null,
    };
  }

  /**
   * The gate. Not a courtesy check — an upsert or a search that skipped `ensureCollection` is
   * exactly the unverified-write case this layer exists to make impossible, and the Qdrant
   * adapter enforces the same rule, so the fake must too or a test would pass against one and
   * fail against the other.
   */
  function requireVerified(): EmbeddingStamp {
    if (verified === null) {
      throw new Error(
        `The "${collection}" collection has not been verified in this process. Call ` +
          'ensureCollection() before writing or querying: an unverified write can silently ' +
          'mix vectors from two different embedding models.',
      );
    }
    return verified;
  }

  return {
    collection,

    get points(): readonly MemoryPoint[] {
      return [...stored.values()];
    },

    get calls(): readonly string[] {
      return calls;
    },

    failWith(next): void {
      failure = next;
    },

    reset(): void {
      stored = new Map();
      collectionStamp = options.existingStamp ?? null;
      schemaVersion = options.existingStamp === undefined ? null : MEMORY_SCHEMA_VERSION;
      exists = options.existingStamp !== undefined;
      phantomPoints = options.existingPointCount ?? 0;
      verified = null;
      failure = null;
      calls.length = 0;
    },

    async ensureCollection(stamp): Promise<VectorStoreOutcome<MemoryEnsureResult>> {
      calls.push('ensureCollection');
      if (failure !== null) return failure;

      if (!exists) {
        collectionStamp = { ...stamp };
        schemaVersion = MEMORY_SCHEMA_VERSION;
        exists = true;
        verified = collectionStamp;
        return { kind: 'ok', value: { created: true, adopted: false, info: info() } };
      }

      // Throws `EmbeddingStampMismatchError` on disagreement — deliberately not an outcome arm.
      const verdict = verifyStamp({
        collection,
        expected: stamp,
        found: collectionStamp,
        foundSchemaVersion: schemaVersion,
        hasPoints: pointCount() > 0,
      });

      if (verdict.kind === 'adoptable') {
        collectionStamp = { ...stamp };
        schemaVersion = MEMORY_SCHEMA_VERSION;
        verified = collectionStamp;
        return { kind: 'ok', value: { created: false, adopted: true, info: info() } };
      }

      verified = collectionStamp;
      return { kind: 'ok', value: { created: false, adopted: false, info: info() } };
    },

    async describeCollection(): Promise<VectorStoreOutcome<MemoryCollectionInfo>> {
      calls.push('describeCollection');
      if (failure !== null) return failure;
      return { kind: 'ok', value: info() };
    },

    async upsert(points): Promise<VectorStoreOutcome<MemoryUpsertResult>> {
      calls.push('upsert');
      if (failure !== null) return failure;

      const stamp = requireVerified();
      // Checked before anything is stored, so a bad batch is rejected whole rather than
      // half-applied. Qdrant behaves the same way (it rejects the request, not the point).
      for (const point of points) {
        assertVectorDimension(point.vector, stamp.dimension, point.id);
      }

      for (const point of points) {
        stored.set(point.id, { ...point, vector: [...point.vector] });
      }
      return { kind: 'ok', value: { upserted: points.length } };
    },

    async search(
      query: MemorySearchQuery,
    ): Promise<VectorStoreOutcome<readonly MemorySearchHit[]>> {
      calls.push('search');
      if (failure !== null) return failure;

      const stamp = requireVerified();
      assertVectorDimension(query.vector, stamp.dimension);

      const hits: MemorySearchHit[] = [];
      for (const point of stored.values()) {
        if (point.payload.kind !== 'chunk') continue;
        if (!payloadMatchesFilter(point.payload, query.filter)) continue;

        const score = cosineSimilarity(query.vector, point.vector);
        if (query.minScore !== undefined && score < query.minScore) continue;
        hits.push({ id: point.id, score, payload: point.payload });
      }

      // Descending by score; ties broken by id so the order is total and a test cannot pass
      // on one platform's Map iteration order and fail on another's.
      hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      return { kind: 'ok', value: hits.slice(0, Math.max(0, query.limit)) };
    },

    async deleteByFilter(filter: MemoryFilter): Promise<VectorStoreOutcome<MemoryDeleteResult>> {
      calls.push('deleteByFilter');
      if (failure !== null) return failure;
      requireVerified();

      if (isEmptyFilter(filter)) {
        return {
          kind: 'failed',
          status: null,
          reason:
            'Refusing to delete with an empty filter — that would erase the whole index. ' +
            'Name at least one tier, project, session, source or model.',
        };
      }

      let deleted = 0;
      for (const [id, point] of [...stored.entries()]) {
        if (!payloadMatchesFilter(point.payload, filter)) continue;
        stored.delete(id);
        deleted += 1;
      }
      return { kind: 'ok', value: { deleted } };
    },
  };
}
