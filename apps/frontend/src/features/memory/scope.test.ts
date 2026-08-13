import { describe, expect, it } from 'vitest';
import {
  applyScope,
  describeScope,
  disabledScopeSources,
  EMPTY_SCOPE,
  isScoped,
  readScope,
  toggleSourceType,
  toggleTier,
  toSearchRequest,
} from './scope.js';
import { PROJECT_ID, SESSION_ID } from './test-support.js';

/**
 * The scope, from URL to request body and back.
 *
 * Two properties matter beyond round-tripping. First, an **absent** facet has to be genuinely
 * absent from the body: the Backend's schema is `additionalProperties: false` with `minItems: 1`
 * on both lists, so an empty array is a `400` rather than "no filter". Second, the scope has to be
 * **describable**, because a result list that silently searched a fifth of memory is
 * indistinguishable from one that searched all of it and found little.
 */

describe('reading a scope out of the URL', () => {
  it('collects repeated tier and source parameters', () => {
    const scope = readScope(
      new URLSearchParams('q=why+pg-boss&tier=session&tier=global&source=adr&source=commit'),
    );
    expect(scope.q).toBe('why pg-boss');
    expect(scope.tiers).toEqual(['session', 'global']);
    expect(scope.sourceTypes).toEqual(['adr', 'commit']);
  });

  it('orders tiers by the vocabulary, so two spellings of one question share a cache slot', () => {
    const one = readScope(new URLSearchParams('q=x&tier=global&tier=session'));
    const other = readScope(new URLSearchParams('q=x&tier=session&tier=global'));
    expect(one.tiers).toEqual(other.tiers);
  });

  it('drops a tier the Backend refuses, rather than sending a guaranteed 400', () => {
    // `agent` is in the F4.1 vocabulary and nothing produces it; the search schema excludes it.
    expect(readScope(new URLSearchParams('q=x&tier=agent')).tiers).toEqual([]);
    expect(readScope(new URLSearchParams('q=x&source=nonsense')).sourceTypes).toEqual([]);
  });

  it('ignores a malformed id instead of scoping to it', () => {
    expect(readScope(new URLSearchParams('q=x&project=not-a-uuid')).projectId).toBeNull();
    expect(readScope(new URLSearchParams(`q=x&project=${PROJECT_ID}`)).projectId).toBe(PROJECT_ID);
  });

  it('accepts a floor of 0 — "show me everything" is a legitimate debugging request', () => {
    expect(readScope(new URLSearchParams('q=x&floor=0')).minScore).toBe(0);
    expect(readScope(new URLSearchParams('q=x&floor=2')).minScore).toBeNull();
    expect(readScope(new URLSearchParams('q=x&floor=abc')).minScore).toBeNull();
  });

  it('round-trips through applyScope', () => {
    const scope = readScope(
      new URLSearchParams(`q=queue&tier=project&source=adr&project=${PROJECT_ID}&floor=0.4`),
    );
    expect(readScope(applyScope(new URLSearchParams(), scope))).toEqual(scope);
  });

  it('leaves unrelated parameters alone', () => {
    const next = applyScope(new URLSearchParams('panel=commits&q=old'), {
      ...EMPTY_SCOPE,
      q: 'new',
    });
    expect(next.get('panel')).toBe('commits');
    expect(next.get('q')).toBe('new');
  });
});

describe('the request body', () => {
  it('omits every unset facet rather than sending an empty list', () => {
    // `minItems: 1` means `tiers: []` is a validation failure, not "all tiers".
    const body = toSearchRequest({ ...EMPTY_SCOPE, q: 'why pg-boss' }, 10);
    expect(body).toEqual({ q: 'why pg-boss', limit: 10 });
    expect('tiers' in body).toBe(false);
    expect('projectId' in body).toBe(false);
    expect('minScore' in body).toBe(false);
  });

  it('carries every set facet through', () => {
    const body = toSearchRequest(
      {
        q: 'queue',
        tiers: ['project'],
        sourceTypes: ['adr'],
        projectId: PROJECT_ID,
        sessionId: null,
        minScore: 0,
      },
      10,
    );
    expect(body).toEqual({
      q: 'queue',
      limit: 10,
      tiers: ['project'],
      sourceTypes: ['adr'],
      projectId: PROJECT_ID,
      minScore: 0,
    });
  });
});

describe('the scope sentence', () => {
  it('says nothing is scoped when nothing is', () => {
    expect(describeScope(EMPTY_SCOPE, { project: null, session: null })).toBe(
      'Searching all memory.',
    );
    expect(isScoped(EMPTY_SCOPE)).toBe(false);
  });

  it('states the project by name AND states that global memory comes with it', () => {
    // The widening is a Backend behaviour the operator cannot infer from a pressed chip: a
    // project scope also returns `global`-tier chunks, because a vault note is nobody's project.
    const sentence = describeScope(
      { ...EMPTY_SCOPE, q: 'x', projectId: PROJECT_ID },
      { project: 'mission-control', session: null },
    );
    expect(sentence).toContain('mission-control');
    expect(sentence).toContain('global memory');
  });

  it('drops the global claim when the operator excluded that tier', () => {
    const sentence = describeScope(
      { ...EMPTY_SCOPE, q: 'x', projectId: PROJECT_ID, tiers: ['project'] },
      { project: 'mission-control', session: null },
    );
    expect(sentence).toContain('mission-control');
    expect(sentence).not.toContain('global memory');
  });

  it('says a session scope overrides the tier filter, because the Backend pins it', () => {
    const sentence = describeScope(
      { ...EMPTY_SCOPE, q: 'x', sessionId: SESSION_ID, tiers: ['global'] },
      { project: null, session: 'Refactor the queue port' },
    );
    expect(sentence).toContain('Refactor the queue port');
    expect(sentence).toContain('overrides the tier filter');
    expect(sentence).not.toContain('global tier');
  });

  it('falls back to the id when the name could not be read, rather than dropping the scope', () => {
    const sentence = describeScope(
      { ...EMPTY_SCOPE, q: 'x', projectId: PROJECT_ID },
      { project: null, session: null },
    );
    expect(sentence).toContain(PROJECT_ID);
  });

  it('states a floor override as a threshold, not as a scope', () => {
    // "Scoped to floor 0.00." read as though the floor filtered the corpus. It changes what is
    // worth showing, not what was searched, so it gets its own sentence — and it names the
    // default, which a response produced under an override cannot.
    const sentence = describeScope(
      { ...EMPTY_SCOPE, minScore: 0 },
      { project: null, session: null },
    );
    expect(sentence).toContain('Searching all memory.');
    expect(sentence).toContain('Relevance floor overridden to 0.00 (default 0.52)');
    expect(sentence).not.toContain('Scoped to floor');
  });
});

describe('a filter pinned to a source that is switched off', () => {
  // The toggle gates retrieval, not just indexing, so such a filter returns nothing whatever the
  // index holds — and the Backend reports that as `index_empty`, i.e. "run a backfill", which
  // cannot help. Naming the setting is what keeps "empty" from acquiring a fifth meaning.
  const scope = { ...EMPTY_SCOPE, sourceTypes: ['commit', 'adr'] as const };

  it('names only the sources actually switched off', () => {
    expect(disabledScopeSources(scope, { commit: false, adr: true })).toEqual(['commit']);
  });

  it('says nothing when the setting could not be read', () => {
    // `undefined` is "cannot tell" — accusing a working filter of being off is the worse error,
    // and a Backend that predates these keys answers nothing at all.
    expect(disabledScopeSources(scope, {})).toEqual([]);
  });

  it('ignores a source that is off but not part of the filter', () => {
    expect(disabledScopeSources(EMPTY_SCOPE, { commit: false })).toEqual([]);
  });
});

describe('toggling', () => {
  it('keeps tiers in vocabulary order however they are clicked', () => {
    const scope = toggleTier(toggleTier(EMPTY_SCOPE, 'global'), 'session');
    expect(scope.tiers).toEqual(['session', 'global']);
    expect(toggleTier(scope, 'global').tiers).toEqual(['session']);
  });

  it('toggles source types off again', () => {
    const scope = toggleSourceType(EMPTY_SCOPE, 'commit');
    expect(scope.sourceTypes).toEqual(['commit']);
    expect(toggleSourceType(scope, 'commit').sourceTypes).toEqual([]);
  });
});
