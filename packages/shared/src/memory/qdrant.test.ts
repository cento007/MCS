import { describe, expect, it } from 'vitest';
import { REDACTION_PLACEHOLDER } from '../crypto/redact.js';
import type { MemoryHttpOutcome, MemoryHttpPort, MemoryHttpRequest } from './http.js';
import {
  createQdrantVectorStore,
  DEFAULT_MEMORY_COLLECTION,
  qdrantBaseUrl,
  qdrantFilter,
  readCollectionInfo,
  stampMetadata,
} from './qdrant.js';
import {
  type EmbeddingStamp,
  EmbeddingStampMismatchError,
  MEMORY_SCHEMA_VERSION,
  STAMP_METADATA_KEYS,
  VectorDimensionError,
} from './stamp.js';
import type { MemoryPoint, MemoryPointPayload } from './vector-store-port.js';

/**
 * The Qdrant adapter, driven by stubs reproducing **responses captured from a real Qdrant
 * 1.19.0** on this machine. The literal shapes that matter:
 *
 *   PUT  /collections/{n}          -> 200 {"result":true,"status":"ok"}
 *   GET  /collections/{n}          -> 200 {"result":{"points_count":N,"config":{
 *                                          "params":{"vectors":{"size":768,"distance":"Cosine"}},
 *                                          "metadata":{…}}}}
 *   GET  /collections/missing      -> 404 {"status":{"error":"Not found: Collection `x` doesn't exist!"}}
 *   PUT  /collections/{n}/points   -> 400 {"status":{"error":"Wrong input: Vector dimension error:
 *                                          expected dim: 4, got 6"}}   (wrong width)
 *   POST /collections/{n}/points/query -> 200 {"result":{"points":[{id,score,payload}]}}
 *   POST /collections/{n}/points/search (legacy) -> 200 {"result":[{id,score,payload}]}
 *
 * Nothing here reaches the network: the unit tier must be green on a machine with no Qdrant.
 * `qdrant.live.int.test.ts` exercises the real server, and skips itself when it is absent.
 */

const STAMP: EmbeddingStamp = { model: 'nomic-embed-text', dimension: 4 };
const API_KEY = 'qdrant-secret-key-do-not-leak-1234567890';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function stub(handler: (call: Call) => MemoryHttpOutcome): {
  http: MemoryHttpPort;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: MemoryHttpPort = async (request: MemoryHttpRequest) => {
    const url = new URL(request.url);
    const call: Call = {
      method: request.method,
      path: url.pathname,
      headers: { ...request.headers },
      body: request.body === undefined ? undefined : JSON.parse(request.body),
    };
    calls.push(call);
    return handler(call);
  };
  return { http, calls };
}

const ok = (result: unknown): MemoryHttpOutcome => ({
  kind: 'response',
  status: 200,
  body: JSON.stringify({ result, status: 'ok', time: 0.001 }),
});

const qdrantError = (status: number, message: string): MemoryHttpOutcome => ({
  kind: 'response',
  status,
  body: JSON.stringify({ status: { error: message }, time: 0.001 }),
});

/** A `GET /collections/{n}` body, in the exact nesting Qdrant 1.19 returns. */
function collectionBody(options: {
  size?: number | null;
  metadata?: Record<string, unknown> | null;
  points?: number;
}): unknown {
  return {
    status: 'green',
    points_count: options.points ?? 0,
    config: {
      params: {
        ...(options.size === null
          ? {}
          : { vectors: { size: options.size ?? STAMP.dimension, distance: 'Cosine' } }),
        shard_number: 1,
      },
      ...(options.metadata === null ? {} : { metadata: options.metadata ?? stampMetadata(STAMP) }),
    },
  };
}

function payload(overrides: Partial<MemoryPointPayload> = {}): MemoryPointPayload {
  return {
    kind: 'chunk',
    memoryItemId: '0198f0a0-0000-7000-8000-00000000aaaa',
    tier: 'project',
    projectId: 'project-1',
    sessionId: null,
    agentId: null,
    sourceType: 'session',
    sourceId: '0198f0a0-0000-7000-8000-00000000bbbb',
    sourceRef: null,
    chunkOrdinal: 0,
    embeddingModel: STAMP.model,
    embeddingDimension: STAMP.dimension,
    ...overrides,
  };
}

const POINT: MemoryPoint = {
  id: '0198f0a0-0000-7000-8000-000000000001',
  vector: [1, 0, 0, 0],
  payload: payload(),
};

function store(handler: (call: Call) => MemoryHttpOutcome, apiKey: string | null = null) {
  const stubbed = stub(handler);
  return {
    store: createQdrantVectorStore({
      host: '127.0.0.1',
      port: 6333,
      apiKey,
      http: stubbed.http,
      timeoutMs: 50,
    }),
    calls: stubbed.calls,
  };
}

/** A store over a collection that already exists and is correctly stamped. */
function readyStore(extra: (call: Call) => MemoryHttpOutcome | null = () => null, apiKey?: string) {
  return store((call) => {
    const override = extra(call);
    if (override !== null) return override;
    if (call.method === 'GET') return ok(collectionBody({ points: 3 }));
    return ok(true);
  }, apiKey ?? null);
}

// ---------------------------------------------------------------------------- provisioning

describe('collection creation', () => {
  it('creates a collection sized for the stamp and stamps it in the metadata', async () => {
    let created = false;
    const { store: subject, calls } = store((call) => {
      if (call.method === 'PUT' && call.path.endsWith(DEFAULT_MEMORY_COLLECTION)) {
        created = true;
        return ok(true);
      }
      if (call.method === 'GET') {
        return created
          ? ok(collectionBody({}))
          : qdrantError(404, "Not found: Collection `mc_memory` doesn't exist!");
      }
      return ok(true);
    });

    const result = await subject.ensureCollection(STAMP);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.created).toBe(true);

    const create = calls.find((call) => call.method === 'PUT');
    expect(create?.body).toMatchObject({
      vectors: { size: 4, distance: 'Cosine' },
      metadata: {
        [STAMP_METADATA_KEYS.model]: 'nomic-embed-text',
        [STAMP_METADATA_KEYS.dimension]: 4,
        [STAMP_METADATA_KEYS.schemaVersion]: MEMORY_SCHEMA_VERSION,
      },
    });
  });

  it('reads the stamp back rather than trusting the create — an older Qdrant drops metadata', async () => {
    // Qdrant silently ignores unknown fields in a create body, so a server too old to store
    // collection metadata answers `200 {"result":true}` and stores nothing. Only the read-back
    // reveals it, and the caller is told through `info.stamp === null`.
    let created = false;
    const { store: subject } = store((call) => {
      if (call.method === 'PUT') {
        created = true;
        return ok(true);
      }
      if (call.method === 'GET') {
        return created
          ? ok(collectionBody({ metadata: null }))
          : qdrantError(404, "Not found: Collection `mc_memory` doesn't exist!");
      }
      return ok(true);
    });

    const result = await subject.ensureCollection(STAMP);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.info.stamp).toBeNull();
    // The width Qdrant enforces itself survives regardless.
    expect(result.value.info.vectorSize).toBe(4);
  });
});

describe('stamp verification against an existing collection', () => {
  it('accepts a collection whose stamp matches', async () => {
    const { store: subject } = readyStore();
    const result = await subject.ensureCollection(STAMP);
    expect(result).toMatchObject({ kind: 'ok', value: { created: false, adopted: false } });
  });

  it('REFUSES a collection stamped for a different model, naming both', async () => {
    const { store: subject } = store((call) =>
      call.method === 'GET'
        ? ok(
            collectionBody({
              points: 12,
              metadata: stampMetadata({ model: 'mxbai-embed-large', dimension: 4 }),
            }),
          )
        : ok(true),
    );

    let thrown: unknown;
    try {
      await subject.ensureCollection(STAMP);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EmbeddingStampMismatchError);
    const error = thrown as EmbeddingStampMismatchError;
    expect(error.message).toContain('nomic-embed-text');
    expect(error.message).toContain('mxbai-embed-large');
  });

  it('REFUSES a collection whose vector width disagrees, before checking the metadata', async () => {
    // The width is enforced by Qdrant on every request and is present on every version, so it
    // is checked first — and the error names the dimension, not the model.
    const { store: subject } = store((call) =>
      call.method === 'GET'
        ? ok(collectionBody({ size: 1024, points: 5, metadata: null }))
        : ok(true),
    );

    let thrown: unknown;
    try {
      await subject.ensureCollection(STAMP);
    } catch (error) {
      thrown = error;
    }

    const error = thrown as EmbeddingStampMismatchError;
    expect(error.detail.kind).toBe('dimension');
    expect(error.message).toContain('1024');
    expect(error.message).toContain('4');
  });

  it('REFUSES a non-empty collection carrying no stamp at all', async () => {
    const { store: subject } = store((call) =>
      call.method === 'GET' ? ok(collectionBody({ points: 99, metadata: null })) : ok(true),
    );

    let thrown: unknown;
    try {
      await subject.ensureCollection(STAMP);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as EmbeddingStampMismatchError).detail.kind).toBe('unstamped');
  });

  it('adopts an EMPTY unstamped collection by patching the stamp onto it', async () => {
    let stamped = false;
    const { store: subject, calls } = store((call) => {
      if (call.method === 'PATCH') {
        stamped = true;
        return ok(true);
      }
      if (call.method === 'GET') {
        return ok(
          stamped ? collectionBody({ points: 0 }) : collectionBody({ points: 0, metadata: null }),
        );
      }
      return ok(true);
    });

    const result = await subject.ensureCollection(STAMP);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.adopted).toBe(true);
    expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
      metadata: { [STAMP_METADATA_KEYS.model]: 'nomic-embed-text' },
    });
  });

  it('leaves the store unusable after a refusal', async () => {
    const { store: subject } = store((call) =>
      call.method === 'GET'
        ? ok(
            collectionBody({
              points: 1,
              metadata: stampMetadata({ model: 'other', dimension: 4 }),
            }),
          )
        : ok(true),
    );

    await subject.ensureCollection(STAMP).catch(() => undefined);
    // The refusal is a gate, not a warning: nothing may be written or queried afterwards.
    await expect(subject.upsert([POINT])).rejects.toThrow(/has not been verified/);
    await expect(subject.search({ vector: [1, 0, 0, 0], limit: 1 })).rejects.toThrow(
      /has not been verified/,
    );
  });
});

// ---------------------------------------------------------------------------------- writing

describe('upsert', () => {
  it('sends points with id, vector and payload, and waits for the write', async () => {
    const { store: subject, calls } = readyStore();
    await subject.ensureCollection(STAMP);

    const result = await subject.upsert([POINT]);
    expect(result).toMatchObject({ kind: 'ok', value: { upserted: 1 } });

    const write = calls.find((call) => call.path.endsWith('/points'));
    expect(write?.method).toBe('PUT');
    expect(write?.body).toMatchObject({
      points: [{ id: POINT.id, vector: [1, 0, 0, 0], payload: { kind: 'chunk' } }],
    });
  });

  it('refuses a wrongly-sized vector locally, before the request is sent', async () => {
    const { store: subject, calls } = readyStore();
    await subject.ensureCollection(STAMP);
    const before = calls.length;

    await expect(subject.upsert([{ ...POINT, vector: [1, 0, 0, 0, 0, 0] }])).rejects.toBeInstanceOf(
      VectorDimensionError,
    );

    // Qdrant would also refuse (`400 … expected dim: 4, got 6`), but the local check names the
    // point rather than the batch and costs no round trip.
    expect(calls).toHaveLength(before);
  });

  it('makes no request for an empty batch', async () => {
    const { store: subject, calls } = readyStore();
    await subject.ensureCollection(STAMP);
    const before = calls.length;

    expect(await subject.upsert([])).toMatchObject({ kind: 'ok', value: { upserted: 0 } });
    expect(calls).toHaveLength(before);
  });
});

// --------------------------------------------------------------------------------- querying

describe('search', () => {
  const HITS = {
    points: [
      { id: 'id-1', version: 1, score: 0.98, payload: payload({ memoryItemId: 'id-1' }) },
      { id: 'id-2', version: 1, score: 0.42, payload: payload({ memoryItemId: 'id-2' }) },
    ],
  };

  it('uses the modern query endpoint and reads its nested result shape', async () => {
    const { store: subject, calls } = readyStore((call) =>
      call.path.endsWith('/points/query') ? ok(HITS) : null,
    );
    await subject.ensureCollection(STAMP);

    const result = await subject.search({ vector: [1, 0, 0, 0], limit: 2 });
    if (result.kind !== 'ok') throw new Error(result.kind);

    expect(result.value.map((hit) => hit.id)).toEqual(['id-1', 'id-2']);
    expect(result.value[0]?.score).toBe(0.98);
    expect(calls.some((call) => call.path.endsWith('/points/query'))).toBe(true);
  });

  it('always filters to kind=chunk so bookkeeping points can never be returned', async () => {
    const { store: subject, calls } = readyStore((call) =>
      call.path.endsWith('/points/query') ? ok(HITS) : null,
    );
    await subject.ensureCollection(STAMP);
    await subject.search({ vector: [1, 0, 0, 0], limit: 2 });

    const query = calls.find((call) => call.path.endsWith('/points/query'));
    expect(query?.body).toMatchObject({
      filter: { must: [{ key: 'kind', match: { value: 'chunk' } }] },
    });
  });

  it('passes minScore through as Qdrant’s score_threshold', async () => {
    const { store: subject, calls } = readyStore((call) =>
      call.path.endsWith('/points/query') ? ok(HITS) : null,
    );
    await subject.ensureCollection(STAMP);
    await subject.search({ vector: [1, 0, 0, 0], limit: 2, minScore: 0.7 });

    expect(calls.find((call) => call.path.endsWith('/points/query'))?.body).toMatchObject({
      score_threshold: 0.7,
    });
  });

  it('falls back to the legacy search endpoint on an unknown-route 404', async () => {
    const { store: subject, calls } = readyStore((call) => {
      if (call.path.endsWith('/points/query')) return { kind: 'response', status: 404, body: '' };
      if (call.path.endsWith('/points/search')) return ok(HITS.points);
      return null;
    });
    await subject.ensureCollection(STAMP);

    const result = await subject.search({ vector: [1, 0, 0, 0], limit: 2 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.map((hit) => hit.id)).toEqual(['id-1', 'id-2']);
    expect(calls.some((call) => call.path.endsWith('/points/search'))).toBe(true);
  });

  it('does NOT fall back when the 404 names the collection', async () => {
    const { store: subject, calls } = readyStore((call) =>
      call.path.endsWith('/points/query')
        ? qdrantError(404, "Not found: Collection `mc_memory` doesn't exist!")
        : null,
    );
    await subject.ensureCollection(STAMP);

    expect(await subject.search({ vector: [1, 0, 0, 0], limit: 2 })).toMatchObject({
      kind: 'failed',
      status: 404,
    });
    expect(calls.some((call) => call.path.endsWith('/points/search'))).toBe(false);
  });

  it('drops a hit whose payload cannot be read rather than surfacing it half-formed', async () => {
    // A `tier` of `undefined` would slip straight past a tier filter applied downstream.
    const { store: subject } = readyStore((call) =>
      call.path.endsWith('/points/query')
        ? ok({ points: [{ id: 'bad', score: 0.9, payload: { kind: 'chunk' } }] })
        : null,
    );
    await subject.ensureCollection(STAMP);

    const result = await subject.search({ vector: [1, 0, 0, 0], limit: 5 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value).toEqual([]);
  });

  it('refuses a wrongly-sized query vector before the request', async () => {
    const { store: subject } = readyStore();
    await subject.ensureCollection(STAMP);
    await expect(subject.search({ vector: [1, 0], limit: 1 })).rejects.toBeInstanceOf(
      VectorDimensionError,
    );
  });
});

describe('deleteByFilter', () => {
  it('sends the translated filter', async () => {
    const { store: subject, calls } = readyStore();
    await subject.ensureCollection(STAMP);
    await subject.deleteByFilter({ projectIds: ['alpha'] });

    expect(calls.find((call) => call.path.endsWith('/points/delete'))?.body).toMatchObject({
      filter: {
        must: [
          { key: 'kind', match: { value: 'chunk' } },
          { key: 'projectId', match: { any: ['alpha'] } },
        ],
      },
    });
  });

  it('refuses an empty filter rather than erasing the index', async () => {
    const { store: subject, calls } = readyStore();
    await subject.ensureCollection(STAMP);
    const before = calls.length;

    expect(await subject.deleteByFilter({})).toMatchObject({ kind: 'failed' });
    expect(calls).toHaveLength(before);
  });
});

// ------------------------------------------------------------------------ failures are data

describe('failures are data, never exceptions', () => {
  it('reports an unreachable Qdrant as a result', async () => {
    const { store: subject } = store(() => ({
      kind: 'unreachable',
      reason: 'connect ECONNREFUSED 127.0.0.1:6333',
    }));

    const result = await subject.describeCollection();
    expect(result.kind).toBe('unreachable');
    if (result.kind !== 'unreachable') return;
    expect(result.reason).toContain('Could not reach Qdrant');
  });

  it('reports a timeout as a result', async () => {
    const { store: subject } = store(() => ({ kind: 'timeout' }));
    expect(await subject.describeCollection()).toMatchObject({ kind: 'timeout', timeoutMs: 50 });
  });

  it('bounds a transport that never settles', async () => {
    const never: MemoryHttpPort = () => new Promise<MemoryHttpOutcome>(() => undefined);
    const subject = createQdrantVectorStore({
      host: '127.0.0.1',
      port: 6333,
      http: never,
      timeoutMs: 25,
    });

    const startedAt = Date.now();
    const result = await subject.describeCollection();
    expect(result).toMatchObject({ kind: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('reports a missing collection as "does not exist", not as a failure', async () => {
    const { store: subject } = store(() =>
      qdrantError(404, "Not found: Collection `mc_memory` doesn't exist!"),
    );

    const result = await subject.describeCollection();
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.exists).toBe(false);
  });

  it('gives a specific message for a rejected API key', async () => {
    const { store: subject } = store(() => qdrantError(403, 'Must provide an API key'), API_KEY);

    const result = await subject.describeCollection();
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('integrations.qdrant.apiKey');
  });
});

// ------------------------------------------------------------------------------- the API key

describe('the API key never leaks', () => {
  it('is sent as a header and never in the URL', async () => {
    const { store: subject, calls } = readyStore(() => null, API_KEY);
    await subject.ensureCollection(STAMP);
    await subject.upsert([POINT]);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers['api-key']).toBe(API_KEY);
      expect(call.path).not.toContain(API_KEY);
    }
  });

  it('is scrubbed out of a transport error that happens to quote it', async () => {
    // Transport errors quote URLs, and a misconfigured host could put a credential in one.
    const { store: subject } = store(
      () => ({
        kind: 'unreachable',
        reason: `getaddrinfo ENOTFOUND https://${API_KEY}@qdrant.internal`,
      }),
      API_KEY,
    );

    const result = await subject.describeCollection();
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).toContain(REDACTION_PLACEHOLDER);
  });

  it('never appears in ANY serialized outcome, across every operation and failure mode', async () => {
    // The catch-all scan. Anything an operator or an API response could see goes through here.
    const outcomes: unknown[] = [];

    for (const response of [
      qdrantError(500, `Internal error while validating key ${API_KEY}`),
      qdrantError(401, `Invalid api-key: ${API_KEY}`),
      { kind: 'unreachable', reason: `socket hang up (${API_KEY})` } as const,
      { kind: 'timeout' } as const,
    ]) {
      const { store: subject } = store(() => response, API_KEY);
      outcomes.push(await subject.describeCollection());
      outcomes.push(await subject.ensureCollection(STAMP).catch((error: unknown) => String(error)));
    }

    const serialized = JSON.stringify(outcomes);
    expect(serialized).not.toContain(API_KEY);
    // And the scan is meaningful — the key really was in the inputs.
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });
});

// ------------------------------------------------------------------------ pure translations

describe('filter translation', () => {
  it('always includes the chunk discriminator', () => {
    expect(qdrantFilter(undefined)).toEqual({ must: [{ key: 'kind', match: { value: 'chunk' } }] });
  });

  it('turns each field into a match-any clause, ANDed together', () => {
    expect(qdrantFilter({ tiers: ['project', 'global'], projectIds: ['p1'] })).toEqual({
      must: [
        { key: 'kind', match: { value: 'chunk' } },
        { key: 'tier', match: { any: ['project', 'global'] } },
        { key: 'projectId', match: { any: ['p1'] } },
      ],
    });
  });

  it('keeps an empty allowlist as an empty match-any, which matches nothing', () => {
    // Dropping the clause would silently widen the scope filter — the one translation bug in
    // here that would be invisible in production.
    expect(qdrantFilter({ projectIds: [] })['must']).toContainEqual({
      key: 'projectId',
      match: { any: [] },
    });
  });
});

describe('collection info reading', () => {
  it('reads the stamp, the width and the point count out of the real response shape', () => {
    const info = readCollectionInfo('mc_memory', collectionBody({ points: 7 }));
    expect(info).toMatchObject({
      exists: true,
      pointCount: 7,
      stamp: { model: 'nomic-embed-text', dimension: 4 },
      vectorSize: 4,
      schemaVersion: MEMORY_SCHEMA_VERSION,
    });
  });

  it('reports a null stamp for a collection that carries no metadata', () => {
    const info = readCollectionInfo('mc_memory', collectionBody({ metadata: null }));
    expect(info.stamp).toBeNull();
    expect(info.vectorSize).toBe(4);
  });

  it('survives a response shaped nothing like the expected one', () => {
    expect(readCollectionInfo('mc_memory', 'not an object')).toMatchObject({
      exists: true,
      pointCount: 0,
      stamp: null,
      vectorSize: null,
    });
  });
});

describe('base URL construction', () => {
  it('builds host:port and brackets an IPv6 literal', () => {
    expect(qdrantBaseUrl('127.0.0.1', 6333)).toBe('http://127.0.0.1:6333');
    expect(qdrantBaseUrl('::1', 6333)).toBe('http://[::1]:6333');
  });

  it('honours an explicit scheme', () => {
    expect(qdrantBaseUrl('https://qdrant.internal', 6333)).toBe('https://qdrant.internal');
  });
});
