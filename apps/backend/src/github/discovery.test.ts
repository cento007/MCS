import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitRemoteRead, PathKind } from '../repositories/git.js';
import { type ScanFilesystem, scanDiscoveryRoots } from './discovery.js';

/**
 * The discovery walk, over an injected filesystem — no fixtures on disk, no `git` spawns, and
 * therefore fast enough to cover the bounds (depth, breadth, count, deadline) that a real-disk
 * test could only assert by building a pathological tree.
 *
 * The classification cases are the product: an operator running discovery needs to know *why*
 * a directory they expected did not become a Repository.
 */

const ROOT = resolve('/repos');

interface FakeTree {
  readonly directories: Record<string, string[]>;
  readonly workingTrees: Record<string, string | null>;
  readonly unreadable?: readonly string[];
}

function fakeFs(tree: FakeTree): ScanFilesystem {
  const remotes = tree.workingTrees;

  return {
    inspect(path: string): Promise<PathKind> {
      if (path in tree.directories || path in remotes) return Promise.resolve('directory');
      return Promise.resolve('path_missing');
    },
    listDirectories(path: string): Promise<string[]> {
      if (tree.unreadable?.includes(path) === true) {
        return Promise.reject(new Error(`EACCES: permission denied, scandir '${path}'`));
      }
      return Promise.resolve(tree.directories[path] ?? []);
    },
    isWorkingTree(path: string): Promise<boolean> {
      return Promise.resolve(path in remotes);
    },
    readRemote(path: string): Promise<GitRemoteRead> {
      const url = remotes[path];
      if (url === undefined || url === null) {
        return Promise.resolve({ url: null, unavailableReason: 'no_remote', detail: null });
      }
      if (url === '!not-a-repo') {
        return Promise.resolve({
          url: null,
          unavailableReason: 'not_a_git_repository',
          detail: "fatal: not a git repository (or any of the parent directories): '.git'",
        });
      }
      if (url === '!git-missing') {
        return Promise.resolve({ url: null, unavailableReason: 'git_unavailable', detail: null });
      }
      return Promise.resolve({ url, unavailableReason: null, detail: null });
    },
  };
}

describe('scanDiscoveryRoots — classification', () => {
  it('classifies each skip reason and finds the GitHub repositories', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['mcs', 'gitlab-thing', 'no-remote', 'broken', 'plain-dir'] },
      workingTrees: {
        [join(ROOT, 'mcs')]: 'git@github.com:cento007/MCS.git',
        [join(ROOT, 'gitlab-thing')]: 'https://gitlab.com/group/project.git',
        [join(ROOT, 'no-remote')]: null,
        [join(ROOT, 'broken')]: '!not-a-repo',
      },
    });

    const result = await scanDiscoveryRoots([ROOT], { fs });

    expect(result.roots).toEqual([{ path: ROOT, status: 'scanned', found: 4, detail: null }]);

    const byPath = new Map(result.candidates.map((candidate) => [candidate.localPath, candidate]));

    expect(byPath.get(join(ROOT, 'mcs'))).toEqual({
      localPath: join(ROOT, 'mcs'),
      remote: {
        host: 'github.com',
        owner: 'cento007',
        repo: 'MCS',
        canonicalUrl: 'https://github.com/cento007/MCS',
      },
      problem: null,
      detail: null,
    });

    expect(byPath.get(join(ROOT, 'gitlab-thing'))).toMatchObject({
      problem: 'remote_not_github',
      detail: 'origin points at gitlab.com, which is not github.com',
    });
    expect(byPath.get(join(ROOT, 'no-remote'))).toMatchObject({ problem: 'no_remote' });
    expect(byPath.get(join(ROOT, 'broken'))).toMatchObject({
      problem: 'not_a_git_repository',
      detail: expect.stringContaining('not a git repository'),
    });

    // A plain directory with no `.git` is not a candidate at all — reporting every directory
    // under a root as "skipped: not a repo" would bury the four answers above.
    expect(byPath.has(join(ROOT, 'plain-dir'))).toBe(false);
  });

  it('reports a remote it could not read separately from one that is absent', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['weird'] },
      workingTrees: { [join(ROOT, 'weird')]: '!git-missing' },
    });

    const result = await scanDiscoveryRoots([ROOT], { fs });
    expect(result.candidates[0]).toMatchObject({ problem: 'remote_unreadable' });
  });

  it('never puts a remote URL in the skip detail (it can carry a credential)', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['leaky'] },
      workingTrees: { [join(ROOT, 'leaky')]: 'https://user:ghp_SECRET@gitlab.com/g/p.git' },
    });

    const result = await scanDiscoveryRoots([ROOT], { fs });

    expect(JSON.stringify(result)).not.toContain('ghp_SECRET');
    expect(result.candidates[0]?.detail).toBe(
      'origin points at gitlab.com, which is not github.com',
    );
  });
});

describe('scanDiscoveryRoots — roots', () => {
  it('takes a root that is itself a working tree, and does not descend into it', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['nested'] },
      workingTrees: {
        [ROOT]: 'https://github.com/cento007/MCS.git',
        [join(ROOT, 'nested')]: 'https://github.com/cento007/nested.git',
      },
    });

    const result = await scanDiscoveryRoots([ROOT], { fs });

    expect(result.roots[0]).toMatchObject({ status: 'scanned_as_repository', found: 1 });
    expect(result.candidates.map((candidate) => candidate.localPath)).toEqual([ROOT]);
  });

  it('reports a missing root rather than failing the whole scan', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['mcs'] },
      workingTrees: { [join(ROOT, 'mcs')]: 'https://github.com/cento007/MCS.git' },
    });

    const result = await scanDiscoveryRoots([resolve('/nope'), ROOT], { fs });

    expect(result.roots[0]).toMatchObject({ path: resolve('/nope'), status: 'path_missing' });
    expect(result.roots[1]).toMatchObject({ status: 'scanned', found: 1 });
    expect(result.candidates).toHaveLength(1);
  });

  it('rejects a relative root instead of resolving it against the server’s cwd', async () => {
    // F8.1: absolute native paths. Resolving `./repos` would silently scan whatever directory a
    // systemd unit happens to start in.
    const result = await scanDiscoveryRoots(['repos', './repos'], {
      fs: fakeFs({ directories: {}, workingTrees: {} }),
    });

    expect(result.roots.map((root) => root.status)).toEqual(['not_absolute', 'not_absolute']);
    expect(result.candidates).toHaveLength(0);
  });

  it('ignores blank roots', async () => {
    const result = await scanDiscoveryRoots(['', '   '], {
      fs: fakeFs({ directories: {}, workingTrees: {} }),
    });
    expect(result.roots).toHaveLength(0);
  });

  it('reports an unreadable directory as a fact about that root', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: [] },
      workingTrees: {},
      unreadable: [ROOT],
    });

    const result = await scanDiscoveryRoots([ROOT], { fs });

    expect(result.roots[0]).toMatchObject({
      status: 'unreadable',
      detail: expect.stringContaining('EACCES'),
    });
  });

  it('de-duplicates a working tree reachable through two roots', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['mcs'] },
      workingTrees: { [join(ROOT, 'mcs')]: 'https://github.com/cento007/MCS.git' },
    });

    const result = await scanDiscoveryRoots([ROOT, ROOT], { fs });

    expect(result.candidates).toHaveLength(1);
  });
});

describe('scanDiscoveryRoots — bounds', () => {
  it('descends only to maxDepth', async () => {
    const fs = fakeFs({
      directories: {
        [ROOT]: ['a'],
        [join(ROOT, 'a')]: ['b'],
        [join(ROOT, 'a', 'b')]: ['c'],
        [join(ROOT, 'a', 'b', 'c')]: ['deep'],
      },
      workingTrees: {
        [join(ROOT, 'a', 'b', 'c', 'deep')]: 'https://github.com/o/deep.git',
      },
    });

    expect((await scanDiscoveryRoots([ROOT], { fs, maxDepth: 3 })).candidates).toHaveLength(0);
    expect((await scanDiscoveryRoots([ROOT], { fs, maxDepth: 4 })).candidates).toHaveLength(1);
  });

  it('never descends into node_modules or a dot-directory', async () => {
    const fs = fakeFs({
      directories: { [ROOT]: ['node_modules', '.git', 'dist', 'src'] },
      workingTrees: {
        [join(ROOT, 'node_modules', 'pkg')]: 'https://github.com/o/pkg.git',
        [join(ROOT, '.git', 'modules')]: 'https://github.com/o/mod.git',
        [join(ROOT, 'dist', 'thing')]: 'https://github.com/o/thing.git',
      },
    });

    expect((await scanDiscoveryRoots([ROOT], { fs })).candidates).toHaveLength(0);
  });

  it('stops at maxCandidates and says so', async () => {
    const names = Array.from({ length: 10 }, (_unused, index) => `r${String(index)}`);
    const fs = fakeFs({
      directories: { [ROOT]: names },
      workingTrees: Object.fromEntries(
        names.map((name) => [join(ROOT, name), `https://github.com/o/${name}.git`]),
      ),
    });

    const result = await scanDiscoveryRoots([ROOT], { fs, maxCandidates: 3 });

    expect(result.candidates.length).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });

  it('stops at the wall-clock deadline and says so', async () => {
    const names = Array.from({ length: 50 }, (_unused, index) => `r${String(index)}`);
    const fs = fakeFs({
      directories: { [ROOT]: names },
      workingTrees: Object.fromEntries(
        names.map((name) => [join(ROOT, name), `https://github.com/o/${name}.git`]),
      ),
    });

    // A clock that advances 10 ms per read, against a 25 ms budget.
    let ticks = 0;
    const now = (): number => {
      ticks += 1;
      return ticks * 10;
    };

    const result = await scanDiscoveryRoots([ROOT], { fs, now, deadlineMs: 25 });

    expect(result.truncated).toBe(true);
    expect(result.candidates.length).toBeLessThan(50);
  });

  it('caps how many entries it reads from one directory', async () => {
    const names = Array.from({ length: 100 }, (_unused, index) => `r${String(index)}`);
    const fs = fakeFs({
      directories: { [ROOT]: names },
      workingTrees: Object.fromEntries(
        names.map((name) => [join(ROOT, name), `https://github.com/o/${name}.git`]),
      ),
    });

    const result = await scanDiscoveryRoots([ROOT], { fs, maxEntriesPerDirectory: 5 });

    expect(result.candidates).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});
