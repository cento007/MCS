import { describe, expect, it, vi } from 'vitest';
import { deriveServerOrigins, normalizeOrigin, OriginAllowlist } from './origin.js';

/**
 * Origin allowlist (TDS 04 §14.2) — the cross-site WebSocket hijacking defense.
 *
 * This is the highest-value unit file in `ws/`: every case below is an attack shape that
 * `SameSite=Lax` does not stop. The end-to-end proof (real cookie, real upgrade, foreign
 * Origin) lives in `ws.int.test.ts`; these tests pin the matching rules themselves, in the
 * tier that runs on every change with no database.
 */

const OWN_ORIGIN = 'http://127.0.0.1:8710';

function allowlist(configured: readonly string[] = [], overrides: { now?: () => number } = {}) {
  return new OriginAllowlist({
    host: '127.0.0.1',
    port: 8710,
    isDevelopment: false,
    readConfiguredOrigins: async () => configured,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

describe('normalizeOrigin', () => {
  it('canonicalises scheme and host case', () => {
    expect(normalizeOrigin('HTTP://LocalHost:5173')).toBe('http://localhost:5173');
  });

  it('collapses the default port so both sides of a comparison agree', () => {
    expect(normalizeOrigin('http://example.test:80')).toBe('http://example.test');
    expect(normalizeOrigin('https://example.test:443')).toBe('https://example.test');
  });

  it('drops anything past the origin', () => {
    expect(normalizeOrigin('http://example.test:8710/evil?x=1')).toBe('http://example.test:8710');
  });

  it.each([
    ['the literal null origin a sandboxed iframe sends', 'null'],
    ['an empty header', ''],
    ['whitespace', '   '],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a data URL', 'data:text/html,<script>'],
    ['a chrome extension', 'chrome-extension://abcdef'],
    ['a bare hostname', 'example.test'],
    ['nonsense', 'http://'],
  ])('rejects %s', (_label, value) => {
    expect(normalizeOrigin(value)).toBeNull();
  });

  it('rejects an absurdly long header rather than parsing it', () => {
    expect(normalizeOrigin(`http://${'a'.repeat(4000)}.test`)).toBeNull();
  });
});

describe('deriveServerOrigins', () => {
  it('includes the bound host and its loopback aliases for a loopback bind', () => {
    const origins = deriveServerOrigins({ host: '127.0.0.1', port: 8710, isDevelopment: false });

    expect(origins.has('http://127.0.0.1:8710')).toBe(true);
    expect(origins.has('http://localhost:8710')).toBe(true);
    expect(origins.has('http://[::1]:8710')).toBe(true);
    // Same application, TLS in front of it (§14.2 "http(s)").
    expect(origins.has('https://127.0.0.1:8710')).toBe(true);
  });

  it('contributes only loopback aliases for a wildcard bind', () => {
    const origins = deriveServerOrigins({ host: '0.0.0.0', port: 8710, isDevelopment: false });

    expect(origins.has('http://localhost:8710')).toBe(true);
    // `http://0.0.0.0:8710` is not an origin any browser sends.
    expect(origins.has('http://0.0.0.0:8710')).toBe(false);
  });

  it('adds the Vite dev-server origin only in development', () => {
    expect(
      deriveServerOrigins({ host: '127.0.0.1', port: 8710, isDevelopment: true }).has(
        'http://localhost:5173',
      ),
    ).toBe(true);
    expect(
      deriveServerOrigins({ host: '127.0.0.1', port: 8710, isDevelopment: false }).has(
        'http://localhost:5173',
      ),
    ).toBe(false);
  });

  it('never contains a wildcard entry', () => {
    const origins = deriveServerOrigins({ host: '127.0.0.1', port: 8710, isDevelopment: true });

    for (const origin of origins) expect(origin).not.toContain('*');
  });
});

describe('OriginAllowlist', () => {
  it('allows the backend origin it derived from bootstrap config', async () => {
    await expect(allowlist().isAllowed(OWN_ORIGIN)).resolves.toBe(true);
  });

  it('rejects a foreign origin', async () => {
    await expect(allowlist().isAllowed('https://evil.example')).resolves.toBe(false);
  });

  it('rejects a foreign origin on the same port', async () => {
    await expect(allowlist().isAllowed('http://evil.example:8710')).resolves.toBe(false);
  });

  it('rejects a different port on the same host', async () => {
    await expect(allowlist().isAllowed('http://127.0.0.1:8711')).resolves.toBe(false);
  });

  it('rejects Origin: null', async () => {
    await expect(allowlist().isAllowed('null')).resolves.toBe(false);
  });

  it('does not suffix-match a trusted origin', async () => {
    const list = allowlist(['https://mission.control.example']);

    await expect(list.isAllowed('https://evil-mission.control.example')).resolves.toBe(false);
    await expect(list.isAllowed('https://mission.control.example.evil.test')).resolves.toBe(false);
    await expect(list.isAllowed('https://mission.control.example')).resolves.toBe(true);
  });

  it('does not treat a stored entry with a path as a prefix rule', async () => {
    const list = allowlist(['https://proxy.example/mission-control']);

    await expect(list.isAllowed('https://proxy.example')).resolves.toBe(true);
    await expect(list.isAllowed('https://proxy.example.evil.test')).resolves.toBe(false);
  });

  it('ignores unusable entries in the stored setting', async () => {
    const list = allowlist(['not an origin', 'null', 'ftp://x.test', 'https://ok.example']);

    await expect(list.isAllowed('https://ok.example')).resolves.toBe(true);
    await expect(list.isAllowed('null')).resolves.toBe(false);
  });

  it('caches the stored half and re-reads after invalidate()', async () => {
    let stored: string[] = [];
    const read = vi.fn(async () => stored);
    const list = new OriginAllowlist({
      host: '127.0.0.1',
      port: 8710,
      isDevelopment: false,
      readConfiguredOrigins: read,
    });

    await expect(list.isAllowed('https://later.example')).resolves.toBe(false);
    stored = ['https://later.example'];
    await expect(list.isAllowed('https://later.example')).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    list.invalidate();
    await expect(list.isAllowed('https://later.example')).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('re-reads once the TTL lapses even without an invalidate', async () => {
    let now = 0;
    let stored: string[] = [];
    const list = new OriginAllowlist({
      host: '127.0.0.1',
      port: 8710,
      isDevelopment: false,
      readConfiguredOrigins: async () => stored,
      cacheTtlMs: 1000,
      now: () => now,
    });

    await list.entries();
    stored = ['https://later.example'];
    now = 2000;

    await expect(list.isAllowed('https://later.example')).resolves.toBe(true);
  });

  it('collapses a burst of concurrent misses into one read', async () => {
    const read = vi.fn(async () => []);
    const list = new OriginAllowlist({
      host: '127.0.0.1',
      port: 8710,
      isDevelopment: false,
      readConfiguredOrigins: read,
    });

    await Promise.all([list.entries(), list.entries(), list.entries()]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('falls back to the derived origins when the settings read fails', async () => {
    const onReadError = vi.fn();
    const list = new OriginAllowlist({
      host: '127.0.0.1',
      port: 8710,
      isDevelopment: false,
      readConfiguredOrigins: async () => {
        throw new Error('database is down');
      },
      onReadError,
    });

    // The stored half can only ever ADD origins, so losing it cannot admit an untrusted one.
    await expect(list.isAllowed(OWN_ORIGIN)).resolves.toBe(true);
    await expect(list.isAllowed('https://evil.example')).resolves.toBe(false);
    expect(onReadError).toHaveBeenCalledOnce();
  });
});
