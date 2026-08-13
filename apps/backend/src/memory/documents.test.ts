import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_DIRECTORIES,
  DOCUMENT_EXTENSIONS,
  isDocumentFile,
  isInside,
  scanRepositoryDocuments,
} from './documents.js';

/**
 * The documentation walk — the half of PRD §6.3's sixth source that decides *what to look at*.
 *
 * No database, no embedder, no network: a real temp directory built per case, because the whole
 * claim under test is a filesystem one and a mocked `fs` would be testing the mock. The repo
 * this file lives in is never scanned — the fixtures are built under the OS temp root and
 * removed in teardown.
 *
 * The claim: **a repository is not documentation.** Root Markdown plus a root-level `docs/`
 * tree, and nothing else — because "every `.md`, recursively" is how `node_modules` ends up in
 * a vector store, and because a bound that is only enforced by an operator's discipline is not
 * a bound.
 */

let root: string;

function write(relativePath: string, content = '# heading\n\nbody text\n'): void {
  const absolute = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function paths(files: readonly { relativePath: string }[]): string[] {
  return files.map((file) => file.relativePath).sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-docs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('what counts as documentation', () => {
  it('takes root Markdown and the docs tree, and nothing else', async () => {
    write('README.md');
    write('Requirements.md');
    write('docs/tds/03-database-schema.md');
    write('doc/legacy.md');
    write('documentation/guide.markdown');
    // Not documentation: source-adjacent prose, build output, dependencies.
    write('src/memory/README.md');
    write('node_modules/left-pad/README.md');
    write('dist/docs/generated.md');
    write('src/app.ts', 'export const x = 1;\n');

    const scan = await scanRepositoryDocuments(root);

    expect(paths(scan.files)).toEqual([
      'README.md',
      'Requirements.md',
      'doc/legacy.md',
      'docs/tds/03-database-schema.md',
      'documentation/guide.markdown',
    ]);
    expect(scan.truncated).toBe(false);
  });

  it('does not descend into node_modules even when it sits inside docs/', async () => {
    // A docs site with its own dependencies is a real thing, and it is the single largest way
    // this stage could flood the index.
    write('docs/index.md');
    write('docs/node_modules/pkg/README.md');
    write('docs/.vitepress/cache/x.md');

    expect(paths((await scanRepositoryDocuments(root)).files)).toEqual(['docs/index.md']);
  });

  it('is case-insensitive about the directory name and the extension', async () => {
    write('Docs/Guide.MD');
    write('README.MARKDOWN');

    expect(paths((await scanRepositoryDocuments(root)).files)).toEqual([
      'Docs/Guide.MD',
      'README.MARKDOWN',
    ]);
  });

  it('admits only the declared extensions', () => {
    expect(DOCUMENT_EXTENSIONS).toEqual(['.md', '.markdown']);
    expect(isDocumentFile('README.md')).toBe(true);
    expect(isDocumentFile('notes.markdown')).toBe(true);
    expect(isDocumentFile('index.mdx')).toBe(false);
    expect(isDocumentFile('README.txt')).toBe(false);
    expect(isDocumentFile('app.ts')).toBe(false);
  });

  it('names the documentation directories in one place', () => {
    expect(DOCUMENT_DIRECTORIES).toEqual(['docs', 'doc', 'documentation']);
  });

  it('treats a repository with no docs and no root Markdown as empty, not as a failure', async () => {
    write('src/app.ts', 'export const x = 1;\n');
    const scan = await scanRepositoryDocuments(root);

    expect(scan.files).toEqual([]);
    expect(scan.truncated).toBe(false);
  });

  it('treats a path that does not exist as empty, not as a throw', async () => {
    const scan = await scanRepositoryDocuments(join(root, 'gone'));
    expect(scan.files).toEqual([]);
    expect(scan.truncated).toBe(false);
  });
});

describe('the bounds', () => {
  it('stops at the file cap and says the scan was truncated', async () => {
    for (let index = 0; index < 6; index += 1) write(`docs/page-${String(index)}.md`);

    const scan = await scanRepositoryDocuments(root, { maxFilesPerRepository: 3 });

    expect(scan.files).toHaveLength(3);
    expect(scan.truncated).toBe(true);
    // A truncated scan is what makes the caller skip the purge; the reason has to be nameable.
    expect(scan.truncatedReason).toContain('more than 3 documentation files');
  });

  it('counts an over-sized file as oversized and never reads it', async () => {
    write('docs/huge.md', 'x'.repeat(4_000));
    write('docs/small.md');

    const scan = await scanRepositoryDocuments(root, { maxFileBytes: 1_000 });

    expect(paths(scan.files)).toEqual(['docs/small.md']);
    expect(scan.oversized).toBe(1);
    // Skipping one file is not truncation: everything else was still seen, so the purge is safe.
    expect(scan.truncated).toBe(false);
  });

  it('stops on the total byte budget rather than reading a whole docs site', async () => {
    for (let index = 0; index < 5; index += 1)
      write(`docs/page-${String(index)}.md`, 'y'.repeat(500));

    const scan = await scanRepositoryDocuments(root, { maxTotalBytes: 1_200 });

    expect(scan.truncated).toBe(true);
    expect(scan.truncatedReason).toContain('exceeded 1200 bytes');
  });

  it('stops on depth rather than following a pathological tree', async () => {
    write('docs/a/b/c/d/e/f/deep.md');

    const scan = await scanRepositoryDocuments(root, { maxDepth: 3 });

    expect(scan.files).toEqual([]);
    expect(scan.truncatedReason).toContain('nesting exceeded 3 levels');
  });

  it('stops on the deadline with an injected clock, not by waiting for one', async () => {
    write('docs/a.md');
    write('docs/b.md');

    let ticks = 0;
    const scan = await scanRepositoryDocuments(root, {
      deadlineMs: 0,
      now: () => {
        ticks += 1;
        return ticks;
      },
    });

    expect(scan.truncated).toBe(true);
    expect(scan.truncatedReason).toContain('deadline elapsed');
  });

  it('returns files in a stable order, so two truncated scans truncate the same way', async () => {
    for (const name of ['zeta', 'alpha', 'mid']) write(`docs/${name}.md`);

    const first = await scanRepositoryDocuments(root, { maxFilesPerRepository: 2 });
    const second = await scanRepositoryDocuments(root, { maxFilesPerRepository: 2 });

    expect(first.files.map((file) => file.relativePath)).toEqual(['docs/alpha.md', 'docs/mid.md']);
    expect(first.files.map((file) => file.relativePath)).toEqual(
      second.files.map((file) => file.relativePath),
    );
  });
});

describe('the exclusion callback — how the vault wins', () => {
  it('skips a file the caller declares excluded, and keeps its neighbours', async () => {
    write('docs/vaulted.md');
    write('docs/ordinary.md');

    const scan = await scanRepositoryDocuments(root, {}, (absolute) =>
      absolute.endsWith('vaulted.md'),
    );

    expect(paths(scan.files)).toEqual(['docs/ordinary.md']);
  });
});

describe('isInside', () => {
  it('answers for a real nested path and for a sibling', () => {
    expect(isInside(root, join(root, 'docs', 'a.md'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(join(root, 'docs'), join(root, 'src', 'a.md'))).toBe(false);
  });

  it('is not fooled by a shared prefix that is not a parent directory', () => {
    // `…/mc-docs` and `…/mc-docs-2` share a string prefix and share no files; a `startsWith`
    // implementation would call the second one "inside" the first.
    expect(isInside(join(root, 'repo'), join(root, 'repo-two', 'README.md'))).toBe(false);
  });

  it('is case-insensitive exactly where the platform is', () => {
    // On win32 `D:\Repos\MCS` and `d:\repos\mcs` are one directory; on posix they are two.
    const mixed = process.platform === 'win32' ? root.toUpperCase() : root;
    expect(isInside(mixed, join(root, 'docs', 'a.md'))).toBe(true);
  });
});
