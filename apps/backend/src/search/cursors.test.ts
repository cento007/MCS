import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { decodeSearchCursor, encodeSearchCursor, searchFingerprint } from './cursors.js';
import { SEARCH_TYPES } from './types.js';

/**
 * The `(rank, occurredAt, id)` cursor and its `q`/`types` binding (TDS 04 §11).
 *
 * No database — pagination *over real ranks* is proved in `search.int.test.ts`, because only
 * PostgreSQL can produce the equal-rank runs that make the tiebreak matter. What is proved here
 * is the encoding contract: opaque, exact, and refused when the search changed.
 */

const FINGERPRINT = searchFingerprint('retry budget', SEARCH_TYPES);

const CURSOR = {
  rankKey: '0.06079271',
  occurredAt: new Date('2026-08-12T10:00:00.000Z'),
  id: '0198f6b2-0000-7000-8000-000000000001',
};

function rejectionOf(call: () => unknown): ApiError {
  try {
    call();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected an ApiError');
}

describe('searchFingerprint', () => {
  it('is stable for the same search', () => {
    expect(searchFingerprint('retry budget', ['adr', 'session'])).toBe(
      searchFingerprint('retry budget', ['adr', 'session']),
    );
  });

  it('changes when `q` changes', () => {
    expect(searchFingerprint('retry budget', SEARCH_TYPES)).not.toBe(
      searchFingerprint('retry budgets', SEARCH_TYPES),
    );
  });

  it('changes when `types` changes', () => {
    expect(searchFingerprint('retry', ['adr'])).not.toBe(searchFingerprint('retry', ['commit']));
    expect(searchFingerprint('retry', ['adr'])).not.toBe(
      searchFingerprint('retry', ['adr', 'commit']),
    );
  });

  it('does not distinguish `q` from `types` by concatenation', () => {
    // A naive `q + types.join(',')` fingerprint collides here: both sides are the string
    // "a" + "adr". Encoding the pair structurally is what keeps them apart.
    expect(searchFingerprint('aadr', ['session'])).not.toBe(searchFingerprint('a', ['adr']));
  });
});

describe('search cursor', () => {
  it('round-trips the ordering triple', () => {
    const decoded = decodeSearchCursor(encodeSearchCursor(CURSOR, FINGERPRINT), FINGERPRINT);

    expect(decoded).toEqual(CURSOR);
  });

  it('preserves the rank as text, not as a JS number', () => {
    // The keyset casts this straight back to `real` and compares it for equality against the
    // same expression that produced it. A float round-trip through JS is the one step that can
    // turn "the same rank" into "a different rank" and drop a row at the page boundary.
    const rankKey = '1.0000001e-05';
    const encoded = encodeSearchCursor({ ...CURSOR, rankKey }, FINGERPRINT);

    expect(decodeSearchCursor(encoded, FINGERPRINT)?.rankKey).toBe(rankKey);
  });

  it('is opaque and base64url — no padding, no `+`, no `/` (F5.3)', () => {
    const encoded = encodeSearchCursor(CURSOR, FINGERPRINT);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toContain(CURSOR.id);
  });

  it('passes `undefined` through — the first page has no cursor', () => {
    expect(decodeSearchCursor(undefined, FINGERPRINT)).toBeUndefined();
  });

  it('refuses a cursor minted for a different `q`', () => {
    const encoded = encodeSearchCursor(CURSOR, searchFingerprint('retry budget', SEARCH_TYPES));
    const error = rejectionOf(() =>
      decodeSearchCursor(encoded, searchFingerprint('retry budgets', SEARCH_TYPES)),
    );

    expect(error.code).toBe('INVALID_CURSOR');
    expect(error.statusCode).toBe(400);
    expect(error.details).toMatchObject({ invalidatedBy: ['q', 'types'] });
  });

  it('refuses a cursor minted for a different `types`', () => {
    const encoded = encodeSearchCursor(CURSOR, searchFingerprint('retry', ['session', 'adr']));
    const error = rejectionOf(() =>
      decodeSearchCursor(encoded, searchFingerprint('retry', ['session'])),
    );

    expect(error.code).toBe('INVALID_CURSOR');
  });

  it('refuses a cursor from another resource', () => {
    // A `GET /sessions` cursor is a bare UUIDv7; feeding it here must not be a 500.
    const foreign = Buffer.from(CURSOR.id, 'utf8').toString('base64url');

    expect(rejectionOf(() => decodeSearchCursor(foreign, FINGERPRINT)).code).toBe('INVALID_CURSOR');
  });

  it('refuses malformed payloads without reaching PostgreSQL', () => {
    const malformed = [
      // Wrong arity.
      [FINGERPRINT, '0.1', new Date().toISOString()].join('|'),
      // Unparseable timestamp.
      [FINGERPRINT, '0.1', 'lastTuesday', CURSOR.id].join('|'),
      // Empty id.
      [FINGERPRINT, '0.1', new Date().toISOString(), ''].join('|'),
      // A rank that is not a float literal — this is the one that would otherwise become a
      // `::real` cast error (a 500) instead of a rejected cursor (a 400).
      [FINGERPRINT, "0.1'::real--", new Date().toISOString(), CURSOR.id].join('|'),
      [FINGERPRINT, 'NaN', new Date().toISOString(), CURSOR.id].join('|'),
    ];

    for (const payload of malformed) {
      const encoded = Buffer.from(payload, 'utf8').toString('base64url');
      expect(rejectionOf(() => decodeSearchCursor(encoded, FINGERPRINT)).code, payload).toBe(
        'INVALID_CURSOR',
      );
    }
  });

  it('refuses a value that is not a cursor at all', () => {
    expect(rejectionOf(() => decodeSearchCursor('!!!not base64!!!', FINGERPRINT)).code).toBe(
      'INVALID_CURSOR',
    );
  });
});
