import { describe, expect, it } from 'vitest';
import type { ObsidianConflictPolicy, ObsidianSyncMode } from '../settings/types.js';
import { noteHash, type ParsedNote, parseNote } from './note.js';
import {
  type AdrImport,
  CLOCK_SKEW_MS,
  type DesiredNote,
  type LedgerEntry,
  planSync,
} from './plan.js';
import type { ScannedFile, VaultScan } from './scan.js';

/**
 * The conflict matrix, exercised as a pure function — no database, no filesystem.
 *
 * The case this file exists for is the last block: **both sides changed**. Everything else is
 * bookkeeping; that one is where an operator's writing is at stake.
 */

const ENTITY_ID = '0199a3f1-6c2e-7a10-9f01-3d4e5f607182';
const PATH = 'ADRs/ADR-0007 Queue.md';

function body(context: string, extra = ''): string {
  return [
    '---',
    `mcId: "${ENTITY_ID}"`,
    'mcType: "adr"',
    '---',
    '',
    '# Queue',
    '',
    '## Context',
    '',
    context,
    ...(extra === '' ? [] : ['', '## Notes', '', extra]),
    '',
  ].join('\n');
}

function desired(context: string, options: Partial<DesiredNote> = {}): DesiredNote {
  const canonical = body(context);
  return {
    entityType: 'adr',
    entityId: ENTITY_ID,
    idealPath: PATH,
    canonicalHash: noteHash(canonical),
    updatedAt: new Date('2026-08-13T10:00:00.000Z'),
    canonicalSections: ['Context'],
    render: (existing: ParsedNote | null) => {
      const notes = existing?.sections.find((section) => section.heading === 'Notes');
      return body(context, notes?.lines.join('\n') ?? '');
    },
    parseImport: (note: ParsedNote): AdrImport | null => ({
      title: note.title,
      status: null,
      context:
        note.sections.find((section) => section.heading === 'Context')?.lines.join('\n') ?? null,
      decision: null,
      alternatives: null,
      consequences: null,
      warning: null,
    }),
    ...options,
  };
}

function file(text: string, mtime = new Date('2026-08-13T09:00:00.000Z')): ScannedFile {
  const note = parseNote(text);
  return {
    vaultPath: PATH,
    mtime,
    size: text.length,
    text,
    note,
    identity: { entityId: ENTITY_ID, entityType: 'adr' },
    hash: noteHash(text),
    problem: null,
  };
}

function scanOf(files: readonly ScannedFile[]): VaultScan {
  return {
    files,
    byEntityId: new Map(
      files
        .filter((entry) => entry.identity !== null)
        .map((entry) => [entry.identity?.entityId as string, entry]),
    ),
    byPath: new Map(files.map((entry) => [entry.vaultPath, entry])),
    unmanagedCount: 0,
    duplicateIdPaths: [],
    truncated: false,
    truncatedReason: null,
  };
}

function ledger(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'ledger-1',
    vaultPath: PATH,
    entityType: 'adr',
    entityId: ENTITY_ID,
    mcHash: null,
    vaultHash: null,
    vaultMtime: null,
    status: 'in_sync',
    lastSyncedAt: null,
    lastError: null,
    ...overrides,
  };
}

function plan(input: {
  desired: DesiredNote;
  files?: readonly ScannedFile[];
  ledger?: readonly LedgerEntry[];
  syncMode?: ObsidianSyncMode;
  conflictPolicy?: ObsidianConflictPolicy;
}) {
  const result = planSync({
    desired: [input.desired],
    scan: scanOf(input.files ?? []),
    ledger: input.ledger ?? [],
    syncMode: input.syncMode ?? 'two_way',
    conflictPolicy: input.conflictPolicy ?? 'newer_wins',
  });

  const item = result.items[0];
  if (item === undefined) throw new Error('the planner produced no item');
  return item;
}

describe('nothing in the vault yet', () => {
  it('creates the note', () => {
    const item = plan({ desired: desired('First') });

    expect(item.action).toBe('create');
    expect(item.vaultPath).toBe(PATH);
    expect(item.content).toContain('First');
    expect(item.backupRequired).toBe(false);
  });

  it('re-creates a note that was deleted from the vault, and says so', () => {
    const item = plan({
      desired: desired('First'),
      ledger: [ledger({ mcHash: noteHash(body('First')), vaultHash: 'stale' })],
    });

    expect(item.action).toBe('create');
    expect(item.reason).toMatch(/no longer in the vault/);
  });

  it('lands on a free name when the ideal one is taken by another note', () => {
    const other: ScannedFile = { ...file(body('other')), vaultPath: PATH, identity: null };
    const item = plan({ desired: desired('First'), files: [other] });

    expect(item.action).toBe('create');
    expect(item.vaultPath).toBe('ADRs/ADR-0007 Queue (0199a3f1).md');
  });
});

describe('one side changed', () => {
  it('does nothing when neither side moved', () => {
    const text = body('Same');
    const item = plan({
      desired: desired('Same'),
      files: [file(text)],
      ledger: [ledger({ mcHash: noteHash(text), vaultHash: noteHash(text) })],
    });

    expect(item.action).toBe('in_sync');
    expect(item.content).toBeNull();
  });

  it('pushes when only Mission Control changed', () => {
    const old = body('Old');
    const item = plan({
      desired: desired('New'),
      files: [file(old)],
      ledger: [ledger({ mcHash: noteHash(old), vaultHash: noteHash(old) })],
    });

    expect(item.action).toBe('update');
    expect(item.content).toContain('New');
    // Nothing is at risk: the vault copy is byte-for-byte what we last wrote.
    expect(item.backupRequired).toBe(false);
  });

  it('imports when only the vault changed', () => {
    const previous = body('Old');
    const edited = body('Edited by hand');
    const item = plan({
      desired: desired('Old'),
      files: [file(edited)],
      ledger: [ledger({ mcHash: noteHash(previous), vaultHash: noteHash(previous) })],
    });

    expect(item.action).toBe('import');
    expect(item.import?.context).toBe('Edited by hand');
    expect(item.content).toBeNull();
  });

  it('carries an operator section through a clean push', () => {
    // The extra section was already there at the last sync, so only Mission Control changed.
    // This is the ordinary case, and the operator's writing must come out the other side.
    const withNotes = body('Old', 'Ask Marc about retries.');
    const item = plan({
      desired: desired('New'),
      files: [file(withNotes)],
      ledger: [ledger({ mcHash: noteHash(body('Old')), vaultHash: noteHash(withNotes) })],
    });

    expect(item.action).toBe('update');
    expect(item.content).toContain('New');
    expect(item.content).toContain('Ask Marc about retries.');
  });

  it('carries an operator section through a conflict resolved our way', () => {
    // The section is *new* since the last sync, so both sides changed. Even when Mission
    // Control wins, the section is not collateral damage.
    const withNotes = body('Old', 'Ask Marc about retries.');
    const item = plan({
      desired: desired('New'),
      files: [file(withNotes)],
      ledger: [ledger({ mcHash: noteHash(body('Old')), vaultHash: noteHash(body('Old')) })],
      conflictPolicy: 'mission_control_wins',
    });

    expect(item.action).toBe('conflict');
    expect(item.backupRequired).toBe(true);
    expect(item.content).toContain('Ask Marc about retries.');
  });

  it('defers rather than imports when the note type is export-only', () => {
    const previous = body('Old');
    const edited = body('Edited by hand');
    const exportOnly = desired('Old');
    const { parseImport: _dropped, ...withoutImport } = exportOnly;

    const item = plan({
      desired: withoutImport as DesiredNote,
      files: [file(edited)],
      ledger: [ledger({ mcHash: noteHash(previous), vaultHash: noteHash(previous) })],
    });

    expect(item.action).toBe('pending_pull');
    expect(item.reason).toMatch(/export-only/);
    expect(item.content).toBeNull();
  });

  it('defers rather than imports in one-way mode', () => {
    const previous = body('Old');
    const item = plan({
      desired: desired('Old'),
      files: [file(body('Edited by hand'))],
      ledger: [ledger({ mcHash: noteHash(previous), vaultHash: noteHash(previous) })],
      syncMode: 'one_way',
    });

    expect(item.action).toBe('pending_pull');
    expect(item.reason).toMatch(/one-way/);
  });

  it('adopts an existing note that already matches, without calling it a conflict', () => {
    const text = body('Same');
    const item = plan({ desired: desired('Same'), files: [file(text)] });

    expect(item.action).toBe('in_sync');
    expect(item.reason).toMatch(/already matches/);
  });

  it('follows a note the operator renamed, by its front-matter id', () => {
    const text = body('Same');
    const moved: ScannedFile = { ...file(text), vaultPath: 'ADRs/Renamed by hand.md' };

    const item = plan({
      desired: desired('Same'),
      files: [moved],
      ledger: [ledger({ mcHash: noteHash(text), vaultHash: noteHash(text) })],
    });

    expect(item.action).toBe('in_sync');
    expect(item.vaultPath).toBe('ADRs/Renamed by hand.md');
    expect(item.previousPath).toBe(PATH);
  });

  it('never overwrites a note it could not read', () => {
    const unreadable: ScannedFile = {
      ...file(body('x')),
      text: null,
      note: null,
      hash: null,
      problem: 'EBUSY',
    };

    const item = plan({ desired: desired('New'), files: [unreadable] });

    expect(item.action).toBe('error');
    expect(item.content).toBeNull();
    expect(item.error).toBe('EBUSY');
  });
});

describe('both sides changed — the conflict', () => {
  const previous = body('Original');
  const vaultEdit = body('Edited in Obsidian');

  function conflict(
    conflictPolicy: ObsidianConflictPolicy,
    vaultMtime = new Date('2026-08-13T09:00:00.000Z'),
    syncMode: ObsidianSyncMode = 'two_way',
  ) {
    return plan({
      desired: desired('Edited in Mission Control'),
      files: [file(vaultEdit, vaultMtime)],
      ledger: [ledger({ mcHash: noteHash(previous), vaultHash: noteHash(previous) })],
      conflictPolicy,
      syncMode,
    });
  }

  it('is classified as a conflict under every policy', () => {
    for (const policy of [
      'newer_wins',
      'obsidian_wins',
      'mission_control_wins',
      'manual',
    ] as const) {
      expect(conflict(policy).action).toBe('conflict');
    }
  });

  it('manual writes nothing on either side', () => {
    const item = conflict('manual');

    expect(item.resolution).toBe('manual_pending');
    expect(item.content).toBeNull();
    expect(item.import).toBeNull();
    expect(item.backupRequired).toBe(false);
  });

  it('mission_control_wins requires the vault version to be preserved first', () => {
    const item = conflict('mission_control_wins');

    expect(item.resolution).toBe('mission_control_wins');
    expect(item.content).toContain('Edited in Mission Control');
    expect(item.backupRequired).toBe(true);
  });

  it('obsidian_wins imports and writes nothing to the vault', () => {
    const item = conflict('obsidian_wins');

    expect(item.resolution).toBe('obsidian_wins');
    expect(item.content).toBeNull();
    expect(item.import?.context).toBe('Edited in Obsidian');
  });

  it('newer_wins compares the file mtime against the row updated_at', () => {
    // Row updated at 10:00; the file is older.
    const missionControlNewer = conflict('newer_wins', new Date('2026-08-13T09:00:00.000Z'));
    expect(missionControlNewer.content).not.toBeNull();
    expect(missionControlNewer.backupRequired).toBe(true);

    const vaultNewer = conflict('newer_wins', new Date('2026-08-13T11:00:00.000Z'));
    expect(vaultNewer.content).toBeNull();
    expect(vaultNewer.import?.context).toBe('Edited in Obsidian');
  });

  it('newer_wins resolves a difference inside the clock skew toward the recoverable side', () => {
    // The filesystem clock and the database clock are different clocks and disagree by
    // milliseconds on real machines. Inside the margin, the winner is the one whose loser ends
    // up as a conflict copy in the operator's own vault.
    const within = conflict(
      'newer_wins',
      new Date(new Date('2026-08-13T10:00:00.000Z').getTime() + CLOCK_SKEW_MS - 1),
    );

    expect(within.content).not.toBeNull();
    expect(within.backupRequired).toBe(true);
    expect(within.reason).toMatch(/clock skew/);
  });

  it('leaves the vault alone when the vault wins but the type cannot be imported', () => {
    const item = conflict('obsidian_wins', new Date('2026-08-13T11:00:00.000Z'), 'one_way');

    expect(item.content).toBeNull();
    expect(item.import).toBeNull();
    expect(item.reason).toMatch(/cannot be imported/);
  });

  it('counts conflicts separately from pushes and pulls', () => {
    const result = planSync({
      desired: [desired('Edited in Mission Control')],
      scan: scanOf([file(vaultEdit)]),
      ledger: [ledger({ mcHash: noteHash(previous), vaultHash: noteHash(previous) })],
      syncMode: 'two_way',
      conflictPolicy: 'mission_control_wins',
    });

    expect(result.counts.conflict).toBe(1);
    expect(result.counts.update).toBe(0);
  });
});
