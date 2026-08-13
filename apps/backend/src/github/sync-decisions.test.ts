import { describe, expect, it } from 'vitest';
import type { GithubPullRequest } from './map.js';
import type { PullRequestRow } from './store.js';
import { hasMoved, pullRequestEvents } from './sync.js';

/**
 * The pure half of a sync: which §15.2 events a pull request produces, and whether anything
 * about it actually moved.
 *
 * The two properties under test are the ones that decide whether the Dashboard is useful:
 * **a poll that finds nothing emits nothing**, and **first sight of a year-old merged PR does
 * not replay a year of history** onto the `repositories` channel.
 */

const OPENED = new Date('2026-08-01T10:00:00Z');
const MERGED = new Date('2026-08-05T10:00:00Z');
const REVIEWED = new Date('2026-08-03T10:00:00Z');

function incoming(overrides: Partial<GithubPullRequest> = {}): GithubPullRequest {
  return {
    number: 42,
    title: 'Add the GitHub integration',
    description: 'Closes #1',
    state: 'open',
    author: 'cento007',
    headBranch: 'feature/github',
    baseBranch: 'DEV',
    url: 'https://github.com/cento007/MCS/pull/42',
    openedAt: OPENED,
    mergedAt: null,
    closedAt: null,
    updatedAt: new Date('2026-08-06T10:00:00Z'),
    ...overrides,
  };
}

function stored(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  const base = incoming();
  return {
    id: 'dddddddd-0000-7000-8000-000000000001',
    repositoryId: 'aaaaaaaa-0000-7000-8000-000000000001',
    number: base.number,
    title: base.title,
    description: base.description,
    state: base.state,
    author: base.author,
    headBranch: base.headBranch,
    baseBranch: base.baseBranch,
    url: base.url,
    openedAt: base.openedAt,
    reviewedAt: null,
    mergedAt: null,
    closedAt: null,
    createdAt: new Date('2026-08-01T10:00:01Z'),
    updatedAt: new Date('2026-08-01T10:00:01Z'),
    searchTsv: null,
    ...overrides,
  } as PullRequestRow;
}

describe('pullRequestEvents — first sight', () => {
  it('emits exactly one event, describing the current state', () => {
    expect(pullRequestEvents(null, incoming(), null)).toEqual([
      { type: 'pull_request.opened', payload: {} },
    ]);
  });

  it('emits `merged` — not `opened` then `merged` — for a PR that was merged long ago', () => {
    // Replaying a year of history as though it just happened is exactly what would make the
    // Dashboard useless on the day a repository is connected.
    expect(
      pullRequestEvents(
        null,
        incoming({ state: 'merged', mergedAt: MERGED, closedAt: MERGED }),
        REVIEWED,
      ),
    ).toEqual([{ type: 'pull_request.merged', payload: {} }]);
  });

  it('emits `closed` with the PRD’s "Rejected" reason for a closed, unmerged PR', () => {
    // A3: the PRD's lifecycle words are event names. GitHub cannot distinguish "superseded"
    // from "rejected" — both are `state: closed` with no `merged_at` — so `rejected` is the
    // only reason this producer can honestly report.
    expect(pullRequestEvents(null, incoming({ state: 'closed', closedAt: MERGED }), null)).toEqual([
      { type: 'pull_request.closed', payload: { reason: 'rejected' } },
    ]);
  });

  it('emits `opened` for a draft — draft is a state, not a lifecycle fact', () => {
    expect(pullRequestEvents(null, incoming({ state: 'draft' }), null)).toEqual([
      { type: 'pull_request.opened', payload: {} },
    ]);
  });
});

describe('pullRequestEvents — transitions', () => {
  it('emits nothing when nothing moved (the steady state of every poll)', () => {
    expect(pullRequestEvents(stored(), incoming(), null)).toEqual([]);
  });

  it('emits nothing when only the title changed — a row update is not a lifecycle fact', () => {
    expect(pullRequestEvents(stored(), incoming({ title: 'Renamed' }), null)).toEqual([]);
  });

  it('emits `reviewed` the first time a review appears, and never again', () => {
    expect(pullRequestEvents(stored(), incoming(), REVIEWED)).toEqual([
      { type: 'pull_request.reviewed', payload: {} },
    ]);
    expect(pullRequestEvents(stored({ reviewedAt: REVIEWED }), incoming(), REVIEWED)).toEqual([]);
  });

  it('emits `merged` on open -> merged', () => {
    expect(
      pullRequestEvents(
        stored(),
        incoming({ state: 'merged', mergedAt: MERGED, closedAt: MERGED }),
        null,
      ),
    ).toEqual([{ type: 'pull_request.merged', payload: {} }]);
  });

  it('emits `closed` on open -> closed', () => {
    expect(
      pullRequestEvents(stored(), incoming({ state: 'closed', closedAt: MERGED }), null),
    ).toEqual([{ type: 'pull_request.closed', payload: { reason: 'rejected' } }]);
  });

  it('emits `opened` on closed -> open (a reopen)', () => {
    expect(
      pullRequestEvents(stored({ state: 'closed', closedAt: MERGED }), incoming(), null),
    ).toEqual([{ type: 'pull_request.opened', payload: {} }]);
  });

  it('emits nothing on draft -> open: §15.2 has no event for it', () => {
    expect(
      pullRequestEvents(stored({ state: 'draft' }), incoming({ state: 'open' }), null),
    ).toEqual([]);
    expect(
      pullRequestEvents(stored({ state: 'open' }), incoming({ state: 'draft' }), null),
    ).toEqual([]);
  });

  it('emits both `reviewed` and `merged` when a poll observes them together', () => {
    // A fifteen-minute poll routinely sees several facts become true at once; each is its own
    // event, in the order they happened.
    expect(
      pullRequestEvents(
        stored(),
        incoming({ state: 'merged', mergedAt: MERGED, closedAt: MERGED }),
        REVIEWED,
      ),
    ).toEqual([
      { type: 'pull_request.reviewed', payload: {} },
      { type: 'pull_request.merged', payload: {} },
    ]);
  });
});

describe('hasMoved', () => {
  it('is false for an identical PR — the idempotence gate', () => {
    expect(hasMoved(stored(), incoming())).toBe(false);
  });

  it.each([
    ['title', { title: 'Different' }],
    ['description', { description: 'Different' }],
    ['state', { state: 'draft' as const }],
    ['author', { author: 'someone-else' }],
    ['headBranch', { headBranch: 'other' }],
    ['baseBranch', { baseBranch: 'main' }],
    ['url', { url: 'https://github.com/o/r/pull/43' }],
    ['mergedAt', { mergedAt: MERGED }],
    ['closedAt', { closedAt: MERGED }],
    ['openedAt', { openedAt: new Date('2020-01-01T00:00:00Z') }],
  ])('is true when %s changed', (_field, patch) => {
    expect(hasMoved(stored(), incoming(patch))).toBe(true);
  });

  it('compares timestamps by instant, not by object identity', () => {
    expect(hasMoved(stored(), incoming({ openedAt: new Date(OPENED.getTime()) }))).toBe(false);
  });
});
