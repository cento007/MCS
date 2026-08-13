import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile, MARKDOWN_MIME, safeFilename } from './download.js';

/**
 * The download path, which exists to *not* be a navigation (TDS 04 §6.7).
 *
 * The assertion that matters is negative: nothing here may reach the network. A `window.open`
 * or an `<a href="/api/v1/sessions/…/export">` would look identical on screen — a file appears —
 * and would silently lose the F5.4 error envelope, turning a `409 CONFLICT` into a downloaded
 * file containing an error object.
 */

let objectUrls: Blob[];
let revoked: string[];
let clicks: { href: string; download: string }[];

beforeEach(() => {
  objectUrls = [];
  revoked = [];
  clicks = [];

  // jsdom implements neither. They are defined rather than stubbed with `vi.stubGlobal` so the
  // real `URL` keeps every other method.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      objectUrls.push(blob);
      return `blob:mock/${objectUrls.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });

  // Spied rather than allowed through: jsdom would attempt to navigate to the blob URL, which
  // is both noise and the exact behaviour this module must never produce.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('downloadTextFile', () => {
  it('builds a Blob from the content it was given and never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    downloadTextFile({ filename: 'session-export.md', content: '# Session\n\nbody' });

    expect(objectUrls).toHaveLength(1);
    const blob = objectUrls[0] as Blob;
    expect(blob.type).toBe(MARKDOWN_MIME);
    await expect(blob.text()).resolves.toBe('# Session\n\nbody');

    // The two ways of getting this wrong, asserted as absent rather than assumed.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('names the file from the server’s suggestion, on a real `download` anchor', () => {
    downloadTextFile({ filename: 'session-2026-08-13-8b1c4f-Refactor.md', content: 'x' });

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe('session-2026-08-13-8b1c4f-Refactor.md');
    expect(clicks[0]?.href).toMatch(/^blob:/);
  });

  it('removes the anchor immediately and revokes the object URL afterwards', async () => {
    downloadTextFile({ filename: 'a.md', content: 'x' });

    // No orphan anchor left in the document — this runs on every export of a long session.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);

    // Revocation is deferred by one task so the browser can read the blob first.
    expect(revoked).toHaveLength(0);
    // `toContain` rather than `toEqual`: the deferred revocations of *earlier* tests in this file
    // land in whatever array is current when their timer fires, which is this one.
    await vi.waitFor(() => expect(revoked).toContain('blob:mock/1'));
  });
});

describe('safeFilename', () => {
  it('keeps a name legal on Windows and Ubuntu alike', () => {
    expect(
      safeFilename(['context-package', '2026-08-13', 'a1b2c3', 'Fix: the login/redirect'], '.md'),
    ).toBe('context-package-2026-08-13-a1b2c3-Fix-the-login-redirect.md');
  });

  it('survives a title that is entirely unprintable rather than producing `.md`', () => {
    expect(safeFilename(['', '★ ☆ ✦'], '.md')).toBe('document.md');
  });

  it('is deterministic, so regenerating replaces instead of accumulating copies', () => {
    const parts = ['context-package', '2026-08-13', 'a1b2c3', 'Refactor the queue port'];
    expect(safeFilename(parts, '.md')).toBe(safeFilename(parts, '.md'));
  });
});
