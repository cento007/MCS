import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeToolPath } from './files.js';

/**
 * The path-dialect reconciliation at the heart of §6.10.2. Commit paths arrive
 * repository-relative with `/` separators (git's own form); tool paths arrive as whatever
 * absolute native path the runtime reported. Getting this wrong lists every edited file twice.
 *
 * Written with `node:path` primitives rather than hard-coded strings so it asserts the same
 * behaviour on Windows and Ubuntu (F8.1) — a test that only passes on one OS is a defect.
 */

const root = join(tmpdir(), 'mc-root');

describe('normalizeToolPath', () => {
  it('rewrites an in-tree absolute path root-relative with `/` separators', () => {
    const result = normalizeToolPath(root, join(root, 'apps', 'backend', 'src', 'app.ts'));

    expect(result).toEqual({ path: 'apps/backend/src/app.ts', outsideRoot: false });
    expect(result.path).not.toContain('\\');
  });

  it('keeps an out-of-tree absolute path verbatim and flags it', () => {
    const outside = join(tmpdir(), 'mc-elsewhere', 'config');
    const result = normalizeToolPath(root, outside);

    // Surfaced, never hidden: silently dropping out-of-tree touches would make the panel a
    // comfort blanket rather than a record (§6.10.2 step 2).
    expect(result).toEqual({ path: outside, outsideRoot: true });
    expect(isAbsolute(result.path)).toBe(true);
  });

  it('treats the root itself as outside — it is not a file the Session touched', () => {
    expect(normalizeToolPath(root, root)).toEqual({ path: root, outsideRoot: true });
  });

  it('does not mistake a sibling whose name starts with the root for a child', () => {
    const sibling = `${root}-backup${sep}notes.md`;
    expect(normalizeToolPath(root, sibling).outsideRoot).toBe(true);
  });

  it('normalizes a relative path without claiming to resolve it', () => {
    expect(normalizeToolPath(root, join('src', 'app.ts'))).toEqual({
      path: 'src/app.ts',
      outsideRoot: false,
    });
  });

  it('flags everything when the Session has no root at all', () => {
    // A Session with neither a repository nor a working directory cannot make a relative claim.
    const result = normalizeToolPath('', join(root, 'src', 'app.ts'));
    expect(result.outsideRoot).toBe(true);
  });

  it('groups on the exact normalized string — the accepted case-sensitivity residual', () => {
    const lower = normalizeToolPath(root, join(root, 'src', 'queue.ts'));
    const upper = normalizeToolPath(root, join(root, 'src', 'Queue.ts'));

    // §6.10.2 step 4 accepts this: case-folding on Windows only would make API behaviour depend
    // on which OS the server runs, which is a worse defect than a rare duplicate row.
    expect(lower.path).not.toBe(upper.path);
  });
});
