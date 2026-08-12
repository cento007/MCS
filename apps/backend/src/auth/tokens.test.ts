import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * `node:crypto` is mocked only to observe `timingSafeEqual`. Everything else is the real
 * implementation — this is how "timing-safe **by construction**" is asserted without timing
 * anything: the test proves the comparison *delegates* to the constant-time primitive and
 * never short-circuits on content, which is a property a wall-clock measurement could only
 * ever suggest.
 */
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { timingSafeEqual } = await import('node:crypto');
const {
  API_TOKEN_PREFIX,
  API_TOKEN_PREFIX_LENGTH,
  apiTokenPrefix,
  generateApiToken,
  generateSessionToken,
  hashToken,
  looksLikeApiToken,
  timingSafeHexEquals,
} = await import('./tokens.js');

const spy = vi.mocked(timingSafeEqual);

describe('opaque credential generation', () => {
  it('issues session tokens with 256 bits of entropy, cookie-safe', () => {
    const token = generateSessionToken();

    // 32 bytes base64url = 43 characters, no padding, no cookie-hostile characters.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(token);
  });

  it('issues API tokens as mct_<43 chars> (TDS 04 §1.4)', () => {
    const token = generateApiToken();

    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token).toMatch(/^mct_[A-Za-z0-9_-]{43}$/);
    expect(generateApiToken()).not.toBe(token);
  });

  it('derives the display prefix from the first 8 characters (TDS 03 §3.3)', () => {
    const token = generateApiToken();
    const prefix = apiTokenPrefix(token);

    expect(prefix).toHaveLength(API_TOKEN_PREFIX_LENGTH);
    expect(prefix.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token.startsWith(prefix)).toBe(true);
  });

  it('recognises the token shape before spending a database round-trip', () => {
    expect(looksLikeApiToken(generateApiToken())).toBe(true);
    expect(looksLikeApiToken('mct_')).toBe(false);
    expect(looksLikeApiToken(generateSessionToken())).toBe(false);
    expect(looksLikeApiToken('')).toBe(false);
  });
});

describe('storage form', () => {
  it('stores only the SHA-256 hex digest of the presented value', () => {
    const token = generateApiToken();
    const digest = hashToken(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(digest).not.toContain(token.slice(4));
  });

  it('is stable and collision-distinct', () => {
    expect(hashToken('mct_abc')).toBe(hashToken('mct_abc'));
    expect(hashToken('mct_abc')).not.toBe(hashToken('mct_abd'));
  });
});

describe('timing-safe comparison (by construction)', () => {
  const digest = hashToken('mct_reference-token');

  it('accepts equal digests through crypto.timingSafeEqual', () => {
    spy.mockClear();

    expect(timingSafeHexEquals(digest, hashToken('mct_reference-token'))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const [left, right] = spy.mock.calls[0] ?? [];
    // 32 raw bytes each — the whole digest is compared, not a prefix.
    expect((left as Buffer).byteLength).toBe(32);
    expect((right as Buffer).byteLength).toBe(32);
  });

  it('does NOT short-circuit on content: a first-byte and a last-byte difference both delegate', () => {
    const firstByteDiff = `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;
    const lastByteDiff = `${digest.slice(0, -1)}${digest.at(-1) === '0' ? '1' : '0'}`;

    spy.mockClear();
    expect(timingSafeHexEquals(digest, firstByteDiff)).toBe(false);
    expect(timingSafeHexEquals(digest, lastByteDiff)).toBe(false);

    // Two calls, not one: an implementation that bailed out on the first differing byte
    // would have skipped the constant-time comparison for the early mismatch.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rejects a length mismatch without comparing — length is not secret', () => {
    spy.mockClear();

    expect(timingSafeHexEquals(digest, digest.slice(0, 63))).toBe(false);
    expect(timingSafeHexEquals(digest, '')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects non-hex input of the right length instead of throwing', () => {
    spy.mockClear();

    // 'zz…' is not hex: Buffer.from decodes it short, which must not blow up in the guard.
    expect(timingSafeHexEquals(digest, 'z'.repeat(64))).toBe(false);
  });
});
