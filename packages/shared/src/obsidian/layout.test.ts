import { describe, expect, it } from 'vitest';
import {
  adrNotePath,
  adrNumberLabel,
  conflictCopyPath,
  disambiguatePath,
  isConflictCopyPath,
  MANAGED_FOLDERS,
  MAX_NOTE_BASENAME_LENGTH,
  sanitizeNoteName,
  sessionNotePath,
  VAULT_FOLDERS,
} from './layout.js';

describe('vault layout', () => {
  it('names the six PRD §7.1 folders and manages two of them in V1', () => {
    expect(Object.values(VAULT_FOLDERS)).toEqual([
      'Projects',
      'Sessions',
      'ADRs',
      'Agents',
      'Features',
      'Daily',
    ]);
    expect(MANAGED_FOLDERS).toEqual(['Sessions', 'ADRs']);
  });
});

describe('file names', () => {
  it('strips characters that are illegal on Windows or syntactic in Obsidian', () => {
    expect(sanitizeNoteName('a/b\\c:d*e?f"g<h>i|j#k[l]m^n')).toBe('a b c d e f g h i j k l m n');
  });

  it('never produces a trailing dot or space — Windows would silently drop them', () => {
    expect(sanitizeNoteName('Decision...')).toBe('Decision');
    expect(sanitizeNoteName('Decision   ')).toBe('Decision');
  });

  it('never produces an empty name', () => {
    expect(sanitizeNoteName('///')).toBe('Untitled');
    expect(sanitizeNoteName('   ')).toBe('Untitled');
  });

  it('escapes the DOS device names Windows refuses regardless of extension', () => {
    expect(sanitizeNoteName('CON')).toBe('CON note');
    expect(sanitizeNoteName('nul')).toBe('nul note');
  });

  it('bounds the base name so the full path clears the Windows limit', () => {
    const name = sanitizeNoteName('x'.repeat(400));
    expect(name.length).toBeLessThanOrEqual(MAX_NOTE_BASENAME_LENGTH);
  });

  it('builds the ADR path from the zero-padded number and the title', () => {
    expect(adrNumberLabel(7)).toBe('ADR-0007');
    expect(adrNotePath(7, 'Use pg-boss for the job queue')).toBe(
      'ADRs/ADR-0007 Use pg-boss for the job queue.md',
    );
  });

  it('dates the session note in UTC so the name does not depend on the reader', () => {
    const path = sessionNotePath(
      new Date('2026-08-13T23:30:00.000Z'),
      'Fix the login redirect',
      '0199a3f1-6c2e-7a10-9f01-3d4e5f607182',
    );
    expect(path).toBe('Sessions/2026-08-13 Fix the login redirect.md');
  });

  it('falls back to a short id when the session has no title', () => {
    expect(
      sessionNotePath(new Date('2026-08-13T09:00:00.000Z'), null, '0199a3f1-6c2e-7a10-9f01-x'),
    ).toBe('Sessions/2026-08-13 0199a3f1.md');
  });

  it('disambiguates deterministically, before the extension', () => {
    expect(disambiguatePath('ADRs/ADR-0007 Title.md', '0199a3f1-6c2e')).toBe(
      'ADRs/ADR-0007 Title (0199a3f1).md',
    );
  });
});

describe('conflict copies', () => {
  it('keeps the .md extension so Obsidian indexes the preserved version', () => {
    const path = conflictCopyPath('ADRs/ADR-0007 Title.md', new Date('2026-08-13T10:15:00.000Z'));
    expect(path).toBe('ADRs/ADR-0007 Title.conflict-20260813-101500.md');
  });

  it('recognises its own copies so a scan never mistakes one for the note it came from', () => {
    expect(isConflictCopyPath('ADRs/ADR-0007 Title.conflict-20260813-101500.md')).toBe(true);
    expect(isConflictCopyPath('ADRs/ADR-0007 Title.md')).toBe(false);
    expect(isConflictCopyPath('ADRs/My conflict notes.md')).toBe(false);
  });
});
