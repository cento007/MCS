/**
 * `returnTo` sanitisation (TDS 05 §8).
 *
 * > "after login, navigate to `returnTo` (validated as an in-app path — never an absolute
 * > URL, preventing open redirects)."
 *
 * The check is an allowlist, not a blocklist: a value is accepted only if it is a single
 * leading `/` followed by something that cannot be read as an authority. Everything else
 * degrades to `/`. Blocklisting the known-bad prefixes is how open redirects survive —
 * `//evil.test`, `/\evil.test`, `https:/evil.test` and `/%2f%2fevil.test` are all the same
 * bug wearing different hats.
 */

export const DEFAULT_RETURN_TO = '/';

export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return DEFAULT_RETURN_TO;

  let value = raw.trim();
  if (value.length === 0) return DEFAULT_RETURN_TO;

  // A percent-encoded separator becomes a real one the moment the router decodes it, so it
  // has to be resolved before the shape is judged.
  try {
    value = decodeURIComponent(value);
  } catch {
    return DEFAULT_RETURN_TO;
  }

  if (!value.startsWith('/')) return DEFAULT_RETURN_TO;
  // `//host` is protocol-relative and `/\host` is treated as `//host` by several browsers.
  if (value.startsWith('//') || value.startsWith('/\\')) return DEFAULT_RETURN_TO;
  if (value.includes('\\')) return DEFAULT_RETURN_TO;

  // Control characters can smuggle a newline past a naive check further down the stack.
  // Tested by code point rather than by regex so this source file carries no literal
  // control bytes and needs no lint suppression.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return DEFAULT_RETURN_TO;
  }

  // Bouncing back to the login page after a successful login is a loop, not a destination.
  if (value === '/login' || value.startsWith('/login?')) return DEFAULT_RETURN_TO;

  return value;
}

/** Build the redirect the guard and the 401 interceptor both send the operator to. */
export function loginPathFor(currentPath: string): string {
  const target = sanitizeReturnTo(currentPath);
  return target === DEFAULT_RETURN_TO ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`;
}
