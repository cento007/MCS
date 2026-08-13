import { describe, expect, it } from 'vitest';
import { serializePullRequest, serializePullRequestDetail } from './serialize.js';
import type { PullRequestRow } from './store.js';

/**
 * The §5.3 `PullRequest` resource — mostly a rename table (TDS 03 §3.9, findings N2/N3), which
 * is exactly the kind of mapping that is silently wrong until something asserts it.
 */

function row(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: '018f6b2e-1111-7abc-8def-0123456789ab',
    repositoryId: '018f6b2e-2222-7abc-8def-0123456789ab',
    number: 42,
    title: 'Serve the commits and pull requests the sync writes',
    description: 'Closes the read gap.',
    state: 'open',
    author: 'cento007',
    headBranch: 'DEV',
    baseBranch: 'main',
    url: 'https://github.com/cento007/MCS/pull/42',
    openedAt: new Date('2026-08-12T09:00:00.000Z'),
    reviewedAt: new Date('2026-08-12T11:30:00.000Z'),
    mergedAt: null,
    closedAt: null,
    createdAt: new Date('2026-08-12T09:05:00.000Z'),
    updatedAt: new Date('2026-08-12T11:35:00.000Z'),
    searchTsv: '',
    ...overrides,
  } as PullRequestRow;
}

describe('serializePullRequest', () => {
  it('maps the three renamed columns to their §5.3 API names', () => {
    const resource = serializePullRequest(row());

    expect(resource.authorLogin).toBe('cento007');
    expect(resource.sourceBranch).toBe('DEV');
    expect(resource.targetBranch).toBe('main');
    // And does not also leak the column spelling — one vocabulary per surface (F9.5).
    expect(Object.keys(resource)).not.toContain('author');
    expect(Object.keys(resource)).not.toContain('headBranch');
    expect(Object.keys(resource)).not.toContain('baseBranch');
  });

  it('keeps nullable columns null instead of inventing a value', () => {
    const resource = serializePullRequest(
      row({
        author: null,
        headBranch: null,
        baseBranch: null,
        url: null,
        openedAt: null,
        reviewedAt: null,
      }),
    );

    expect(resource.authorLogin).toBeNull();
    expect(resource.sourceBranch).toBeNull();
    expect(resource.targetBranch).toBeNull();
    expect(resource.url).toBeNull();
    expect(resource.openedAt).toBeNull();
    expect(resource.reviewedAt).toBeNull();
  });

  it('serializes every instant as ISO 8601 UTC (F4.2)', () => {
    const resource = serializePullRequest(
      row({
        mergedAt: new Date('2026-08-13T08:00:00.000Z'),
        closedAt: new Date('2026-08-13T08:00:00.000Z'),
      }),
    );

    expect(resource.openedAt).toBe('2026-08-12T09:00:00.000Z');
    expect(resource.reviewedAt).toBe('2026-08-12T11:30:00.000Z');
    expect(resource.mergedAt).toBe('2026-08-13T08:00:00.000Z');
    expect(resource.closedAt).toBe('2026-08-13T08:00:00.000Z');
  });

  it('carries all four GitHub-truth states, `draft` included (A3)', () => {
    for (const state of ['open', 'merged', 'closed', 'draft'] as const) {
      expect(serializePullRequest(row({ state })).state).toBe(state);
    }
  });

  it('degrades an unrecognised state to `open` rather than 500-ing the list', () => {
    expect(serializePullRequest(row({ state: 'rejected' })).state).toBe('open');
  });

  it('omits the PR body from the list shape', () => {
    expect(Object.keys(serializePullRequest(row()))).not.toContain('description');
  });
});

describe('serializePullRequestDetail', () => {
  it('adds `description` and changes nothing else', () => {
    const source = row();
    const detail = serializePullRequestDetail(source);

    expect(detail.description).toBe('Closes the read gap.');
    expect({ ...detail, description: undefined }).toEqual({
      ...serializePullRequest(source),
      description: undefined,
    });
  });

  it('serves a null body as null', () => {
    expect(serializePullRequestDetail(row({ description: null })).description).toBeNull();
  });
});
