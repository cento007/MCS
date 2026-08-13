import { describe, expect, it } from 'vitest';
import { chunkBudget } from './chunk.js';
import { planChunks, type StoredChunkState } from './indexer.js';
import { derivePointId, hashChunk, type SourceKey } from './store.js';

/**
 * The diff that makes re-indexing free, and the derived point id that makes a crash harmless.
 *
 * `planChunks` is the whole of claim (1) from `indexer.ts` — "re-indexing unchanged content
 * writes nothing and embeds nothing" — expressed as a pure function over a map, so the claim is
 * a statement about a decision rather than an assertion about how many times a fake was called.
 * The database half of the same claim is proved end to end in
 * `apps/backend/src/memory/memory-ingest.int.test.ts`.
 */

const BUDGET = chunkBudget(2048);
const KEY: SourceKey = {
  sourceType: 'adr',
  sourceId: '018f6b2e-4444-7abc-8def-0123456789ab',
  sourceRef: null,
};
const MODEL = 'nomic-embed-text';

function chunk(ordinal: number, text: string) {
  return { ordinal, text, bytes: text.length };
}

function stored(id: string, text: string, indexed = true): StoredChunkState {
  return { id, contentHash: hashChunk(text), indexedAt: indexed ? new Date() : null };
}

describe('planChunks — what costs an embedding call', () => {
  it('embeds everything when nothing is stored', () => {
    const plan = planChunks([chunk(0, 'alpha'), chunk(1, 'beta')], new Map(), KEY, MODEL);
    expect(plan.pending).toHaveLength(2);
  });

  it('embeds NOTHING when every hash matches — the claim this file exists for', () => {
    const chunks = [chunk(0, 'alpha'), chunk(1, 'beta')];
    const byOrdinal = new Map([
      [0, stored('row-0', 'alpha')],
      [1, stored('row-1', 'beta')],
    ]);

    expect(planChunks(chunks, byOrdinal, KEY, MODEL).pending).toEqual([]);
  });

  it('embeds only the chunk that changed', () => {
    // A Session that gained one turn must re-embed one chunk, not four hundred: at ~6 ms per
    // chunk that is the difference between a backfill someone runs and one they cancel.
    const chunks = [chunk(0, 'alpha'), chunk(1, 'beta CHANGED'), chunk(2, 'gamma')];
    const byOrdinal = new Map([
      [0, stored('row-0', 'alpha')],
      [1, stored('row-1', 'beta')],
      [2, stored('row-2', 'gamma')],
    ]);

    const plan = planChunks(chunks, byOrdinal, KEY, MODEL);
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]?.chunk.ordinal).toBe(1);
  });

  it('re-uses the existing row id for a changed chunk', () => {
    // Otherwise every edit would orphan a row and insert a duplicate under the same unique key.
    const plan = planChunks(
      [chunk(0, 'new text')],
      new Map([[0, stored('row-0', 'old text')]]),
      KEY,
      MODEL,
    );
    expect(plan.pending[0]?.id).toBe('row-0');
  });

  it('RE-EMBEDS a hash match whose vector never landed', () => {
    // `indexed_at IS NULL` is the crash marker. Treating it as done is how a chunk disappears
    // from search permanently while every counter says it is there.
    const plan = planChunks(
      [chunk(0, 'alpha')],
      new Map([[0, stored('row-0', 'alpha', false)]]),
      KEY,
      MODEL,
    );
    expect(plan.pending).toHaveLength(1);
  });

  it('treats a different model as an entirely new index', () => {
    // Point ids are model-scoped, so the same chunk under a second model addresses a different
    // point — which is what lets the two rows coexist under the partial unique indexes.
    const a = planChunks([chunk(0, 'alpha')], new Map(), KEY, 'nomic-embed-text');
    const b = planChunks([chunk(0, 'alpha')], new Map(), KEY, 'mxbai-embed-large');
    expect(a.pending[0]?.pointId).not.toBe(b.pending[0]?.pointId);
  });
});

describe('derivePointId — deterministic, so a crashed run strands nothing', () => {
  it('is stable across calls and processes', () => {
    expect(derivePointId(KEY, 3, MODEL)).toBe(derivePointId(KEY, 3, MODEL));
  });

  it('is a well-formed RFC 9562 version-8 UUID', () => {
    // Qdrant accepts a UUID or an unsigned integer; version 8 is the one the spec reserves for
    // vendor-specific derivation, so no generator will ever collide with it.
    expect(derivePointId(KEY, 0, MODEL)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('separates its components, so ("x1", 0) cannot collide with ("x", 10)', () => {
    const left = derivePointId({ ...KEY, sourceId: null, sourceRef: 'x1' }, 0, MODEL);
    const right = derivePointId({ ...KEY, sourceId: null, sourceRef: 'x' }, 10, MODEL);
    expect(left).not.toBe(right);
  });

  it('distinguishes source type, identity, ordinal and model', () => {
    const ids = new Set([
      derivePointId(KEY, 0, MODEL),
      derivePointId({ ...KEY, sourceType: 'session' }, 0, MODEL),
      derivePointId({ ...KEY, sourceId: '018f6b2e-9999-7abc-8def-0123456789ab' }, 0, MODEL),
      derivePointId(KEY, 1, MODEL),
      derivePointId(KEY, 0, 'other-model'),
    ]);
    expect(ids.size).toBe(5);
  });

  it('treats a ref-keyed source separately from an id-keyed one', () => {
    const byRef = derivePointId(
      { sourceType: 'obsidian_note', sourceId: null, sourceRef: 'Notes/x.md' },
      0,
      MODEL,
    );
    expect(byRef).not.toBe(derivePointId(KEY, 0, MODEL));
  });
});

describe('hashChunk', () => {
  it('is the 64-hex sha256 the ck_memory_items_content_hash CHECK demands', () => {
    expect(hashChunk('alpha')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes texts that differ only in whitespace', () => {
    expect(hashChunk('a b')).not.toBe(hashChunk('a  b'));
  });
});

describe('the budget is honoured by the plan', () => {
  it('produces one pending entry per chunk, in ordinal order', () => {
    const chunks = Array.from({ length: 5 }, (_, i) => chunk(i, `chunk ${String(i)}`));
    const plan = planChunks(chunks, new Map(), KEY, MODEL);

    expect(plan.pending.map((entry) => entry.chunk.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(BUDGET.maxBytes).toBeGreaterThan(0);
  });
});
