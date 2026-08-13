import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/index.js';
import { contextGapLabel, contextPackageFilename, describeDocumentFailure } from './documents.js';

/**
 * The pure half of the §6.7 document path. The wired half lives in `SessionDocuments.test.tsx`.
 */

describe('describeDocumentFailure — the 409 the menu is supposed to prevent', () => {
  it('names the state the Backend refused on, from `details.state`', () => {
    // Reachable only when the cached Session is stale — another tab, or a page left open across
    // a restart. "Conflict" alone tells the operator nothing they can act on.
    const error = new ApiError({
      code: 'CONFLICT',
      message: 'This session has not started, so there is nothing to export yet',
      status: 409,
      details: { state: 'created', action: 'export' },
      requestId: 'req-42',
    });

    const { message, detail } = describeDocumentFailure(error);

    expect(message).toBe(
      'This session has not started, so there is nothing to export yet (the session is created).',
    );
    // §11.1: the `requestId` rides along, because it is the bridge to the Backend log line.
    expect(detail).toBe('CONFLICT · req-42');
  });

  it('falls back to the plain message when the envelope carried no state', () => {
    const error = new ApiError({ code: 'INTERNAL', message: 'boom', status: 500 });

    expect(describeDocumentFailure(error)).toEqual({
      message: 'Mission Control hit an unexpected error.',
      detail: 'INTERNAL',
    });
  });

  it('ignores a non-string `state` rather than interpolating an object into a sentence', () => {
    const error = new ApiError({
      code: 'CONFLICT',
      message: 'refused',
      status: 409,
      details: { state: { was: 'created' } },
    });

    expect(describeDocumentFailure(error).message).toBe('refused');
  });
});

describe('contextGapLabel', () => {
  it('turns each wire reason into something an operator can act on', () => {
    expect(contextGapLabel('not_configured')).toBe('no embedding model configured');
    expect(contextGapLabel('stamp_mismatch')).toBe(
      'the stored vectors were built by a different model',
    );
  });

  it('renders an unknown reason as itself — a badge with an odd label beats no badge', () => {
    expect(contextGapLabel('some_future_reason')).toBe('some_future_reason');
  });
});

describe('contextPackageFilename', () => {
  it('mirrors the export’s naming rule for the document the Backend does not name', () => {
    expect(
      contextPackageFilename({
        id: '0198a2f3-9c41-7bd2-a10e-3f7c81c4fa1',
        title: 'Refactor the queue port',
        startedAt: '2026-08-12T12:00:05.000Z',
        createdAt: '2026-08-12T12:00:00.000Z',
      }),
    ).toBe('context-package-2026-08-12-1c4fa1-Refactor-the-queue-port.md');
  });

  it('falls back to createdAt, and to a bare name when neither timestamp is known', () => {
    expect(
      contextPackageFilename({
        id: '0198a2f3-9c41-7bd2-a10e-3f7c81c4fa1',
        title: null,
        startedAt: null,
        createdAt: '2026-08-12T12:00:00.000Z',
      }),
    ).toBe('context-package-2026-08-12-1c4fa1.md');
  });
});
