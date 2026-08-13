import { describe, expect, it } from 'vitest';
import {
  assertVectorDimension,
  type EmbeddingStamp,
  EmbeddingStampMismatchError,
  formatStamp,
  MEMORY_SCHEMA_VERSION,
  stampsEqual,
  VectorDimensionError,
  verifyStamp,
} from './stamp.js';

/**
 * The embedding stamp — the single most consequential decision in the memory layer, and the one
 * whose failure is silent.
 *
 * Every test here is really the same assertion in a different shape: **a collection whose stamp
 * disagrees with settings must refuse, loudly, rather than serve.** `verifyStamp` is pure, so
 * every branch of that decision is provable without a network, a database or an install.
 */

const NOMIC: EmbeddingStamp = { model: 'nomic-embed-text', dimension: 768 };
const OTHER: EmbeddingStamp = { model: 'mxbai-embed-large', dimension: 1024 };

function verify(
  input: Partial<Parameters<typeof verifyStamp>[0]> = {},
): ReturnType<typeof verifyStamp> {
  return verifyStamp({
    collection: 'mc_memory',
    expected: NOMIC,
    found: NOMIC,
    foundSchemaVersion: MEMORY_SCHEMA_VERSION,
    hasPoints: true,
    ...input,
  });
}

describe('a matching stamp', () => {
  it('accepts a collection whose model and dimension agree', () => {
    expect(verify()).toEqual({ kind: 'match' });
  });

  it('accepts when the collection predates schema-version stamping', () => {
    // An older stamp with no `schemaVersion` is not evidence of a *different* version.
    expect(verify({ foundSchemaVersion: null })).toEqual({ kind: 'match' });
  });
});

describe('a changed model refuses', () => {
  it('throws, and names both the configured model and the stored one', () => {
    let thrown: unknown;
    try {
      verify({ expected: NOMIC, found: { model: 'mxbai-embed-large', dimension: 768 } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EmbeddingStampMismatchError);
    const error = thrown as EmbeddingStampMismatchError;
    expect(error.detail.kind).toBe('model');
    // Both values, so an operator can tell which one to change.
    expect(error.message).toContain('nomic-embed-text');
    expect(error.message).toContain('mxbai-embed-large');
    // And what to do about it — a message that only states the fault is a support ticket.
    expect(error.message).toContain('re-index');
    expect(error.message).toContain('mc_memory');
  });

  it('explains why serving would be worse than failing', () => {
    expect(() => verify({ found: { model: 'other-model', dimension: 768 } })).toThrow(
      /confident nonsense/i,
    );
  });
});

describe('a changed dimension refuses', () => {
  it('throws and names both dimensions', () => {
    let thrown: unknown;
    try {
      verify({ expected: OTHER, found: { model: 'mxbai-embed-large', dimension: 768 } });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as EmbeddingStampMismatchError;
    expect(error.detail.kind).toBe('dimension');
    expect(error.message).toContain('768');
    expect(error.message).toContain('1024');
  });

  it('reports the model mismatch first when both halves disagree', () => {
    // Both are wrong; the model is what the operator actually edited, so it leads.
    let thrown: unknown;
    try {
      verify({ expected: NOMIC, found: OTHER });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as EmbeddingStampMismatchError).detail.kind).toBe('model');
  });
});

describe('an unstamped collection', () => {
  it('is adoptable when empty — nothing in it can be wrong', () => {
    expect(verify({ found: null, foundSchemaVersion: null, hasPoints: false })).toEqual({
      kind: 'adoptable',
    });
  });

  it('is refused when it already holds points, because its contents are unknowable', () => {
    let thrown: unknown;
    try {
      verify({ found: null, foundSchemaVersion: null, hasPoints: true });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as EmbeddingStampMismatchError;
    expect(error.detail.kind).toBe('unstamped');
    expect(error.detail.found).toBeNull();
    expect(error.message).toContain('no way to tell which embedding model produced them');
  });
});

describe('a changed schema version refuses', () => {
  it('throws even when the model and dimension both still agree', () => {
    let thrown: unknown;
    try {
      verify({ foundSchemaVersion: MEMORY_SCHEMA_VERSION + 1 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as EmbeddingStampMismatchError).detail.kind).toBe('schema_version');
  });
});

describe('vector width', () => {
  it('accepts a vector of exactly the stamped dimension', () => {
    expect(() => {
      assertVectorDimension(new Array<number>(768).fill(0), 768);
    }).not.toThrow();
  });

  it('refuses a vector of the wrong width and names the point', () => {
    let thrown: unknown;
    try {
      assertVectorDimension([1, 2, 3], 768, 'point-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VectorDimensionError);
    const error = thrown as VectorDimensionError;
    expect(error.expected).toBe(768);
    expect(error.actual).toBe(3);
    expect(error.message).toContain('point-1');
    expect(error.message).toContain('embeddingModel');
  });
});

describe('helpers', () => {
  it('compares both halves of a stamp', () => {
    expect(stampsEqual(NOMIC, { ...NOMIC })).toBe(true);
    expect(stampsEqual(NOMIC, { ...NOMIC, dimension: 767 })).toBe(false);
    expect(stampsEqual(NOMIC, { ...NOMIC, model: 'NOMIC-EMBED-TEXT' })).toBe(false);
  });

  it('formats a stamp the way every message shows it', () => {
    expect(formatStamp(NOMIC)).toBe('nomic-embed-text (768d)');
  });
});
