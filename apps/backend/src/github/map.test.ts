import { describe, expect, it } from 'vitest';
import {
  mapCommitDetail,
  mapCommitFiles,
  mapCommitSummary,
  mapFirstReviewAt,
  mapPullRequest,
  mapPullRequestState,
  mapRepository,
} from './map.js';

const SHA = '9d3f5b8a1c2e4f6a7b8c9d0e1f2a3b4c5d6e7f80';

describe('mapRepository', () => {
  it('maps the fields the sync stores', () => {
    expect(
      mapRepository({
        full_name: 'cento007/MCS',
        default_branch: 'DEV',
        private: true,
        html_url: 'https://github.com/cento007/MCS',
        archived: false,
      }),
    ).toEqual({
      fullName: 'cento007/MCS',
      defaultBranch: 'DEV',
      visibility: 'private',
      htmlUrl: 'https://github.com/cento007/MCS',
      archived: false,
    });
  });

  it('maps `private: false` to public', () => {
    expect(mapRepository({ private: false })?.visibility).toBe('public');
  });

  it('answers `unknown` rather than guessing when `private` is absent', () => {
    // Guessing "public" for a repository whose visibility GitHub did not state would put a
    // private repository's name in a UI badge that says otherwise.
    expect(mapRepository({ full_name: 'o/r' })?.visibility).toBe('unknown');
  });

  it('returns null for a non-object', () => {
    expect(mapRepository(null)).toBeNull();
    expect(mapRepository([])).toBeNull();
    expect(mapRepository('nope')).toBeNull();
  });
});

describe('mapCommitSummary', () => {
  const raw = {
    sha: SHA,
    commit: {
      message: 'Add the GitHub integration',
      author: { name: 'Operator', email: 'op@example.test', date: '2026-08-13T08:00:00Z' },
      committer: { name: 'Operator', email: 'op@example.test', date: '2026-08-13T08:05:00Z' },
    },
    author: { login: 'cento007' },
  };

  it('prefers the committer date over the author date', () => {
    // A rebase rewrites the committer date and leaves the author date alone; the committer date
    // is the one that answers "was this made while the Session was running".
    expect(mapCommitSummary(raw)?.committedAt.toISOString()).toBe('2026-08-13T08:05:00.000Z');
  });

  it('falls back to the author date when GitHub omits the committer', () => {
    const { committer: _dropped, ...commit } = raw.commit;
    expect(mapCommitSummary({ ...raw, commit })?.committedAt.toISOString()).toBe(
      '2026-08-13T08:00:00.000Z',
    );
  });

  it('prefers the git identity over the GitHub login for author_name', () => {
    expect(mapCommitSummary(raw)?.authorName).toBe('Operator');
  });

  it('falls back to the GitHub login, then to a stated placeholder', () => {
    const noName = { ...raw, commit: { ...raw.commit, author: { date: '2026-08-13T08:00:00Z' } } };
    expect(mapCommitSummary(noName)?.authorName).toBe('cento007');

    const nothing = { sha: SHA, commit: { committer: { date: '2026-08-13T08:00:00Z' } } };
    // `commits.author_name` is NOT NULL; dropping the commit would be worse than saying so.
    expect(mapCommitSummary(nothing)?.authorName).toBe('unknown');
  });

  it('rejects a sha the CHECK constraint would reject', () => {
    // `ck_commits_sha`: 40 or 64 lower-case hex. Anything else must be dropped here rather than
    // allowed to abort the insert of the commits around it.
    expect(mapCommitSummary({ ...raw, sha: 'abc123' })).toBeNull();
    expect(mapCommitSummary({ ...raw, sha: `${SHA}zz` })).toBeNull();
    expect(mapCommitSummary({ ...raw, sha: 42 })).toBeNull();
  });

  it('lower-cases a sha GitHub returned upper-cased', () => {
    expect(mapCommitSummary({ ...raw, sha: SHA.toUpperCase() })?.sha).toBe(SHA);
  });

  it('accepts a 64-character (SHA-256) sha', () => {
    const sha256 = 'a'.repeat(64);
    expect(mapCommitSummary({ ...raw, sha: sha256 })?.sha).toBe(sha256);
  });

  it('returns null when there is no usable timestamp', () => {
    expect(mapCommitSummary({ sha: SHA, commit: { author: { date: 'not a date' } } })).toBeNull();
  });
});

describe('mapCommitFiles', () => {
  it('maps GitHub’s status vocabulary onto §5.2’s', () => {
    expect(
      mapCommitFiles([
        { filename: 'a.ts', status: 'added', additions: 10, deletions: 0 },
        { filename: 'b.ts', status: 'removed', additions: 0, deletions: 4 },
        { filename: 'c.ts', status: 'renamed', additions: 1, deletions: 1 },
        { filename: 'd.ts', status: 'modified', additions: 2, deletions: 2 },
        // `copied` / `changed` / `unchanged` have no §5.2 spelling and fold to `modified`
        // rather than rendering as a blank badge in the Files panel (§6.10.2).
        { filename: 'e.ts', status: 'copied', additions: 0, deletions: 0 },
        { filename: 'f.ts', status: 'changed', additions: 0, deletions: 0 },
      ]).map((file) => file.status),
    ).toEqual(['added', 'deleted', 'renamed', 'modified', 'modified', 'modified']);
  });

  it('drops entries with no filename and defaults junk counts to 0', () => {
    expect(mapCommitFiles([{ status: 'added' }, { filename: 'a.ts', additions: 'lots' }])).toEqual([
      { path: 'a.ts', status: 'modified', additions: 0, deletions: 0 },
    ]);
  });

  it('is empty for a non-array', () => {
    expect(mapCommitFiles(undefined)).toEqual([]);
    expect(mapCommitFiles({ files: [] })).toEqual([]);
  });

  it('caps a pathological file list', () => {
    const files = Array.from({ length: 5_000 }, (_unused, index) => ({
      filename: `f${String(index)}.ts`,
      status: 'added',
    }));
    expect(mapCommitFiles(files)).toHaveLength(1_000);
  });
});

describe('mapCommitDetail', () => {
  it('carries files through', () => {
    const detail = mapCommitDetail({
      sha: SHA,
      commit: { message: 'x', committer: { date: '2026-08-13T08:00:00Z' }, author: { name: 'a' } },
      files: [{ filename: 'a.ts', status: 'added', additions: 1, deletions: 0 }],
    });
    expect(detail?.files).toEqual([{ path: 'a.ts', status: 'added', additions: 1, deletions: 0 }]);
  });

  it('is null when the summary is unusable', () => {
    expect(mapCommitDetail({ sha: 'nope' })).toBeNull();
  });
});

describe('mapPullRequestState — GitHub truth, not the PRD’s lifecycle words (A3)', () => {
  it.each([
    // GitHub `state`, `draft`, `merged_at`  ->  stored state
    ['open', false, null, 'open'],
    ['open', true, null, 'draft'],
    ['closed', false, null, 'closed'],
    // A merged PR is `state: 'closed'` AND has `merged_at`; checking merged first is what stops
    // a merge from being recorded as a rejection.
    ['closed', false, new Date('2026-08-01T00:00:00Z'), 'merged'],
    // A draft that was merged is merged.
    ['closed', true, new Date('2026-08-01T00:00:00Z'), 'merged'],
    // A draft that was closed is closed, not draft.
    ['closed', true, null, 'closed'],
  ])('state=%s draft=%s merged=%s -> %s', (state, draft, mergedAt, expected) => {
    expect(mapPullRequestState(state, draft, mergedAt)).toBe(expected);
  });

  it('never invents a "reviewed" or "rejected" state', () => {
    // Those are event names (§15.2 #18/#20), and `ck_pull_requests_state` would reject them.
    expect(mapPullRequestState('reviewed', false, null)).toBe('open');
  });
});

describe('mapPullRequest', () => {
  const raw = {
    number: 42,
    title: 'Add GitHub integration',
    body: 'Closes #1',
    state: 'open',
    draft: false,
    user: { login: 'cento007' },
    head: { ref: 'feature/github' },
    base: { ref: 'DEV' },
    html_url: 'https://github.com/cento007/MCS/pull/42',
    created_at: '2026-08-10T10:00:00Z',
    updated_at: '2026-08-12T10:00:00Z',
    merged_at: null,
    closed_at: null,
  };

  it('maps every stored field', () => {
    expect(mapPullRequest(raw)).toEqual({
      number: 42,
      title: 'Add GitHub integration',
      description: 'Closes #1',
      state: 'open',
      author: 'cento007',
      headBranch: 'feature/github',
      baseBranch: 'DEV',
      url: 'https://github.com/cento007/MCS/pull/42',
      openedAt: new Date('2026-08-10T10:00:00Z'),
      mergedAt: null,
      closedAt: null,
      updatedAt: new Date('2026-08-12T10:00:00Z'),
    });
  });

  it('rejects a number the CHECK constraint would reject', () => {
    expect(mapPullRequest({ ...raw, number: 0 })).toBeNull();
    expect(mapPullRequest({ ...raw, number: -1 })).toBeNull();
    expect(mapPullRequest({ ...raw, number: 1.5 })).toBeNull();
    expect(mapPullRequest({ ...raw, number: '42' })).toBeNull();
  });

  it('falls back to `#n` when the title is missing (title is NOT NULL)', () => {
    const { title: _dropped, ...withoutTitle } = raw;
    expect(mapPullRequest(withoutTitle)?.title).toBe('#42');
  });
});

describe('mapFirstReviewAt', () => {
  it('takes the earliest submitted review', () => {
    expect(
      mapFirstReviewAt([
        { state: 'APPROVED', submitted_at: '2026-08-12T10:00:00Z' },
        { state: 'COMMENTED', submitted_at: '2026-08-11T10:00:00Z' },
      ])?.toISOString(),
    ).toBe('2026-08-11T10:00:00.000Z');
  });

  it('ignores PENDING reviews — a draft only its author can see is not a review', () => {
    expect(
      mapFirstReviewAt([
        { state: 'PENDING', submitted_at: '2026-08-01T10:00:00Z' },
        { state: 'APPROVED', submitted_at: '2026-08-12T10:00:00Z' },
      ])?.toISOString(),
    ).toBe('2026-08-12T10:00:00.000Z');
  });

  it('counts COMMENTED and CHANGES_REQUESTED as reviews', () => {
    expect(
      mapFirstReviewAt([{ state: 'CHANGES_REQUESTED', submitted_at: '2026-08-12T10:00:00Z' }]),
    ).not.toBeNull();
  });

  it('is null for an empty list or a non-array', () => {
    expect(mapFirstReviewAt([])).toBeNull();
    expect(mapFirstReviewAt({ reviews: [] })).toBeNull();
    expect(mapFirstReviewAt([{ state: 'PENDING' }])).toBeNull();
  });
});
