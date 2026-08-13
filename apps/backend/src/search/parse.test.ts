import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { assertQueryNodesWithinBudget, MAX_QUERY_NODES, parseSearchTypes } from './parse.js';
import { SEARCH_TYPES } from './types.js';

/**
 * `?types=` and the query bound — the two places a search request can be rejected before any
 * SQL is built. No database: these are the rules, not the query.
 */

function rejectionOf(call: () => unknown): ApiError {
  try {
    call();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected an ApiError');
}

describe('parseSearchTypes', () => {
  it('searches all five types when `types` is omitted', () => {
    expect(parseSearchTypes(undefined)).toEqual([
      'session',
      'adr',
      'commit',
      'message',
      'pull_request',
    ]);
  });

  it('accepts the singular discriminators, which are the response `type` values verbatim', () => {
    for (const type of SEARCH_TYPES) {
      expect(parseSearchTypes(type)).toEqual([type]);
    }
  });

  it('canonicalises order and removes duplicates so one search has one fingerprint', () => {
    // `types=adr,session` and `types=session,adr` are the same search; the cursor fingerprint is
    // computed over this list, so they must not produce two incompatible cursors.
    expect(parseSearchTypes('adr,session')).toEqual(parseSearchTypes('session,adr'));
    expect(parseSearchTypes('commit,commit,commit')).toEqual(['commit']);
  });

  it('tolerates whitespace around values', () => {
    expect(parseSearchTypes(' session , commit ')).toEqual(['session', 'commit']);
  });

  it('rejects an unknown value with VALIDATION_FAILED and names it in `details`', () => {
    const error = rejectionOf(() => parseSearchTypes('session,notatype'));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(400);
    expect(error.details).toMatchObject({ parameter: 'types', rejected: ['notatype'] });
    expect(error.details?.['allowed']).toEqual([...SEARCH_TYPES]);
  });

  it('rejects the withdrawn plural spellings rather than quietly searching everything', () => {
    // WS7 N17: plural was withdrawn precisely so `types=sessions` fails loudly. Dropping it
    // silently would widen the search to all five and answer a question nobody asked.
    const error = rejectionOf(() => parseSearchTypes('sessions,adrs'));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toMatchObject({ rejected: ['sessions', 'adrs'] });
  });

  it('rejects an empty segment — a trailing comma is a typo, not a request for everything', () => {
    expect(rejectionOf(() => parseSearchTypes('session,')).code).toBe('VALIDATION_FAILED');
    expect(rejectionOf(() => parseSearchTypes(',')).code).toBe('VALIDATION_FAILED');
  });
});

describe('assertQueryNodesWithinBudget', () => {
  it('admits a query at the budget', () => {
    expect(() => assertQueryNodesWithinBudget(MAX_QUERY_NODES)).not.toThrow();
    expect(() => assertQueryNodesWithinBudget(0)).not.toThrow();
  });

  it('rejects one node past it, reporting both numbers', () => {
    const error = rejectionOf(() => assertQueryNodesWithinBudget(MAX_QUERY_NODES + 1));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toMatchObject({
      parameter: 'q',
      queryNodes: MAX_QUERY_NODES + 1,
      maxQueryNodes: MAX_QUERY_NODES,
    });
  });
});
