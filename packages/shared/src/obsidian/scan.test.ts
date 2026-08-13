import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanVault } from './scan.js';

const roots: string[] = [];

function tempVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'mc-scan-'));
  roots.push(root);
  return root;
}

async function note(root: string, relative: string, body: string): Promise<void> {
  const absolute = join(root, ...relative.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, body, 'utf8');
}

function managed(id: string, type = 'adr'): string {
  return `---\nmcId: "${id}"\nmcType: "${type}"\n---\n\n# Title\n\n## Context\n\nBody\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scanVault', () => {
  it('reads the managed folders and indexes notes by their front-matter id', async () => {
    const root = tempVault();
    await note(root, 'ADRs/ADR-0001 One.md', managed('id-1'));
    await note(root, 'Sessions/2026-08-13 Two.md', managed('id-2', 'session'));

    const scan = await scanVault(root);

    expect(scan.truncated).toBe(false);
    expect(scan.files.map((file) => file.vaultPath).sort()).toEqual([
      'ADRs/ADR-0001 One.md',
      'Sessions/2026-08-13 Two.md',
    ]);
    expect(scan.byEntityId.get('id-1')?.vaultPath).toBe('ADRs/ADR-0001 One.md');
    expect(scan.byEntityId.get('id-2')?.identity?.entityType).toBe('session');
  });

  it('ignores folders it does not manage, dotfiles, non-markdown and conflict copies', async () => {
    const root = tempVault();
    await note(root, 'ADRs/kept.md', managed('id-1'));
    await note(root, 'Daily/2026-08-13.md', '# Journal\n');
    await note(root, 'ADRs/.obsidian/workspace.md', '# internal\n');
    await note(root, 'ADRs/attachment.png', 'binary-ish');
    await note(root, 'ADRs/kept.conflict-20260813-101500.md', managed('id-1'));

    const scan = await scanVault(root);

    expect(scan.files.map((file) => file.vaultPath)).toEqual(['ADRs/kept.md']);
    expect(scan.duplicateIdPaths).toEqual([]);
  });

  it('counts notes carrying no Mission Control id and never claims them', async () => {
    const root = tempVault();
    await note(root, 'ADRs/hand written.md', '# My own note\n\nNothing to do with sync.\n');
    await note(root, 'ADRs/managed.md', managed('id-1'));

    const scan = await scanVault(root);

    expect(scan.unmanagedCount).toBe(1);
    expect(scan.byEntityId.size).toBe(1);
  });

  it('reports a second note claiming the same id instead of silently picking one', async () => {
    const root = tempVault();
    await note(root, 'ADRs/a.md', managed('id-1'));
    await note(root, 'ADRs/b copy.md', managed('id-1'));

    const scan = await scanVault(root);

    expect(scan.byEntityId.get('id-1')?.vaultPath).toBe('ADRs/a.md');
    expect(scan.duplicateIdPaths).toEqual(['ADRs/b copy.md']);
  });

  it('follows a note the operator moved into a sub-folder', async () => {
    const root = tempVault();
    await note(root, 'ADRs/Archive/2025/old.md', managed('id-1'));

    const scan = await scanVault(root);

    expect(scan.byEntityId.get('id-1')?.vaultPath).toBe('ADRs/Archive/2025/old.md');
  });

  it('treats an absent managed folder as an empty one, not as a failure', async () => {
    const scan = await scanVault(tempVault());
    expect(scan.files).toEqual([]);
    expect(scan.truncated).toBe(false);
  });

  describe('bounds', () => {
    it('stops and says so when the vault holds more notes than the cap', async () => {
      const root = tempVault();
      for (let index = 0; index < 40; index += 1) {
        await note(root, `ADRs/note-${index}.md`, managed(`id-${index}`));
      }

      const scan = await scanVault(root, { maxFiles: 10 });

      expect(scan.truncated).toBe(true);
      expect(scan.truncatedReason).toMatch(/more than 10 notes/);
      expect(scan.files.length).toBe(10);
    });

    it('stops on a directory tree deeper than the depth bound', async () => {
      const root = tempVault();
      await note(root, 'ADRs/a/b/c/d/e/f/g/deep.md', managed('id-1'));

      const scan = await scanVault(root, { maxDepth: 3 });

      expect(scan.truncated).toBe(true);
      expect(scan.truncatedReason).toMatch(/nesting/);
    });

    it('stops on a directory with more entries than the breadth bound', async () => {
      const root = tempVault();
      for (let index = 0; index < 12; index += 1) {
        await note(root, `ADRs/note-${index}.md`, managed(`id-${index}`));
      }

      const scan = await scanVault(root, { maxEntriesPerDirectory: 5 });

      expect(scan.truncated).toBe(true);
      expect(scan.truncatedReason).toMatch(/more than 5 entries/);
    });

    it('stops on the wall-clock deadline', async () => {
      const root = tempVault();
      for (let index = 0; index < 5; index += 1) {
        await note(root, `ADRs/note-${index}.md`, managed(`id-${index}`));
      }

      let clock = 0;
      const scan = await scanVault(root, {
        deadlineMs: 10,
        // Each check advances the clock; the deadline is crossed part-way through the folder.
        now: () => {
          clock += 6;
          return clock;
        },
      });

      expect(scan.truncated).toBe(true);
      expect(scan.truncatedReason).toMatch(/deadline/);
    });

    it('stops when reading the vault would exceed the byte budget', async () => {
      const root = tempVault();
      for (let index = 0; index < 5; index += 1) {
        await note(root, `ADRs/note-${index}.md`, `${managed(`id-${index}`)}${'x'.repeat(4_000)}`);
      }

      const scan = await scanVault(root, { maxTotalBytes: 5_000 });

      expect(scan.truncated).toBe(true);
      expect(scan.truncatedReason).toMatch(/exceeded/);
    });

    it('records an oversized note as a problem instead of reading it', async () => {
      const root = tempVault();
      await note(root, 'ADRs/huge.md', 'x'.repeat(5_000));

      const scan = await scanVault(root, { maxFileBytes: 1_000 });

      expect(scan.truncated).toBe(false);
      expect(scan.files[0]?.problem).toMatch(/larger than 1000 bytes/);
      expect(scan.files[0]?.text).toBeNull();
      expect(scan.files[0]?.hash).toBeNull();
    });
  });
});
