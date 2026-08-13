/**
 * The Qdrant `VectorStorePort` adapter.
 *
 * Verified against a real **Qdrant 1.19.0** (native Windows binary, no Docker — F1 forbids it)
 * rather than written from documentation. The behaviours that shaped this file:
 *
 * ## Collection metadata is where the stamp lives
 *
 *     PUT /collections/{name}
 *     {"vectors":{"size":768,"distance":"Cosine"},"metadata":{"mc.embeddingModel":"…", …}}
 *
 *     GET /collections/{name}  ->  result.config.metadata  (returned verbatim)
 *
 * Qdrant 1.15+ carries arbitrary collection metadata and reports it under `config.metadata`;
 * `PATCH /collections/{name}` with a `metadata` object updates it. That is the natural home for
 * the model name — Qdrant has no other way to know what produced the numbers it stores — and it
 * beats the alternatives (a sentinel point needing a fake vector, or a model-derived collection
 * name that would silently create a *second* collection on a model change instead of refusing).
 *
 * **Caution, and it is why `describeCollection` reports `vectorSize` separately:** Qdrant
 * silently ignores unknown fields in a create body. An older build would accept the `metadata`
 * key, store nothing, and return a collection with no stamp — which would look identical to a
 * hand-created one. The dimension half of the stamp survives that, because Qdrant enforces
 * `config.params.vectors.size` itself on every request:
 *
 *     PUT /collections/{n}/points  (6-dim vector into a 4-dim collection)
 *     -> 400 {"status":{"error":"Wrong input: Vector dimension error: expected dim: 4, got 6"}}
 *
 * ## Response shapes
 *
 * Success is `{"result": …, "status":"ok", "time":…}`; failure is
 * `{"status":{"error":"…"}, "time":…}` — note `status` changes type between the two, so the
 * error is read out of the object form only.
 *
 * `POST /points/query` (Qdrant ≥ 1.10) answers `{"result":{"points":[…]}}`; the older
 * `POST /points/search` answers `{"result":[…]}`. Both are read, the modern one preferred, so a
 * slightly older server still works.
 *
 * ## The API key
 *
 * Sent as the `api-key` header, never in a URL and never in a query string. Every string this
 * module can return — including a transport error's own words — goes through `redactSecret`
 * before it leaves. A test scans serialized output for the key.
 */

import { redactSecret } from '../crypto/redact.js';
import {
  createMemoryHttpPort,
  type MemoryHttpOutcome,
  type MemoryHttpPort,
  parseJsonObject,
  withMemoryTimeout,
} from './http.js';
import {
  assertVectorDimension,
  type EmbeddingStamp,
  MEMORY_SCHEMA_VERSION,
  STAMP_METADATA_KEYS,
  verifyStamp,
} from './stamp.js';
import {
  isEmptyFilter,
  type MemoryCollectionInfo,
  type MemoryDeleteResult,
  type MemoryEnsureResult,
  type MemoryFilter,
  type MemoryPoint,
  type MemoryPointPayload,
  type MemorySearchHit,
  type MemorySearchQuery,
  type MemoryUpsertResult,
  type VectorStoreCallOptions,
  type VectorStoreOutcome,
  type VectorStorePort,
} from './vector-store-port.js';

/**
 * A loopback Qdrant answers every request this adapter makes in single-digit milliseconds
 * (measured: create 214 ms cold, upsert 10 ms, search 8 ms, delete 4 ms). 10 s leaves room for
 * a cold start and a large upsert batch while keeping a stalled socket from holding anything
 * open — the Services panel bounds its own probes tighter still.
 */
export const QDRANT_TIMEOUT_MS = 10_000;

/** The default collection name. One collection, payload-filtered by tier (see `ensureCollection`). */
export const DEFAULT_MEMORY_COLLECTION = 'mc_memory';

/**
 * Cosine, because the whole layer's vocabulary is cosine similarity and Qdrant's `Cosine`
 * distance returns exactly that in `[-1, 1]` — no conversion, so a score in a test means the
 * same number as a score in production.
 */
const DISTANCE = 'Cosine';

export interface QdrantStoreOptions {
  readonly host: string;
  readonly port: number;
  /** Read through the settings service. Never logged, never serialized. */
  readonly apiKey?: string | null | undefined;
  readonly collection?: string | undefined;
  /** Injected in tests; defaults to the real bounded `fetch` transport. */
  readonly http?: MemoryHttpPort | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createQdrantVectorStore(options: QdrantStoreOptions): VectorStorePort {
  const http = options.http ?? createMemoryHttpPort();
  const baseUrl = qdrantBaseUrl(options.host, options.port);
  const collection = options.collection ?? DEFAULT_MEMORY_COLLECTION;
  const apiKey = options.apiKey ?? null;
  const defaultTimeoutMs = options.timeoutMs ?? QDRANT_TIMEOUT_MS;

  /** Set by `ensureCollection`; nothing writes or queries before it is. */
  let verified: EmbeddingStamp | null = null;
  /** `null` until the modern query endpoint is known to exist or not. */
  let modernQuerySupported: boolean | null = null;

  const redact = (text: string): string => redactSecret(text, apiKey);

  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<QdrantResult> {
    const outcome = await withMemoryTimeout(
      http({
        url: `${baseUrl}${path}`,
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          // The credential, as a header. Never a URL component: transport errors quote URLs.
          ...(apiKey === null ? {} : { 'api-key': apiKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        timeoutMs,
      }),
      timeoutMs,
      { kind: 'timeout' as const },
    );

    return interpret(outcome, timeoutMs, baseUrl, redact);
  }

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

  async function readInfo(timeoutMs: number): Promise<VectorStoreOutcome<MemoryCollectionInfo>> {
    const result = await call(
      'GET',
      `/collections/${encodeURIComponent(collection)}`,
      undefined,
      timeoutMs,
    );

    if (result.kind === 'http' && result.status === 404) {
      return {
        kind: 'ok',
        value: {
          name: collection,
          exists: false,
          pointCount: 0,
          stamp: null,
          schemaVersion: null,
          vectorSize: null,
        },
      };
    }
    if (result.kind !== 'ok') return result.outcome;

    return { kind: 'ok', value: readCollectionInfo(collection, result.body) };
  }

  return {
    collection,

    async ensureCollection(
      stamp: EmbeddingStamp,
      callOptions?: VectorStoreCallOptions,
    ): Promise<VectorStoreOutcome<MemoryEnsureResult>> {
      const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs;

      const described = await readInfo(timeoutMs);
      if (described.kind !== 'ok') return described;
      const info = described.value;

      if (!info.exists) {
        const created = await call(
          'PUT',
          `/collections/${encodeURIComponent(collection)}`,
          {
            vectors: { size: stamp.dimension, distance: DISTANCE },
            metadata: stampMetadata(stamp),
          },
          timeoutMs,
        );
        if (created.kind !== 'ok') return created.outcome;

        // Read back rather than trusting the write. This is what catches a Qdrant too old to
        // store collection metadata: it answers `200 {"result":true}` to a create body it only
        // partly understood, and only the read-back reveals that the stamp did not stick.
        const after = await readInfo(timeoutMs);
        if (after.kind !== 'ok') return after;
        verified = stamp;
        return { kind: 'ok', value: { created: true, adopted: false, info: after.value } };
      }

      // **The width Qdrant enforces is checked first, and unconditionally.** It is the one half
      // of the stamp that is present on every Qdrant version and on every hand-made collection,
      // so checking it before the metadata stamp means an empty, unstamped, wrongly-sized
      // collection is refused here — with this module's actionable message — instead of being
      // adopted and then failing on every upsert with Qdrant's own terse dimension error.
      if (info.vectorSize !== null && info.vectorSize !== stamp.dimension) {
        // Throws. `found.model` falls back to the configured name so the message blames the
        // dimension, which is the only thing actually known to disagree.
        verifyStamp({
          collection,
          expected: stamp,
          found: { model: info.stamp?.model ?? stamp.model, dimension: info.vectorSize },
          foundSchemaVersion: info.schemaVersion,
          hasPoints: info.pointCount > 0,
        });
      }

      // Then the metadata stamp — the model half. An equal vector width proves nothing about
      // which model wrote the points, so a sized-but-unstamped collection is still `unstamped`
      // and `verifyStamp` decides whether it is adoptable or a refusal.
      const verdict = verifyStamp({
        collection,
        expected: stamp,
        found: info.stamp,
        foundSchemaVersion: info.schemaVersion,
        hasPoints: info.pointCount > 0,
      });

      if (verdict.kind === 'adoptable') {
        const patched = await call(
          'PATCH',
          `/collections/${encodeURIComponent(collection)}`,
          { metadata: stampMetadata(stamp) },
          timeoutMs,
        );
        if (patched.kind !== 'ok') return patched.outcome;

        const after = await readInfo(timeoutMs);
        if (after.kind !== 'ok') return after;
        verified = stamp;
        return { kind: 'ok', value: { created: false, adopted: true, info: after.value } };
      }

      verified = stamp;
      return { kind: 'ok', value: { created: false, adopted: false, info } };
    },

    async resetCollection(
      stamp: EmbeddingStamp,
      callOptions?: VectorStoreCallOptions,
    ): Promise<VectorStoreOutcome<MemoryEnsureResult>> {
      const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs;

      // `DELETE /collections/{name}` answers `200 {"result":true}` whether or not it existed,
      // so there is no "not found" case to special-case here.
      const dropped = await call(
        'DELETE',
        `/collections/${encodeURIComponent(collection)}`,
        undefined,
        timeoutMs,
      );
      if (dropped.kind !== 'ok') return dropped.outcome;

      // Forget the previous verification: the collection this port verified no longer exists.
      verified = null;

      const created = await call(
        'PUT',
        `/collections/${encodeURIComponent(collection)}`,
        {
          vectors: { size: stamp.dimension, distance: DISTANCE },
          metadata: stampMetadata(stamp),
        },
        timeoutMs,
      );
      if (created.kind !== 'ok') return created.outcome;

      const after = await readInfo(timeoutMs);
      if (after.kind !== 'ok') return after;

      verified = stamp;
      return { kind: 'ok', value: { created: true, adopted: false, info: after.value } };
    },

    async describeCollection(
      callOptions?: VectorStoreCallOptions,
    ): Promise<VectorStoreOutcome<MemoryCollectionInfo>> {
      return readInfo(callOptions?.timeoutMs ?? defaultTimeoutMs);
    },

    async upsert(
      points: readonly MemoryPoint[],
      callOptions?: VectorStoreCallOptions,
    ): Promise<VectorStoreOutcome<MemoryUpsertResult>> {
      const stamp = requireVerified();
      if (points.length === 0) return { kind: 'ok', value: { upserted: 0 } };

      // Locally, before the network. Qdrant would refuse too, but its message names the batch
      // and this one names the point.
      for (const point of points) assertVectorDimension(point.vector, stamp.dimension, point.id);

      const result = await call(
        'PUT',
        `/collections/${encodeURIComponent(collection)}/points?wait=true`,
        {
          points: points.map((point) => ({
            id: point.id,
            vector: [...point.vector],
            payload: { ...point.payload },
          })),
        },
        callOptions?.timeoutMs ?? defaultTimeoutMs,
      );
      if (result.kind !== 'ok') return result.outcome;
      return { kind: 'ok', value: { upserted: points.length } };
    },

    async search(
      query: MemorySearchQuery,
      callOptions?: VectorStoreCallOptions,
    ): Promise<VectorStoreOutcome<readonly MemorySearchHit[]>> {
      const stamp = requireVerified();
      assertVectorDimension(query.vector, stamp.dimension);

      const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs;
      const filter = qdrantFilter(query.filter);
      const vector = [...query.vector];
      const limit = Math.max(0, Math.trunc(query.limit));

      if (modernQuerySupported !== false) {
        const result = await call(
          'POST',
          `/collections/${encodeURIComponent(collection)}/points/query`,
          {
            query: vector,
            limit,
            with_payload: true,
            filter,
            ...(query.minScore === undefined ? {} : { score_threshold: query.minScore }),
          },
          timeoutMs,
        );

        if (result.kind === 'ok') {
          modernQuerySupported = true;
          const points = (result.body as { points?: unknown }).points;
          return { kind: 'ok', value: readHits(points) };
        }
        // Only an unknown *route* justifies falling back; a 404 naming the collection is a real
        // answer and must not be retried against a second endpoint.
        if (result.kind === 'http' && result.status === 404 && !mentionsCollection(result.raw)) {
          modernQuerySupported = false;
        } else {
          return result.outcome;
        }
      }

      const legacy = await call(
        'POST',
        `/collections/${encodeURIComponent(collection)}/points/search`,
        {
          vector,
          limit,
          with_payload: true,
          filter,
          ...(query.minScore === undefined ? {} : { score_threshold: query.minScore }),
        },
        timeoutMs,
      );
      if (legacy.kind !== 'ok') return legacy.outcome;
      return { kind: 'ok', value: readHits(legacy.body) };
    },

    async deleteByFilter(
      filter: MemoryFilter,
      callOptions?: VectorStoreCallOptions,
    ): Promise<VectorStoreOutcome<MemoryDeleteResult>> {
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

      const result = await call(
        'POST',
        `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
        { filter: qdrantFilter(filter) },
        callOptions?.timeoutMs ?? defaultTimeoutMs,
      );
      if (result.kind !== 'ok') return result.outcome;
      // Qdrant returns `{operation_id, status}` and no count; saying `null` is more honest than
      // inventing one, and callers that need a count can count before deleting.
      return { kind: 'ok', value: { deleted: null } };
    },
  };
}

// ------------------------------------------------------------------------------- translation

/** `http://host:port`, with an IPv6 literal bracketed so the URL stays parseable. */
export function qdrantBaseUrl(host: string, port: number): string {
  const trimmed = host.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  const authority = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
  return `http://${authority}:${String(port)}`;
}

/** The stamp as Qdrant collection metadata. One flat object; Qdrant returns it verbatim. */
export function stampMetadata(stamp: EmbeddingStamp): Record<string, unknown> {
  return {
    [STAMP_METADATA_KEYS.schemaVersion]: MEMORY_SCHEMA_VERSION,
    [STAMP_METADATA_KEYS.model]: stamp.model,
    [STAMP_METADATA_KEYS.dimension]: stamp.dimension,
    [STAMP_METADATA_KEYS.stampedAt]: new Date().toISOString(),
  };
}

/**
 * `MemoryFilter` -> Qdrant's filter DSL.
 *
 * Every field becomes a `match: { any: [...] }` clause and the clauses are `must`-ed together,
 * which is exactly the AND-of-ORs `payloadMatchesFilter` implements. `kind = 'chunk'` is always
 * present so no bookkeeping point can surface as a hit.
 *
 * An **empty array stays an empty `any`**, which matches nothing — the same reading the shared
 * predicate gives it. Dropping the clause instead would silently widen the scope filter, which
 * is the one translation bug in here that would be invisible in production.
 */
export function qdrantFilter(filter: MemoryFilter | undefined): Record<string, unknown> {
  const must: Record<string, unknown>[] = [{ key: 'kind', match: { value: 'chunk' } }];

  const add = (key: string, values: readonly string[] | undefined): void => {
    if (values === undefined) return;
    must.push({ key, match: { any: [...values] } });
  };

  add('tier', filter?.tiers);
  add('projectId', filter?.projectIds);
  add('sessionId', filter?.sessionIds);
  add('agentId', filter?.agentIds);
  add('sourceType', filter?.sourceTypes);
  add('sourceId', filter?.sourceIds);
  add('memoryItemId', filter?.memoryItemIds);
  add('embeddingModel', filter?.embeddingModels);

  return { must };
}

function readHits(value: unknown): readonly MemorySearchHit[] {
  if (!Array.isArray(value)) return [];

  const hits: MemorySearchHit[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const score = record['score'];
    const payload = readPayload(record['payload']);
    if (typeof id !== 'string' || typeof score !== 'number' || payload === null) continue;
    hits.push({ id, score, payload });
  }
  return hits;
}

/**
 * Qdrant payloads are untrusted input on the way back: they were written by some version of
 * this code, possibly an older one, possibly by hand. A hit whose payload cannot be read is
 * dropped rather than surfaced half-formed, because a downstream `payload.tier` of `undefined`
 * would slip straight past a tier filter applied in TypeScript.
 */
function readPayload(value: unknown): MemoryPointPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const text = (key: string): string | null =>
    typeof record[key] === 'string' ? (record[key] as string) : null;

  const memoryItemId = text('memoryItemId');
  const tier = text('tier');
  const sourceType = text('sourceType');
  const embeddingModel = text('embeddingModel');
  const chunkOrdinal = record['chunkOrdinal'];
  const embeddingDimension = record['embeddingDimension'];

  if (
    record['kind'] !== 'chunk' ||
    memoryItemId === null ||
    tier === null ||
    sourceType === null ||
    embeddingModel === null ||
    typeof chunkOrdinal !== 'number' ||
    typeof embeddingDimension !== 'number'
  ) {
    return null;
  }

  return {
    kind: 'chunk',
    memoryItemId,
    tier: tier as MemoryPointPayload['tier'],
    projectId: text('projectId'),
    sessionId: text('sessionId'),
    agentId: text('agentId'),
    sourceType: sourceType as MemoryPointPayload['sourceType'],
    sourceId: text('sourceId'),
    sourceRef: text('sourceRef'),
    chunkOrdinal,
    embeddingModel,
    embeddingDimension,
  };
}

export function readCollectionInfo(name: string, result: unknown): MemoryCollectionInfo {
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const config = asRecord(record['config']);
  const metadata = asRecord(config?.['metadata']);
  const vectors = asRecord(asRecord(config?.['params'])?.['vectors']);

  const model = metadata?.[STAMP_METADATA_KEYS.model];
  const dimension = metadata?.[STAMP_METADATA_KEYS.dimension];
  const schemaVersion = metadata?.[STAMP_METADATA_KEYS.schemaVersion];
  const vectorSize = vectors?.['size'];
  const pointCount = record['points_count'];

  const stamp =
    typeof model === 'string' && typeof dimension === 'number' ? { model, dimension } : null;

  return {
    name,
    exists: true,
    pointCount: typeof pointCount === 'number' ? pointCount : 0,
    stamp,
    schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : null,
    vectorSize: typeof vectorSize === 'number' ? vectorSize : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// -------------------------------------------------------------------------- response reading

/**
 * One HTTP round, classified.
 *
 * `http` is a *distinguishable* non-2xx: it carries the status and the raw body so a caller can
 * decide whether a 404 means "no such collection" (an answer) or "no such route" (fall back),
 * while still holding the ready-made outcome for the common case of just returning it.
 */
type QdrantResult =
  | { readonly kind: 'ok'; readonly body: unknown }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly raw: string;
      readonly outcome: Exclude<VectorStoreOutcome<never>, { kind: 'ok' }>;
    }
  | {
      readonly kind: 'transport';
      readonly outcome: Exclude<VectorStoreOutcome<never>, { kind: 'ok' }>;
    };

function interpret(
  outcome: MemoryHttpOutcome,
  timeoutMs: number,
  baseUrl: string,
  redact: (text: string) => string,
): QdrantResult {
  if (outcome.kind === 'timeout') {
    return { kind: 'transport', outcome: { kind: 'timeout', timeoutMs } };
  }
  if (outcome.kind === 'unreachable') {
    return {
      kind: 'transport',
      outcome: {
        kind: 'unreachable',
        reason: redact(`Could not reach Qdrant at ${baseUrl} — ${outcome.reason}`),
      },
    };
  }

  const parsed = parseJsonObject(outcome.body);

  if (outcome.status >= 200 && outcome.status < 300) {
    return { kind: 'ok', body: parsed?.['result'] };
  }

  const message = qdrantErrorMessage(parsed, outcome.body);
  return {
    kind: 'http',
    status: outcome.status,
    raw: outcome.body,
    outcome: {
      kind: 'failed',
      status: outcome.status,
      reason: redact(
        outcome.status === 401 || outcome.status === 403
          ? `Qdrant rejected the API key (${String(outcome.status)}). Check ` +
              "`integrations.qdrant.apiKey` against the server's configured key."
          : `Qdrant answered ${String(outcome.status)}${message === null ? '' : ` — ${message}`}`,
      ),
    },
  };
}

/** Qdrant failures are `{"status":{"error":"…"}}`; success uses `"status":"ok"` (a string). */
function qdrantErrorMessage(parsed: Record<string, unknown> | null, raw: string): string | null {
  const status = parsed?.['status'];
  if (typeof status === 'object' && status !== null) {
    const error = (status as Record<string, unknown>)['error'];
    if (typeof error === 'string') return error.slice(0, 300);
  }
  if (typeof parsed?.['error'] === 'string') return (parsed['error'] as string).slice(0, 300);
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 300);
}

/** A 404 that names a collection is an answer; one that does not is an unknown route. */
function mentionsCollection(raw: string): boolean {
  return /collection/i.test(raw);
}
