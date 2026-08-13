import { describe, expect, it } from 'vitest';
import { draftAdrFromSession, type SessionEvidence } from './adr-draft.js';

/**
 * The generation choice under test: **deterministic assembly from session data**, not a model.
 *
 * These cases pin the two properties that follow from that choice and matter most —
 * determinism (the note is re-rendered on every sync, so a varying draft would rewrite the
 * operator's vault forever) and **no fabrication** (a plausible invented "Alternatives
 * considered" is worse than an empty one, because only the empty one is honest about what the
 * session recorded).
 */

const evidence: SessionEvidence = {
  sessionId: '0199a3f1-6c2e-7a10-9f01-3d4e5f607182',
  title: 'Replace Redis with pg-boss',
  state: 'completed',
  sessionType: 'managed',
  runtime: 'claude_code',
  model: 'claude-opus-5',
  branch: 'DEV',
  workingDir: 'D:\\Repos\\MCS',
  projectName: 'Mission Control',
  repositoryName: 'MCS',
  startedAt: new Date('2026-08-13T08:00:00.000Z'),
  completedAt: new Date('2026-08-13T08:42:00.000Z'),
  durationMs: 2_520_000,
  numTurns: 12,
  totalCostUsd: '1.230000',
  failureReason: null,
  prompts: ['Get rid of Redis; it has no Windows build.'],
  promptsTotal: 1,
  outcome: 'Swapped the queue over to pg-boss and removed the Redis service.',
  files: ['D:\\Repos\\MCS\\packages\\shared\\src\\queue\\pg-boss.ts'],
  filesTotal: 1,
};

describe('draftAdrFromSession', () => {
  it('fills all four PRD §7.3 sections', () => {
    const draft = draftAdrFromSession(evidence);

    expect(draft.context.length).toBeGreaterThan(0);
    expect(draft.decision.length).toBeGreaterThan(0);
    expect(draft.alternatives.length).toBeGreaterThan(0);
    expect(draft.consequences.length).toBeGreaterThan(0);
  });

  it('takes its title from the session, bounded to the column limit', () => {
    expect(draftAdrFromSession(evidence).title).toBe('Replace Redis with pg-boss');
    expect(draftAdrFromSession({ ...evidence, title: 'x'.repeat(400) }).title.length).toBe(300);
  });

  it('falls back to the session id when there is no title', () => {
    expect(draftAdrFromSession({ ...evidence, title: null }).title).toBe(
      'Decision from session 0199a3f1',
    );
  });

  it('puts the evidence in Context: what ran, and what was asked, verbatim', () => {
    const { context } = draftAdrFromSession(evidence);

    expect(context).toContain('**Project:** Mission Control');
    expect(context).toContain('**Branch:** DEV');
    expect(context).toContain('**Started:** 2026-08-13T08:00:00.000Z');
    expect(context).toContain('> Get rid of Redis; it has no Windows build.');
  });

  it('labels the session conclusion as a conclusion, not as the decision', () => {
    const { decision } = draftAdrFromSession(evidence);

    expect(decision).toContain('how the session concluded');
    expect(decision).toContain('Swapped the queue over to pg-boss');
    expect(decision).toContain('[!todo]');
  });

  it('invents no alternatives, and says why there are none', () => {
    const { alternatives } = draftAdrFromSession(evidence);

    expect(alternatives).toContain('[!todo]');
    expect(alternatives).toMatch(/not recoverable from a session transcript/);
  });

  it('lists the files a session touched as its checkable consequence', () => {
    const { consequences } = draftAdrFromSession(evidence);

    expect(consequences).toContain('packages\\shared\\src\\queue\\pg-boss.ts');
  });

  it('says how many prompts and files it left out rather than truncating silently', () => {
    const draft = draftAdrFromSession({ ...evidence, promptsTotal: 30, filesTotal: 12 });

    expect(draft.context).toContain('29 further prompt(s)');
    expect(draft.consequences).toContain('…and 11 more.');
  });

  it('is deterministic — same evidence, same bytes', () => {
    expect(draftAdrFromSession(evidence)).toEqual(draftAdrFromSession(evidence));
  });

  it('copes with a session that recorded nothing at all', () => {
    const draft = draftAdrFromSession({
      ...evidence,
      prompts: [],
      promptsTotal: 0,
      outcome: null,
      files: [],
      filesTotal: 0,
      model: null,
      branch: null,
      workingDir: null,
      repositoryName: null,
    });

    expect(draft.decision).toContain('no assistant response');
    expect(draft.consequences).toContain('touched no files');
  });

  it('records a failure reason when the session failed', () => {
    const draft = draftAdrFromSession({
      ...evidence,
      state: 'failed',
      failureReason: 'process_crash',
    });

    expect(draft.context).toContain('**Session outcome:** failed');
    expect(draft.context).toContain('**Failure reason:** process_crash');
  });
});
