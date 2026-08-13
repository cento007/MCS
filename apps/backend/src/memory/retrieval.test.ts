import {
  createFakeEmbedder,
  createInMemoryVectorStore,
  type MemoryFilter,
  type MemoryPoint,
  type MemoryPointPayload,
  PRODUCIBLE_MEMORY_TIERS,
} from '@mc/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFilters, clampSearchLimit, DEFAULT_MIN_SCORE } from './retrieval.js';

/**
 * Scope filtering is a correctness property, not a feature.
 *
 * The claim under test: **a project-scoped query cannot return another project's vectors.** It is
 * tested twice over — once on the pure filter builder, and once by running those filters through
 * a real store. The second half matters because the first would still pass if `buildFilters`
 * produced a perfectly-shaped filter that the store then ignored.
 *
 * The store here is `createInMemoryVectorStore`, which applies `payloadMatchesFilter` — the same
 * predicate the Qdrant adapter's filter translation is checked against (`qdrant.test.ts`), so a
 * pass here is evidence about the query rather than about the fake's subset.
 */

const PROJECT_A = '018f6b2e-aaaa-7abc-8def-0123456789ab';
const PROJECT_B = '018f6b2e-bbbb-7abc-8def-0123456789ab';
const SESSION_A = '018f6b2e-1111-7abc-8def-0123456789ab';
const SESSION_B = '018f6b2e-2222-7abc-8def-0123456789ab';

const STAMP = { model: 'fake-embed-text', dimension: 64 };
const embedder = createFakeEmbedder({ model: STAMP.model, dimension: STAMP.dimension });

function payload(overrides: Partial<MemoryPointPayload>): MemoryPointPayload {
  return {
    kind: 'chunk',
    memoryItemId: overrides.memoryItemId ?? '018f6b2e-0000-7abc-8def-000000000000',
    tier: 'project',
    projectId: null,
    sessionId: null,
    agentId: null,
    sourceType: 'adr',
    sourceId: null,
    sourceRef: null,
    chunkOrdinal: 0,
    embeddingModel: STAMP.model,
    embeddingDimension: STAMP.dimension,
    ...overrides,
  };
}

let store: ReturnType<typeof createInMemoryVectorStore>;

async function seed(entries: readonly { id: string; text: string; payload: MemoryPointPayload }[]) {
  const embedded = await embedder.embed(entries.map((entry) => entry.text));
  if (embedded.kind !== 'ok') throw new Error('fake embedder failed');

  const points: MemoryPoint[] = entries.map((entry, index) => ({
    id: entry.id,
    vector: embedded.vectors[index] ?? [],
    payload: entry.payload,
  }));
  const upserted = await store.upsert(points);
  expect(upserted.kind).toBe('ok');
}

/** Run one request's filters the way `MemorySearchService` does, and collect the payloads. */
async function search(q: string, filters: readonly MemoryFilter[]): Promise<MemoryPointPayload[]> {
  const embedded = await embedder.embed([q]);
  if (embedded.kind !== 'ok') throw new Error('fake embedder failed');

  const found = new Map<string, MemoryPointPayload>();
  for (const filter of filters) {
    const hits = await store.search({ vector: embedded.vectors[0] ?? [], limit: 50, filter });
    if (hits.kind !== 'ok') throw new Error('store failed');
    for (const hit of hits.value) found.set(hit.id, hit.payload);
  }
  return [...found.values()];
}

beforeEach(async () => {
  store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
  await store.ensureCollection(STAMP);

  await seed([
    {
      id: '00000000-0000-8000-8000-00000000000a',
      text: 'project A decided to adopt pg-boss for the job queue',
      payload: payload({ memoryItemId: 'row-a', projectId: PROJECT_A, sourceType: 'adr' }),
    },
    {
      id: '00000000-0000-8000-8000-00000000000b',
      text: 'project B decided to adopt pg-boss for the job queue',
      payload: payload({ memoryItemId: 'row-b', projectId: PROJECT_B, sourceType: 'adr' }),
    },
    {
      id: '00000000-0000-8000-8000-00000000000c',
      text: 'a session in project A discussing pg-boss and the job queue',
      payload: payload({
        memoryItemId: 'row-c',
        tier: 'session',
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        sourceType: 'session',
      }),
    },
    {
      id: '00000000-0000-8000-8000-00000000000d',
      text: 'a session in project B discussing pg-boss and the job queue',
      payload: payload({
        memoryItemId: 'row-d',
        tier: 'session',
        projectId: PROJECT_B,
        sessionId: SESSION_B,
        sourceType: 'session',
      }),
    },
    {
      id: '00000000-0000-8000-8000-00000000000e',
      text: 'a global vault note about the job queue',
      payload: payload({
        memoryItemId: 'row-e',
        tier: 'global',
        sourceType: 'obsidian_note',
        sourceRef: 'Ideas/queue.md',
      }),
    },
  ]);
});

describe('the negative case: a project-scoped query never leaks another project', () => {
  it('returns project A and global, and NOT project B', async () => {
    const found = await search('job queue', buildFilters({ q: 'job queue', projectId: PROJECT_A }));
    const ids = found.map((entry) => entry.memoryItemId).sort();

    expect(ids).toEqual(['row-a', 'row-c', 'row-e']);
    expect(ids).not.toContain('row-b');
    expect(ids).not.toContain('row-d');
  });

  it('leaks nothing when the other project has textually identical content', async () => {
    // The two ADRs differ by one word, so their vectors are near-identical: if scoping were
    // applied after ranking rather than inside the query, B would out-rank A about half the
    // time and this test would be flaky rather than failing. It is inside the query.
    const found = await search(
      'adopt pg-boss',
      buildFilters({ q: 'adopt pg-boss', projectId: PROJECT_B }),
    );
    expect(found.every((entry) => entry.projectId !== PROJECT_A)).toBe(true);
  });

  it('a session-scoped query returns only that session', async () => {
    const found = await search('job queue', buildFilters({ q: 'job queue', sessionId: SESSION_A }));
    expect(found.map((entry) => entry.memoryItemId)).toEqual(['row-c']);
  });

  it('an unscoped query sees everything, which is what makes the scoped ones meaningful', async () => {
    const found = await search('job queue', buildFilters({ q: 'job queue' }));
    expect(found).toHaveLength(5);
  });

  it('a source-type filter composes with scope rather than replacing it', async () => {
    const found = await search(
      'job queue',
      buildFilters({ q: 'job queue', projectId: PROJECT_A, sourceTypes: ['adr'] }),
    );
    expect(found.map((entry) => entry.memoryItemId)).toEqual(['row-a']);
  });
});

describe('buildFilters — the shapes, and why there are sometimes two', () => {
  it('is one unconstrained-by-scope filter when nothing is scoped', () => {
    const filters = buildFilters({ q: 'x' });
    expect(filters).toHaveLength(1);
    expect(filters[0]?.projectIds).toBeUndefined();
    expect(filters[0]?.tiers).toEqual([...PRODUCIBLE_MEMORY_TIERS]);
  });

  it('never admits the agent tier, which nothing produces', () => {
    // Admitting a tier that can never match would make an empty result look like a scope
    // problem rather than a Phase 4 gap.
    expect(buildFilters({ q: 'x' })[0]?.tiers).not.toContain('agent');
  });

  it('splits into two filters for a project query, because the filter ANDs across fields', () => {
    // `{ tiers: ['project','global'], projectIds: [A] }` would return nothing global: an
    // allowlist never matches a `null` payload field. Two clauses is the honest encoding.
    const filters = buildFilters({ q: 'x', projectId: PROJECT_A });
    expect(filters).toHaveLength(2);
    expect(filters[0]).toMatchObject({ projectIds: [PROJECT_A] });
    expect(filters[0]?.tiers).not.toContain('global');
    expect(filters[1]).toMatchObject({ tiers: ['global'] });
    expect(filters[1]?.projectIds).toBeUndefined();
  });

  it('drops the global half when the caller excluded that tier', () => {
    const filters = buildFilters({ q: 'x', projectId: PROJECT_A, tiers: ['project'] });
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({ tiers: ['project'], projectIds: [PROJECT_A] });
  });

  it('drops the scoped half when the caller asked for global only', () => {
    const filters = buildFilters({ q: 'x', projectId: PROJECT_A, tiers: ['global'] });
    expect(filters).toEqual([{ tiers: ['global'] }]);
  });

  it('a session filter wins over a project filter and pins the session tier', () => {
    const filters = buildFilters({ q: 'x', projectId: PROJECT_A, sessionId: SESSION_A });
    expect(filters).toEqual([{ sessionIds: [SESSION_A], tiers: ['session'] }]);
  });
});

describe('the relevance floor and the limit', () => {
  it('defaults to a floor that is not zero', () => {
    // "Here are five bad matches" and "nothing relevant" are different answers; cosine always
    // returns the former unless something stops it.
    expect(DEFAULT_MIN_SCORE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SCORE).toBeLessThan(1);
  });

  it('sits inside the measured on-topic / off-topic gap', () => {
    // The floor is not a rule of thumb — it was measured over 758 chunks of this repository's
    // own content (see DEFAULT_MIN_SCORE for the score table). On-topic queries bottomed out at
    // 0.552; off-topic ones ("best recipe for sourdough bread") topped out at 0.509. That gap is
    // only 0.043 wide, which is the whole reason this is pinned: the first guess of 0.45 sat
    // *below* the off-topic ceiling and returned five confident irrelevancies for a query about
    // bread. A future edit that drifts the floor out of the band silently restores that.
    const OFF_TOPIC_CEILING = 0.509;
    const ON_TOPIC_FLOOR = 0.552;

    expect(DEFAULT_MIN_SCORE).toBeGreaterThan(OFF_TOPIC_CEILING);
    expect(DEFAULT_MIN_SCORE).toBeLessThan(ON_TOPIC_FLOOR);
  });

  it('clamps the limit into the documented range', () => {
    expect(clampSearchLimit(undefined)).toBe(10);
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(999)).toBe(50);
    expect(clampSearchLimit(7.9)).toBe(7);
  });
});
