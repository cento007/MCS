/**
 * The embedding stamp — the one invariant this whole layer exists to protect.
 *
 * ## The failure mode
 *
 * **Vectors are only comparable within one embedding model.** If the configured model, or its
 * output dimension, ever changes, every vector already in the store becomes noise relative to
 * every new one. And the failure is *silent*: cosine distance is a total order over whatever
 * numbers it is given, so a query against mismatched vectors does not error — it returns a
 * ranked list of confident nonsense. An operator cannot tell that answer from a good one.
 *
 * That is worse than a crash. A crash is discovered in seconds by whoever caused it; silently
 * wrong retrieval is discovered months later, by someone who has been quietly making decisions
 * on it. So the design rule here is the opposite of the usual "degrade gracefully":
 *
 *   > A stamp disagreement is an **error**, raised before any write or query, naming both
 *   > values and what to do about it. It is never a warning, never a degraded result, and
 *   > never a silently-created second collection.
 *
 * Note the contrast with the rest of this layer, which is deliberate rather than inconsistent:
 * Qdrant being unreachable is *data* (`{ kind: 'unreachable' }`) because the operator can see
 * and fix it; a stamp mismatch is a *throw* because its whole danger is that nobody would see
 * it. Health probes catch this error and render it as a row — that is the one place it is
 * turned back into data, and it is turned into a red row, not a green one.
 *
 * ## Where the stamp is carried
 *
 * Three places, deliberately redundant, because each catches a different mistake:
 *
 *  1. **Qdrant collection metadata** (`config.metadata`, verified present on Qdrant 1.19).
 *     This is the authoritative model name — Qdrant has no other way to know what produced the
 *     numbers it stores.
 *  2. **`config.params.vectors.size`**, which Qdrant enforces itself on every upsert and query
 *     (`400 Wrong input: Vector dimension error: expected dim: 768, got 4`). This half of the
 *     stamp survives even on a Qdrant old enough to ignore collection metadata.
 *  3. **`memory_items.embedding_model` / `.embedding_dimension`**, per row, so a partial
 *     re-index has a work list and a straggler row is identifiable rather than merely wrong.
 */

/** What produced a vector. Two fields, because both can change and either change is fatal. */
export interface EmbeddingStamp {
  /** The model name exactly as configured, e.g. `nomic-embed-text`. Compared case-sensitively. */
  readonly model: string;
  /** Its output dimension, e.g. 768. */
  readonly dimension: number;
}

/**
 * Bumped when the *meaning* of a stored point changes in a way that makes old points
 * uninterpretable even under the same model — a payload field being repurposed, say. Carried
 * in the collection metadata alongside the stamp so that case is caught too.
 */
export const MEMORY_SCHEMA_VERSION = 1;

/** Collection-metadata keys. Namespaced so a shared Qdrant instance stays unambiguous. */
export const STAMP_METADATA_KEYS = Object.freeze({
  schemaVersion: 'mc.schemaVersion',
  model: 'mc.embeddingModel',
  dimension: 'mc.embeddingDimension',
  stampedAt: 'mc.stampedAt',
});

export function stampsEqual(a: EmbeddingStamp, b: EmbeddingStamp): boolean {
  return a.model === b.model && a.dimension === b.dimension;
}

export function formatStamp(stamp: EmbeddingStamp): string {
  return `${stamp.model} (${stamp.dimension}d)`;
}

/** Which half of the stamp disagreed. Both can be wrong at once; `model` is reported first. */
export type StampMismatchKind = 'model' | 'dimension' | 'schema_version' | 'unstamped';

export interface StampMismatchDetail {
  readonly kind: StampMismatchKind;
  readonly collection: string;
  /** What settings say the embedder is, right now. */
  readonly expected: EmbeddingStamp;
  /** What the collection says it was built with. `null` when the collection carries no stamp. */
  readonly found: EmbeddingStamp | null;
  readonly expectedSchemaVersion: number;
  readonly foundSchemaVersion: number | null;
}

/**
 * Raised instead of writing or querying vectors that cannot be compared.
 *
 * The message is written for the operator who will read it in a log line or a health row, and
 * it names three things: what was configured, what is stored, and the two ways out. Anything
 * less turns into a support question, because "stamp mismatch" alone does not tell anyone
 * whether they should change the setting back or re-index.
 */
export class EmbeddingStampMismatchError extends Error {
  readonly detail: StampMismatchDetail;

  constructor(detail: StampMismatchDetail) {
    super(describeMismatch(detail));
    this.name = 'EmbeddingStampMismatchError';
    this.detail = detail;
  }
}

function describeMismatch(detail: StampMismatchDetail): string {
  const { collection, expected, found } = detail;
  const remedy =
    `Either restore the previous setting (${found === null ? 'unknown' : formatStamp(found)}) ` +
    `or re-index: delete the "${collection}" collection and let Mission Control rebuild it ` +
    'under the new model. Vectors from two different models are not comparable, so serving ' +
    'this query would return confident nonsense rather than an error.';

  switch (detail.kind) {
    case 'unstamped':
      return (
        `The Qdrant collection "${collection}" carries no Mission Control stamp and already ` +
        `holds points, so there is no way to tell which embedding model produced them. ` +
        `Settings currently name ${formatStamp(expected)}. ${remedy}`
      );
    case 'schema_version':
      return (
        `The Qdrant collection "${collection}" was written under memory schema version ` +
        `${String(detail.foundSchemaVersion)}; this build writes version ` +
        `${String(detail.expectedSchemaVersion)}. ${remedy}`
      );
    case 'dimension':
      return (
        `Embedding dimension mismatch on the Qdrant collection "${collection}": it was created ` +
        `for ${String(found?.dimension)} dimensions and settings now name ` +
        `${formatStamp(expected)}, which produces ${String(expected.dimension)}. ${remedy}`
      );
    default:
      return (
        `Embedding model mismatch on the Qdrant collection "${collection}": it was stamped ` +
        `${found === null ? 'unknown' : formatStamp(found)} and settings now name ` +
        `${formatStamp(expected)}. ${remedy}`
      );
  }
}

export interface VerifyStampInput {
  readonly collection: string;
  readonly expected: EmbeddingStamp;
  /** What was read off the collection. `null` when it carries no metadata stamp. */
  readonly found: EmbeddingStamp | null;
  readonly foundSchemaVersion: number | null;
  /**
   * Whether the collection already holds points. An **empty** unstamped collection is adopted
   * (stamped in place) rather than refused: nothing in it can be wrong, and refusing would
   * strand an operator who created the collection by hand with no way forward but deletion.
   * A non-empty unstamped collection is refused, because its contents are unknowable.
   */
  readonly hasPoints: boolean;
}

export type StampVerdict =
  | { readonly kind: 'match' }
  /** Empty and unstamped: safe to stamp in place and use. */
  | { readonly kind: 'adoptable' };

/**
 * Compare a collection's stamp with the configured one, or throw.
 *
 * Pure and total — no I/O, no clock — which is what makes every branch of the most
 * consequential decision in this layer a two-line unit test.
 */
export function verifyStamp(input: VerifyStampInput): StampVerdict {
  const { collection, expected, found, foundSchemaVersion, hasPoints } = input;

  if (found === null) {
    if (!hasPoints) return { kind: 'adoptable' };
    throw new EmbeddingStampMismatchError({
      kind: 'unstamped',
      collection,
      expected,
      found: null,
      expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
      foundSchemaVersion,
    });
  }

  // Model first: it is the failure an operator actually causes, by editing one settings field.
  if (found.model !== expected.model) {
    throw new EmbeddingStampMismatchError({
      kind: 'model',
      collection,
      expected,
      found,
      expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
      foundSchemaVersion,
    });
  }

  if (found.dimension !== expected.dimension) {
    throw new EmbeddingStampMismatchError({
      kind: 'dimension',
      collection,
      expected,
      found,
      expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
      foundSchemaVersion,
    });
  }

  if (foundSchemaVersion !== null && foundSchemaVersion !== MEMORY_SCHEMA_VERSION) {
    throw new EmbeddingStampMismatchError({
      kind: 'schema_version',
      collection,
      expected,
      found,
      expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
      foundSchemaVersion,
    });
  }

  return { kind: 'match' };
}

/**
 * Raised when a vector's length disagrees with the verified stamp, *before* it reaches the
 * network.
 *
 * Qdrant would catch this too (`400 … expected dim: 768, got 4`), and a local check is still
 * worth having: it names the memory item rather than the batch, it costs nothing, and it holds
 * for the in-memory store as well — which has no server to refuse on its behalf and would
 * otherwise happily compute a cosine over two vectors of different lengths.
 */
export class VectorDimensionError extends Error {
  readonly expected: number;
  readonly actual: number;
  readonly pointId: string | null;

  constructor(input: { expected: number; actual: number; pointId?: string | null }) {
    super(
      `Vector dimension mismatch${input.pointId == null ? '' : ` for point ${input.pointId}`}: ` +
        `the collection holds ${String(input.expected)}-dimensional vectors and this one has ` +
        `${String(input.actual)}. The embedder and the collection disagree — re-check ` +
        '`integrations.qdrant.embeddingModel` and re-index if it changed.',
    );
    this.name = 'VectorDimensionError';
    this.expected = input.expected;
    this.actual = input.actual;
    this.pointId = input.pointId ?? null;
  }
}

/** Guard a single vector against the verified dimension. Throws `VectorDimensionError`. */
export function assertVectorDimension(
  vector: readonly number[],
  expected: number,
  pointId?: string | null,
): void {
  if (vector.length !== expected) {
    throw new VectorDimensionError({
      expected,
      actual: vector.length,
      pointId: pointId ?? null,
    });
  }
}
