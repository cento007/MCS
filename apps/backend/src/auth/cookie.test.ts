import { describe, expect, it } from 'vitest';
import {
  readCookie,
  SESSION_COOKIE_NAME,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from './cookie.js';

/** TDS 04 §1.4: `mc_session`; HTTP-only, `SameSite=Lax`, `Secure` when served over HTTPS. */
describe('session cookie serialization', () => {
  it('sets the contract attributes', () => {
    const header = serializeSessionCookie('opaque-token', { secure: false, maxAgeSeconds: 600 });

    expect(header.startsWith(`${SESSION_COOKIE_NAME}=opaque-token;`)).toBe(true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=600');
  });

  it('omits Secure over plain HTTP and adds it over HTTPS — never hardcoded', () => {
    expect(serializeSessionCookie('t', { secure: false, maxAgeSeconds: 60 })).not.toContain(
      'Secure',
    );
    expect(serializeSessionCookie('t', { secure: true, maxAgeSeconds: 60 })).toContain('; Secure');
  });

  it('never emits a negative or fractional Max-Age', () => {
    expect(serializeSessionCookie('t', { secure: false, maxAgeSeconds: -10 })).toContain(
      'Max-Age=0',
    );
    expect(serializeSessionCookie('t', { secure: false, maxAgeSeconds: 1.7 })).toContain(
      'Max-Age=1',
    );
  });

  it('clears with an empty value, Max-Age=0 and the same attributes', () => {
    const header = serializeClearedSessionCookie({ secure: false });

    expect(header.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
  });
});

describe('cookie reading', () => {
  it('reads the named cookie from a multi-cookie header', () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc123; other=1`;
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe('abc123');
  });

  it('returns null when absent or when the header is missing', () => {
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie('', SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie('theme=dark', SESSION_COOKIE_NAME)).toBeNull();
  });

  it('matches the name exactly — no prefix or suffix confusion', () => {
    expect(readCookie(`x${SESSION_COOKIE_NAME}=evil`, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE_NAME}_other=evil`, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(`not_${SESSION_COOKIE_NAME}=evil`, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('takes the first value when the name appears twice', () => {
    const header = `${SESSION_COOKIE_NAME}=first; ${SESSION_COOKIE_NAME}=second`;
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe('first');
  });

  it('treats an empty value as absent', () => {
    expect(readCookie(`${SESSION_COOKIE_NAME}=`, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE_NAME}=   `, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('tolerates junk segments without a delimiter', () => {
    expect(readCookie(`junk; ${SESSION_COOKIE_NAME}=ok`, SESSION_COOKIE_NAME)).toBe('ok');
  });
});
