import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cosineSimilarity, isEmbeddingSuccess } from './embedding-port.js';
import { createMemoryHttpPort } from './http.js';
import { createOllamaEmbedder } from './ollama.js';
import { provisionMemoryCollection } from './provision.js';
import { createQdrantVectorStore } from './qdrant.js';
import { type EmbeddingStamp, EmbeddingStampMismatchError } from './stamp.js';
import type { MemoryPoint, MemoryPointPayload } from './vector-store-port.js';

/**
 * The **real** Ollama and Qdrant, end to end.
 *
 * ## Why this is in the integration tier and why it skips
 *
 * `pnpm test` must be green on a clean checkout with nothing installed — that property is what
 * makes `pnpm install && pnpm test` a valid first five minutes here, and the unit tier proves
 * every behaviour below against the fakes and against stubs built from captured responses. This
 * file exists for the one thing those cannot do: confirm that the captured responses are still
 * what the real servers send.
 *
 * So it lives in `*.int.test.ts` (never run by `pnpm test`) **and** it probes for each service
 * first and skips with a message rather than failing when one is absent. Nothing in this
 * repository may *depend* on Qdrant or Ollama being installed.
 *
 * ## What it does to the operator's machine
 *
 * Exactly one thing: it creates a collection named `mc_live_test_<random>` and deletes it in
 * `afterAll`, including on failure. It never touches `mc_memory`, never writes settings, and
 * never leaves anything behind.
 *
 * Verified here against Ollama 0.32.9 + `nomic-embed-text` and Qdrant 1.19.0.
 */

const OLLAMA = { host: '127.0.0.1', port: 11434 };
const QDRANT = { host: '127.0.0.1', port: 6333 };
const MODEL = process.env['MC_LIVE_EMBEDDING_MODEL'] ?? 'nomic-embed-text';

/** Unique per run, so two runs in parallel cannot collide and neither can touch `mc_memory`. */
const COLLECTION = `mc_live_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

const http = createMemoryHttpPort();

async function reachable(url: string): Promise<boolean> {
  const outcome = await http({ url, method: 'GET', timeoutMs: 2_000 });
  return outcome.kind === 'response';
}

let ollamaUp = false;
let qdrantUp = false;

beforeAll(async () => {
  ollamaUp = await reachable(`http://${OLLAMA.host}:${String(OLLAMA.port)}/api/version`);
  qdrantUp = await reachable(`http://${QDRANT.host}:${String(QDRANT.port)}/collections`);

  if (!ollamaUp) console.warn('[live] Ollama is not listening on 11434 — skipping those cases');
  if (!qdrantUp) console.warn('[live] Qdrant is not listening on 6333 — skipping those cases');
});

/** Delete the scratch collection. Runs even when a test failed part-way through. */
afterAll(async () => {
  if (!qdrantUp) return;
  await http({
    url: `http://${QDRANT.host}:${String(QDRANT.port)}/collections/${COLLECTION}`,
    method: 'DELETE',
    timeoutMs: 5_000,
  });
});

function embedder(model = MODEL) {
  return createOllamaEmbedder({ ...OLLAMA, model, embedTimeoutMs: 60_000 });
}

function store(collection = COLLECTION) {
  return createQdrantVectorStore({ ...QDRANT, collection, timeoutMs: 10_000 });
}

function payload(overrides: Partial<MemoryPointPayload>): MemoryPointPayload {
  return {
    kind: 'chunk',
    memoryItemId: '0198f0a0-0000-7000-8000-00000000aaaa',
    tier: 'project',
    projectId: 'live-project',
    sessionId: null,
    agentId: null,
    sourceType: 'session',
    sourceId: '0198f0a0-0000-7000-8000-00000000bbbb',
    sourceRef: null,
    chunkOrdinal: 0,
    embeddingModel: MODEL,
    embeddingDimension: 768,
    ...overrides,
  };
}

// --------------------------------------------------------------------------------- ollama

describe('the real Ollama', () => {
  it.runIf(true)('embeds a realistic batch in one bounded call', async ({ skip }) => {
    if (!ollamaUp) skip();

    const chunks = Array.from(
      { length: 64 },
      (_unused, index) =>
        `Chunk ${String(index)}: the operator asked why the launch hung for 45 seconds. ` +
        'The cause was an unbounded outbound call; every outbound call is now bounded by a ' +
        'wall-clock deadline enforced in the port itself rather than by the transport.',
    );

    const startedAt = Date.now();
    const outcome = await embedder().embed(chunks);
    const elapsed = Date.now() - startedAt;

    expect(isEmbeddingSuccess(outcome)).toBe(true);
    if (!isEmbeddingSuccess(outcome)) return;

    expect(outcome.vectors).toHaveLength(64);
    expect(outcome.stamp.model).toBe(MODEL);
    expect(outcome.stamp.dimension).toBeGreaterThan(0);
    for (const vector of outcome.vectors) expect(vector).toHaveLength(outcome.stamp.dimension);

    console.info(
      `[live] Ollama: 64 chunks in ${String(elapsed)} ms ` +
        `(${(elapsed / 64).toFixed(1)} ms/chunk, ${String(outcome.stamp.dimension)}d)`,
    );
  });

  it('is deterministic — the same text embeds to the same vector', async ({ skip }) => {
    if (!ollamaUp) skip();

    const port = embedder();
    const first = await port.embed(['determinism probe for the live tier']);
    const second = await port.embed(['determinism probe for the live tier']);

    if (!isEmbeddingSuccess(first) || !isEmbeddingSuccess(second)) throw new Error('embed failed');
    expect(second.vectors[0]).toEqual(first.vectors[0]);
  });

  it('returns unit-length vectors after the adapter normalizes them', async ({ skip }) => {
    if (!ollamaUp) skip();

    const outcome = await embedder().embed(['norm probe']);
    if (!isEmbeddingSuccess(outcome)) throw new Error('embed failed');

    const vector = outcome.vectors[0] ?? [];
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('reports a model that is not pulled, quickly', async ({ skip }) => {
    if (!ollamaUp) skip();

    const startedAt = Date.now();
    const outcome = await embedder('definitely-not-a-real-model-xyz').embed(['x']);
    const elapsed = Date.now() - startedAt;

    expect(outcome.kind).toBe('model_missing');
    // The whole point of the `/api/show` gate: this must not cost a model load.
    expect(elapsed).toBeLessThan(2_000);
    console.info(`[live] Ollama: unknown model rejected in ${String(elapsed)} ms`);
  });

  it('rejects a chat model by name WITHOUT paying for its model load', async ({ skip }) => {
    if (!ollamaUp) skip();
    // Only meaningful if a chat model is actually installed; the run reports which it used.
    const chatModel = process.env['MC_LIVE_CHAT_MODEL'] ?? 'deepseek-r1:8b';

    const probe = await http({
      url: `http://${OLLAMA.host}:${String(OLLAMA.port)}/api/show`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: chatModel }),
      timeoutMs: 5_000,
    });
    if (probe.kind !== 'response' || probe.status !== 200) skip();

    const startedAt = Date.now();
    const outcome = await embedder(chatModel).embed(['x']);
    const elapsed = Date.now() - startedAt;

    expect(outcome.kind).toBe('not_an_embedding_model');
    if (outcome.kind !== 'not_an_embedding_model') return;
    expect(outcome.reason).toContain('ollama pull');
    // Measured without the gate: 28.6 s for an 8B model. With it, one manifest read.
    expect(elapsed).toBeLessThan(3_000);
    console.info(
      `[live] Ollama: chat model "${chatModel}" rejected in ${String(elapsed)} ms ` +
        `(capabilities ${outcome.capabilities.join(', ')})`,
    );
  });

  it('reports a timeout as data when the deadline is impossibly short', async ({ skip }) => {
    if (!ollamaUp) skip();

    const outcome = await createOllamaEmbedder({
      ...OLLAMA,
      model: MODEL,
      embedTimeoutMs: 1,
      probeTimeoutMs: 1,
    }).embed(['x']);

    expect(outcome.kind).toBe('timeout');
  });

  it('reports an unreachable port as data, not an exception', async () => {
    // Port 1 is reserved and nothing listens there, on any machine.
    const outcome = await createOllamaEmbedder({
      host: '127.0.0.1',
      port: 1,
      model: MODEL,
      embedTimeoutMs: 3_000,
      probeTimeoutMs: 3_000,
    }).embed(['x']);

    expect(outcome.kind).toBe('unreachable');
  });
});

// --------------------------------------------------------------------------------- qdrant

describe('the real Qdrant', () => {
  it('reports an unreachable port as data, not an exception', async () => {
    const result = await createQdrantVectorStore({
      host: '127.0.0.1',
      port: 1,
      collection: COLLECTION,
      timeoutMs: 3_000,
    }).describeCollection();

    expect(result.kind).toBe('unreachable');
    if (result.kind !== 'unreachable') return;
    expect(result.reason).toContain('Could not reach Qdrant');
  });

  it('reports a timeout as data when the deadline is impossibly short', async ({ skip }) => {
    if (!qdrantUp) skip();

    const result = await createQdrantVectorStore({
      ...QDRANT,
      collection: COLLECTION,
      timeoutMs: 1,
    }).describeCollection();

    expect(result.kind).toBe('timeout');
  });

  it('provisions, upserts, ranks and refuses a changed stamp, end to end', async ({ skip }) => {
    if (!qdrantUp || !ollamaUp) skip();

    const port = embedder();
    const subject = store();

    // ---- 1. provision, with the stamp measured from the real model
    const report = await provisionMemoryCollection({ embedder: port, store: subject });
    expect(report.kind).toBe('ready');
    if (report.kind !== 'ready') return;
    expect(report.created).toBe(true);
    expect(report.stampPersisted).toBe(true);
    const stamp: EmbeddingStamp = report.stamp;
    console.info(
      `[live] Qdrant: created "${COLLECTION}" stamped ${stamp.model} (${String(stamp.dimension)}d)`,
    );

    // ---- 2. the stamp is really on the collection, readable by anyone
    const described = await subject.describeCollection();
    if (described.kind !== 'ok') throw new Error(described.kind);
    expect(described.value.stamp).toEqual(stamp);
    expect(described.value.vectorSize).toBe(stamp.dimension);
    console.info(`[live] Qdrant: stamp read back as ${JSON.stringify(described.value.stamp)}`);

    // ---- 3. upsert real nomic-embed-text vectors
    const texts = [
      'The session state machine forbids moving backwards between states.',
      'Session states never move backward; the state machine forbids it.',
      'Quarterly revenue projections for the northern sales region.',
    ];
    const embedded = await port.embed(texts);
    if (!isEmbeddingSuccess(embedded)) throw new Error('embed failed');

    const points: MemoryPoint[] = embedded.vectors.map((vector, index) => ({
      id: `0198f0a0-0000-7000-8000-00000000000${String(index + 1)}`,
      vector,
      payload: payload({
        memoryItemId: `0198f0a0-0000-7000-8000-00000000000${String(index + 1)}`,
        chunkOrdinal: index,
        embeddingDimension: stamp.dimension,
        tier: index === 2 ? 'global' : 'project',
        projectId: index === 2 ? null : 'live-project',
      }),
    }));

    const upserted = await subject.upsert(points);
    expect(upserted).toMatchObject({ kind: 'ok', value: { upserted: 3 } });

    // ---- 4. search ranks the near-duplicate first, the unrelated chunk last
    const queryVector = embedded.vectors[0];
    if (queryVector === undefined) throw new Error('no query vector');

    const found = await subject.search({ vector: queryVector, limit: 3 });
    if (found.kind !== 'ok') throw new Error(found.kind);

    expect(found.value).toHaveLength(3);
    const ids = found.value.map((hit) => hit.id);
    expect(ids[0]).toBe(points[0]?.id);
    expect(ids[1]).toBe(points[1]?.id);
    expect(ids[2]).toBe(points[2]?.id);
    console.info(
      `[live] Qdrant: ranking ${found.value.map((hit) => hit.score.toFixed(4)).join(' > ')}`,
    );

    // Qdrant's own cosine agrees with the arithmetic the in-memory fake uses, which is what
    // makes a ranking assertion written against the fake mean something in production.
    const secondVector = embedded.vectors[1];
    if (secondVector !== undefined) {
      expect(found.value[1]?.score).toBeCloseTo(cosineSimilarity(queryVector, secondVector), 4);
    }

    // ---- 5. the payload filter really filters, server-side
    const filtered = await subject.search({
      vector: queryVector,
      limit: 10,
      filter: { tiers: ['global'] },
    });
    if (filtered.kind !== 'ok') throw new Error(filtered.kind);
    expect(filtered.value.map((hit) => hit.id)).toEqual([points[2]?.id]);

    // ---- 6. THE ONE THAT MATTERS: a changed model is refused against a real collection
    const changed = { model: 'some-other-embedding-model', dimension: stamp.dimension };
    let thrown: unknown;
    try {
      await store().ensureCollection(changed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EmbeddingStampMismatchError);
    const mismatch = thrown as EmbeddingStampMismatchError;
    expect(mismatch.detail.kind).toBe('model');
    expect(mismatch.message).toContain('some-other-embedding-model');
    expect(mismatch.message).toContain(stamp.model);
    console.info(`[live] Qdrant: model change refused — ${mismatch.message.slice(0, 140)}…`);

    // ---- 7. and a changed dimension, likewise
    let dimensionThrown: unknown;
    try {
      await store().ensureCollection({ model: stamp.model, dimension: stamp.dimension + 1 });
    } catch (error) {
      dimensionThrown = error;
    }
    expect((dimensionThrown as EmbeddingStampMismatchError).detail.kind).toBe('dimension');

    // ---- 8. the refusal is a gate, not a warning: nothing was written under the wrong stamp
    const refused = store();
    await refused.ensureCollection(changed).catch(() => undefined);
    await expect(refused.upsert(points)).rejects.toThrow(/has not been verified/);

    const after = await subject.describeCollection();
    if (after.kind !== 'ok') throw new Error(after.kind);
    expect(after.value.pointCount).toBe(3);
    expect(after.value.stamp).toEqual(stamp);

    // ---- 9. delete by filter
    const deleted = await subject.deleteByFilter({ tiers: ['global'] });
    expect(deleted.kind).toBe('ok');

    const remaining = await subject.search({ vector: queryVector, limit: 10 });
    if (remaining.kind !== 'ok') throw new Error(remaining.kind);
    expect(remaining.value).toHaveLength(2);

    // ---- 10. re-provisioning is idempotent
    const again = await provisionMemoryCollection({ embedder: port, store: store() });
    expect(again).toMatchObject({ kind: 'ready', created: false, adopted: false });
  });
});
