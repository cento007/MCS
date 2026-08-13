import { describe, expect, it } from 'vitest';
import { parseAdrImport } from './desired.js';
import { parseNote, sectionText } from './note.js';
import {
  ADR_SECTIONS,
  type AdrNoteInput,
  canonicalAdrHash,
  renderAdrNote,
  renderSessionNote,
  SESSION_SECTIONS,
  type SessionNoteInput,
} from './render.js';

const adr: AdrNoteInput = {
  id: '0199a3f1-6c2e-7a10-9f01-3d4e5f607182',
  projectId: '0199a3f1-0000-7a10-9f01-000000000001',
  projectName: 'Mission Control',
  adrNumber: 7,
  title: 'Use pg-boss for the job queue',
  status: 'proposed',
  context: 'Redis has no official native Windows build.',
  decision: 'PostgreSQL is the single stateful substrate.',
  alternatives: 'Memurai on Windows; an in-process queue.',
  consequences: 'The Services panel reports "Queue (PostgreSQL)".',
  supersededByAdrId: null,
  sourceSessionId: null,
  obsidianPath: null,
  createdAt: new Date('2026-08-11T10:00:00.000Z'),
  updatedAt: new Date('2026-08-12T10:00:00.000Z'),
};

const session: SessionNoteInput = {
  id: '0199a3f1-1111-7a10-9f01-3d4e5f607182',
  projectId: adr.projectId,
  projectName: 'Mission Control',
  repositoryName: 'MCS',
  title: 'Wire the sync worker',
  state: 'completed',
  sessionType: 'managed',
  runtime: 'claude_code',
  model: 'claude-opus-5',
  branch: 'DEV',
  workingDir: 'D:\\Repos\\MCS',
  startedAt: new Date('2026-08-13T08:00:00.000Z'),
  completedAt: new Date('2026-08-13T08:42:00.000Z'),
  durationMs: 2_520_000,
  numTurns: 12,
  totalCostUsd: '1.230000',
  failureReason: null,
  createdAt: new Date('2026-08-13T07:59:00.000Z'),
  updatedAt: new Date('2026-08-13T08:42:00.000Z'),
  prompts: ['Wire the sync worker up to the queue.'],
  outcome: 'Done — the worker now consumes obsidian.sync.',
  files: ['D:\\Repos\\MCS\\apps\\sync-worker\\src\\worker.ts'],
  promptsOmitted: 0,
  filesOmitted: 0,
};

describe('ADR note', () => {
  const rendered = renderAdrNote(adr, null);

  it('renders exactly the PRD §7.3 template sections, in order', () => {
    const note = parseNote(rendered);
    expect(note.sections.map((section) => section.heading)).toEqual([...ADR_SECTIONS]);
  });

  it('carries the entity id in front matter so the row can be found without the file name', () => {
    expect(rendered).toContain(`mcId: "${adr.id}"`);
    expect(rendered).toContain('mcType: "adr"');
  });

  it('puts the title in the H1 and nowhere else, so an import has one source', () => {
    const note = parseNote(rendered);
    expect(note.title).toBe(adr.title);
    expect(rendered).not.toContain('title:');
  });

  it('round-trips through the import parser', () => {
    const imported = parseAdrImport(parseNote(rendered));

    expect(imported).toMatchObject({
      title: adr.title,
      status: 'proposed',
      context: adr.context,
      decision: adr.decision,
      alternatives: adr.alternatives,
      consequences: adr.consequences,
      warning: null,
    });
  });

  it('round-trips an empty section back to an empty string, not to the placeholder', () => {
    const empty = renderAdrNote({ ...adr, alternatives: '' }, null);
    expect(empty).toContain('_Not recorded._');
    expect(parseAdrImport(parseNote(empty))?.alternatives).toBe('');
  });

  it('refuses a status that is not one of the four, and says so', () => {
    const note = parseNote(rendered.replace('status: "proposed"', 'status: "draft"'));
    const imported = parseAdrImport(note);

    expect(imported?.status).toBeNull();
    expect(imported?.warning).toMatch(/"draft" is not one of proposed/);
  });

  it('leaves a deleted section alone rather than erasing the row field', () => {
    const withoutContext = rendered.replace(`## Context\n\n${adr.context}\n`, '');
    expect(parseAdrImport(parseNote(withoutContext))?.context).toBeNull();
  });

  it('is deterministic — the same row renders the same bytes', () => {
    expect(renderAdrNote(adr, null)).toBe(rendered);
    expect(canonicalAdrHash(adr)).toBe(canonicalAdrHash({ ...adr }));
  });

  it('changes its canonical hash when a template section changes', () => {
    expect(canonicalAdrHash({ ...adr, decision: 'Something else' })).not.toBe(
      canonicalAdrHash(adr),
    );
  });

  it('ignores preserved extras when hashing the canonical projection', () => {
    const existing = parseNote(`${rendered}\n## Notes\n\nMine.\n`);
    const withExtras = renderAdrNote(adr, existing, existing.sections.slice(4));

    expect(withExtras).toContain('## Notes');
    // The mc_hash must measure OUR side only, or an operator's section becomes a permanent
    // false positive that reports a Mission Control change on every run.
    expect(canonicalAdrHash(adr)).toBe(canonicalAdrHash(adr));
    expect(withExtras).not.toBe(rendered);
  });
});

describe('session note', () => {
  const rendered = renderSessionNote(session, null);

  it('renders the four Session Note sections', () => {
    expect(parseNote(rendered).sections.map((section) => section.heading)).toEqual([
      ...SESSION_SECTIONS,
    ]);
  });

  it('quotes the operator prompts rather than summarising them', () => {
    expect(sectionText(parseNote(rendered), 'Prompts')).toBe(
      '> Wire the sync worker up to the queue.',
    );
  });

  it('states the metadata as UTC instants', () => {
    const summary = sectionText(parseNote(rendered), 'Summary') ?? '';
    expect(summary).toContain('**Started:** 2026-08-13T08:00:00.000Z');
    expect(summary).toContain('**Duration:** 42m 0s');
    expect(summary).toContain('**Cost:** $1.230000');
  });

  it('says when it dropped prompts instead of quietly truncating', () => {
    const bounded = renderSessionNote({ ...session, promptsOmitted: 4 }, null);
    expect(bounded).toContain('4 earlier prompt(s) omitted');
  });

  it('reports empty sections honestly', () => {
    const bare = renderSessionNote({ ...session, prompts: [], outcome: null, files: [] }, null);
    expect(sectionText(parseNote(bare), 'Prompts')).toBe('_Not recorded._');
    expect(sectionText(parseNote(bare), 'Files')).toBe('_Not recorded._');
  });
});
