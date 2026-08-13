import { describe, expect, it } from 'vitest';
import { serializeCommit, serializeCommitDetail } from './serialize.js';
import type { CommitRow } from './store.js';

/**
 * The §5.2 `Commit` resource in both shapes, and the one rule that separates them: `files[]` is
 * on the single fetch and nowhere else (§5.2, restated by §6.10.1).
 */

function row(overrides: Partial<CommitRow> = {}): CommitRow {
  return {
    id: '018f6b2e-1111-7abc-8def-0123456789ab',
    repositoryId: '018f6b2e-2222-7abc-8def-0123456789ab',
    sessionId: null,
    sha: 'a'.repeat(40),
    authorName: 'Operator',
    authorEmail: 'operator@example.invalid',
    message: 'Close the commit read gap',
    branch: 'DEV',
    files: [
      { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 },
      { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
    ],
    committedAt: new Date('2026-08-12T14:03:22.000Z'),
    createdAt: new Date('2026-08-12T14:05:00.000Z'),
    updatedAt: new Date('2026-08-12T14:05:00.000Z'),
    searchTsv: '',
    ...overrides,
  } as CommitRow;
}

describe('serializeCommit (list item)', () => {
  it('derives the three aggregates from `files` and omits the array itself', () => {
    const resource = serializeCommit(row());

    expect(resource.filesChanged).toBe(2);
    expect(resource.additions).toBe(15);
    expect(resource.deletions).toBe(2);
    // The whole point of the §5.2 split: a list of commits carries counts, not file arrays.
    expect(Object.keys(resource)).not.toContain('files');
  });

  it('serializes instants as ISO 8601 UTC and keeps a null authorEmail null', () => {
    const resource = serializeCommit(row({ authorEmail: null }));

    expect(resource.committedAt).toBe('2026-08-12T14:03:22.000Z');
    expect(resource.createdAt).toBe('2026-08-12T14:05:00.000Z');
    expect(resource.authorEmail).toBeNull();
  });

  it('survives a malformed `files` array rather than 500-ing a list', () => {
    // `commits.files` is JSONB with only a `jsonb_typeof(...) = 'array'` CHECK: the elements
    // are untrusted at read time however carefully the sync wrote them.
    const resource = serializeCommit(
      row({
        files: [
          { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
          null,
          'not-an-object',
          { status: 'added' },
          { path: 'src/c.ts', additions: -4, deletions: Number.NaN },
        ] as unknown as CommitRow['files'],
      }),
    );

    // Two entries had a usable path; the nameless ones are dropped, and the count agrees.
    expect(resource.filesChanged).toBe(2);
    expect(resource.additions).toBe(3);
    expect(resource.deletions).toBe(1);
  });

  it('treats a non-array `files` value as no files', () => {
    const resource = serializeCommit(row({ files: null as unknown as CommitRow['files'] }));
    expect(resource.filesChanged).toBe(0);
    expect(resource.additions).toBe(0);
  });
});

describe('serializeCommitDetail (single fetch)', () => {
  it('adds `files[]` and keeps every list field identical', () => {
    const source = row();
    const detail = serializeCommitDetail(source);

    expect(detail.files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 },
      { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
    ]);
    expect({ ...detail, files: undefined }).toEqual({
      ...serializeCommit(source),
      files: undefined,
    });
  });

  it('never lets `filesChanged` disagree with the array it ships', () => {
    const detail = serializeCommitDetail(
      row({
        files: [
          { path: 'kept.ts', status: 'modified', additions: 1, deletions: 1 },
          { status: 'deleted' },
        ] as unknown as CommitRow['files'],
      }),
    );

    expect(detail.files).toHaveLength(detail.filesChanged);
  });

  it('folds an unrecognised status to `modified` instead of shipping a blank badge', () => {
    const detail = serializeCommitDetail(
      row({
        files: [{ path: 'x.ts', status: 'copied', additions: 0, deletions: 0 }],
      }),
    );

    expect(detail.files[0]?.status).toBe('modified');
  });
});
