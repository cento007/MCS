import { describe, expect, it } from 'vitest';
import type { ApiError } from '../http/errors.js';
import { encodeCursor } from '../http/pagination.js';
import { decodePullRequestCursor, encodePullRequestCursor } from './cursors.js';

/**
 * The PullRequest ordering key (TDS 04 §1.2/§5.3): `(openedAt, id)` with `openedAt` allowed to
 * be `null`, because `pull_requests.opened_at` is nullable and those rows sort last.
 */

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as ApiError).code;
  }
  throw new Error('expected the call to throw');
};

describe('pull request cursors (§5.3)', () => {
  it('round-trips the openedAt/id pair', () => {
    const cursor = {
      openedAt: new Date('2026-08-12T14:03:22.000Z'),
      id: '018f6b2e-1111-7abc-8def-0123456789ab',
    };

    const decoded = decodePullRequestCursor(encodePullRequestCursor(cursor));

    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.openedAt?.toISOString()).toBe(cursor.openedAt.toISOString());
  });

  it('round-trips a NULL openedAt — the rows that sort last still need a cursor', () => {
    const cursor = { openedAt: null, id: '018f6b2e-2222-7abc-8def-0123456789ab' };

    const decoded = decodePullRequestCursor(encodePullRequestCursor(cursor));

    expect(decoded).toEqual({ openedAt: null, id: cursor.id });
  });

  it('passes undefined through', () => {
    expect(decodePullRequestCursor(undefined)).toBeUndefined();
  });

  it('rejects a cursor with no tiebreak or an unparseable instant', () => {
    expect(codeOf(() => decodePullRequestCursor(encodeCursor('2026-08-12T14:03:22.000Z')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodePullRequestCursor(encodeCursor('not-a-date|018f6b2e')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodePullRequestCursor(encodeCursor('2026-08-12T14:03:22.000Z|')))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => decodePullRequestCursor('not-base64url!!'))).toBe('INVALID_CURSOR');
  });

  it('does not confuse a Commit cursor with one of its own', () => {
    // Both encode `<instant>|<id>`, so a swapped cursor decodes rather than throwing — the
    // protection that matters is that neither route can be handed the *other* resource's page,
    // which the id namespace already guarantees. Recorded so the shared shape is a decision.
    const decoded = decodePullRequestCursor(
      encodeCursor('2026-08-12T14:03:22.000Z|018f6b2e-1111-7abc-8def-0123456789ab'),
    );
    expect(decoded?.id).toBe('018f6b2e-1111-7abc-8def-0123456789ab');
  });
});
