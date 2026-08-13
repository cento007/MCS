import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileExclusive, inspectVault, vaultAbsolutePath, writeFileAtomic } from './fs.js';

/**
 * Real directories under a real temp path — the same approach the repositories tests take with
 * real git working trees. A filesystem mock cannot demonstrate the property this module exists
 * for (a crash between the write and the rename), because in a mock the crash is imaginary.
 */

const roots: string[] = [];

function tempVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'mc-vault-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates the file and its parent directory', async () => {
    const root = tempVault();
    const target = join(root, 'ADRs', 'note.md');

    await writeFileAtomic(target, '# Hello\n');

    expect(await readFile(target, 'utf8')).toBe('# Hello\n');
  });

  it('leaves the previous version intact when interrupted before the rename', async () => {
    const root = tempVault();
    const target = join(root, 'note.md');
    await writeFile(target, 'ORIGINAL', 'utf8');

    await expect(
      writeFileAtomic(target, 'REPLACEMENT'.repeat(1000), {
        onBeforeRename: () => {
          throw new Error('process died');
        },
      }),
    ).rejects.toThrow('process died');

    // The whole point: not a byte of the new content reached the note, and the old content is
    // exactly as it was — no truncation, no partial write.
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL');
  });

  it('leaves no temp file behind when interrupted', async () => {
    const root = tempVault();

    await expect(
      writeFileAtomic(join(root, 'note.md'), 'x', {
        onBeforeRename: () => {
          throw new Error('process died');
        },
      }),
    ).rejects.toThrow();

    expect(await readdir(root)).toEqual([]);
  });

  it('creates nothing at the target when interrupted on a first write', async () => {
    const root = tempVault();
    const target = join(root, 'fresh.md');

    await expect(
      writeFileAtomic(target, 'x', {
        onBeforeRename: () => {
          throw new Error('process died');
        },
      }),
    ).rejects.toThrow();

    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces an existing file in one step', async () => {
    const root = tempVault();
    const target = join(root, 'note.md');
    await writeFile(target, 'v1', 'utf8');

    await writeFileAtomic(target, 'v2');

    expect(await readFile(target, 'utf8')).toBe('v2');
    expect(await readdir(root)).toEqual(['note.md']);
  });
});

describe('copyFileExclusive', () => {
  it('refuses to overwrite an existing conflict copy', async () => {
    const root = tempVault();
    await writeFile(join(root, 'a.md'), 'first', 'utf8');
    await writeFile(join(root, 'b.md'), 'second', 'utf8');

    await copyFileExclusive(join(root, 'a.md'), join(root, 'copy.md'));
    await expect(
      copyFileExclusive(join(root, 'b.md'), join(root, 'copy.md')),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    // The version preserved first is still the version preserved.
    expect(await readFile(join(root, 'copy.md'), 'utf8')).toBe('first');
  });
});

describe('vaultAbsolutePath', () => {
  it('resolves a vault-relative path with forward slashes', () => {
    const root = tempVault();
    expect(vaultAbsolutePath(root, 'ADRs/note.md')).toBe(join(root, 'ADRs', 'note.md'));
  });

  it('refuses to escape the vault', () => {
    const root = tempVault();
    expect(() => vaultAbsolutePath(root, '../outside.md')).toThrow(/outside the vault/);
    expect(() => vaultAbsolutePath(root, 'ADRs/../../outside.md')).toThrow(/outside the vault/);
  });
});

describe('inspectVault', () => {
  it('accepts a readable directory', async () => {
    expect(await inspectVault(tempVault())).toEqual({ ok: true });
  });

  it('reports a vanished vault as data, not as an exception', async () => {
    const result = await inspectVault(join(tempVault(), 'gone'));
    expect(result).toMatchObject({ ok: false, kind: 'missing' });
  });

  it('reports a file where a directory should be', async () => {
    const root = tempVault();
    const file = join(root, 'vault.md');
    await writeFile(file, 'x', 'utf8');

    expect(await inspectVault(file)).toMatchObject({ ok: false, kind: 'not_a_directory' });
  });

  it('reports a relative path rather than resolving it against the process cwd', async () => {
    expect(await inspectVault('vault')).toMatchObject({ ok: false, kind: 'not_absolute' });
  });

  it('reports a directory that cannot be written to', async () => {
    const root = tempVault();
    const locked = join(root, 'locked');
    await mkdir(locked);

    // POSIX only: Windows ignores mode bits on directories, and `access(W_OK)` there does not
    // consult ACLs — which is exactly why a failed write also degrades to a per-file ledger
    // `error` rather than relying on this check alone.
    if (process.platform === 'win32') {
      expect(await inspectVault(locked, { requireWritable: true })).toEqual({ ok: true });
      return;
    }

    await chmod(locked, 0o500);
    try {
      expect(await inspectVault(locked, { requireWritable: true })).toMatchObject({
        ok: false,
        kind: 'not_writable',
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
