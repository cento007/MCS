import { describe, expect, it } from 'vitest';
import { type AttributionCandidate, attributeCommit } from './attribution.js';

/**
 * The commit -> Session rule, in full.
 *
 * The cases that matter most are the ones where it **declines**: a wrong attribution is a false
 * statement about what an AI agent did to a repository, and nothing in the UI marks it as a
 * guess. A null is merely incomplete.
 */

const REPO = 'aaaaaaaa-0000-7000-8000-000000000001';
const OTHER_REPO = 'aaaaaaaa-0000-7000-8000-000000000002';
const SESSION = 'bbbbbbbb-0000-7000-8000-000000000001';
const OTHER_SESSION = 'bbbbbbbb-0000-7000-8000-000000000002';

const NOW = new Date('2026-08-13T12:00:00Z');
const STARTED = new Date('2026-08-13T10:00:00Z');
const ENDED = new Date('2026-08-13T11:00:00Z');

function session(overrides: Partial<AttributionCandidate> = {}): AttributionCandidate {
  return {
    sessionId: SESSION,
    repositoryId: REPO,
    branch: 'DEV',
    startedAt: STARTED,
    endedAt: ENDED,
    ...overrides,
  };
}

function commit(committedAt: string, branch: string | null = 'DEV', repositoryId = REPO) {
  return { repositoryId, branch, committedAt: new Date(committedAt) };
}

describe('attributeCommit — when it attributes', () => {
  it('attributes a commit inside the window, on the branch, in the repository', () => {
    expect(attributeCommit(commit('2026-08-13T10:30:00Z'), [session()], NOW)).toEqual({
      decision: 'attributed',
      sessionId: SESSION,
    });
  });

  it('includes both boundaries of the window', () => {
    expect(attributeCommit(commit('2026-08-13T10:00:00Z'), [session()], NOW).decision).toBe(
      'attributed',
    );
    expect(attributeCommit(commit('2026-08-13T11:00:00Z'), [session()], NOW).decision).toBe(
      'attributed',
    );
  });

  it('treats a still-running Session’s window as open-ended, bounded by `now`', () => {
    const running = session({ endedAt: null });
    expect(attributeCommit(commit('2026-08-13T11:59:00Z'), [running], NOW).decision).toBe(
      'attributed',
    );
    // Even a running Session cannot own a commit from the future.
    expect(attributeCommit(commit('2026-08-13T12:00:01Z'), [running], NOW).decision).toBe(
      'declined',
    );
  });

  it('picks the one Session that matches out of several that do not', () => {
    const candidates = [
      session({ sessionId: OTHER_SESSION, branch: 'main' }),
      session({ sessionId: 'cccccccc-0000-7000-8000-000000000003', repositoryId: OTHER_REPO }),
      session(),
    ];
    expect(attributeCommit(commit('2026-08-13T10:30:00Z'), candidates, NOW)).toEqual({
      decision: 'attributed',
      sessionId: SESSION,
    });
  });
});

describe('attributeCommit — when it declines, and why', () => {
  it('declines when the commit was made before the Session started', () => {
    // No skew tolerance. A commit one second early is exactly as likely to be the operator's.
    expect(attributeCommit(commit('2026-08-13T09:59:59Z'), [session()], NOW)).toEqual({
      decision: 'declined',
      reason: 'no_candidate',
    });
  });

  it('declines when the commit was made after the Session ended', () => {
    expect(attributeCommit(commit('2026-08-13T11:00:01Z'), [session()], NOW)).toEqual({
      decision: 'declined',
      reason: 'no_candidate',
    });
  });

  it('declines when the branches differ', () => {
    expect(
      attributeCommit(commit('2026-08-13T10:30:00Z', 'main'), [session({ branch: 'DEV' })], NOW),
    ).toEqual({ decision: 'declined', reason: 'no_candidate' });
  });

  it('declines on a case-only branch difference — git refs are case-sensitive', () => {
    expect(
      attributeCommit(commit('2026-08-13T10:30:00Z', 'dev'), [session({ branch: 'DEV' })], NOW)
        .decision,
    ).toBe('declined');
  });

  it('declines when the Session declared no branch', () => {
    expect(
      attributeCommit(commit('2026-08-13T10:30:00Z'), [session({ branch: null })], NOW).decision,
    ).toBe('declined');
  });

  it('declines when the commit’s branch is unknown', () => {
    expect(attributeCommit(commit('2026-08-13T10:30:00Z', null), [session()], NOW)).toEqual({
      decision: 'declined',
      reason: 'commit_branch_unknown',
    });
    expect(attributeCommit(commit('2026-08-13T10:30:00Z', ''), [session()], NOW)).toEqual({
      decision: 'declined',
      reason: 'commit_branch_unknown',
    });
  });

  it('declines when the Session belongs to another repository', () => {
    expect(
      attributeCommit(commit('2026-08-13T10:30:00Z', 'DEV', OTHER_REPO), [session()], NOW).decision,
    ).toBe('declined');
  });

  it('declines when the Session declared no repository at all', () => {
    expect(
      attributeCommit(commit('2026-08-13T10:30:00Z'), [session({ repositoryId: null })], NOW)
        .decision,
    ).toBe('declined');
  });

  it('declines when the Session never launched', () => {
    expect(
      attributeCommit(commit('2026-08-13T10:30:00Z'), [session({ startedAt: null })], NOW).decision,
    ).toBe('declined');
  });

  it('DECLINES when two Sessions could both own it — the case that must not guess', () => {
    // Two Sessions running concurrently on the same branch of the same repository are
    // indistinguishable from a commit's point of view. Attributing to "the newest" would be a
    // coin flip presented as evidence.
    const overlapping = [
      session(),
      session({ sessionId: OTHER_SESSION, startedAt: new Date('2026-08-13T10:15:00Z') }),
    ];

    expect(attributeCommit(commit('2026-08-13T10:30:00Z'), overlapping, NOW)).toEqual({
      decision: 'declined',
      reason: 'ambiguous',
    });
  });

  it('declines with an empty candidate list', () => {
    expect(attributeCommit(commit('2026-08-13T10:30:00Z'), [], NOW)).toEqual({
      decision: 'declined',
      reason: 'no_candidate',
    });
  });

  it('uses no evidence the rule does not name — author identity is irrelevant', () => {
    // The signature has nowhere to put an author, deliberately: Claude Code commits with the
    // operator's own git identity, so matching on it would attribute every hand-made commit to
    // whichever Session was open.
    expect(attributeCommit.length).toBe(3);
  });
});
