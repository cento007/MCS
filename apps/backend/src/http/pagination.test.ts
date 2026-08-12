import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import {
  clampLimit,
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  decodeIdCursor,
  encodeCursor,
  MAX_PAGE_LIMIT,
  paginate,
} from './pagination.js';

const ID = '018f6b2e-0000-7000-8000-000000000001';

/** F5.3 / TDS 04 §1.2 — opaque, base64-encoded cursor over the resource's ordering key. */
describe('cursor encoding', () => {
  it('round-trips the ordering key', () => {
    expect(decodeCursor(encodeCursor(ID))).toBe(ID);
  });

  it('is opaque: the raw key is not readable in the cursor', () => {
    expect(encodeCursor(ID)).not.toContain(ID);
  });

  it('rejects a foreign or corrupt cursor with INVALID_CURSOR', () => {
    for (const bad of ['not a cursor!!', '', '@@@@']) {
      expect(() => decodeCursor(bad)).toThrow(ApiError);
      try {
        decodeCursor(bad);
      } catch (error) {
        expect((error as ApiError).code).toBe('INVALID_CURSOR');
        expect((error as ApiError).statusCode).toBe(400);
      }
    }
  });

  it('rejects a well-formed cursor whose key is not an id', () => {
    expect(() => decodeIdCursor(encodeCursor('DROP TABLE users'))).toThrow(ApiError);
  });

  it('passes undefined through — no cursor means the first page', () => {
    expect(decodeIdCursor(undefined)).toBeUndefined();
  });
});

describe('limit clamping', () => {
  it('defaults to 50 and caps at 200 (F5.3)', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(1000)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(25)).toBe(25);
  });
});

describe('list envelope', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];

  it('emits nextCursor only when the page was filled', () => {
    const full = paginate(rows, 2, (row) => row.id);
    expect(full.meta.nextCursor).toBe(encodeCursor('b'));
    expect(full.meta.limit).toBe(2);

    const partial = paginate(rows, 50, (row) => row.id);
    expect(partial.meta.nextCursor).toBeNull();
    expect(partial.meta.limit).toBe(50);
  });

  it('emits nextCursor null for an empty page', () => {
    expect(paginate([], 50, () => '').meta.nextCursor).toBeNull();
  });
});
