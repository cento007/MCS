import {
  isMemorySourceType,
  type MemorySourceType,
  type MemoryTier,
  PRODUCIBLE_MEMORY_TIERS,
} from '@mc/shared/types';
import { DEFAULT_MIN_SCORE } from './relevance.js';
import type { MemorySearchRequest } from './types.js';

/**
 * The query and its scope, held in the URL.
 *
 * Every part of a memory search lives in `?q=…&tier=…&project=…` rather than in component state,
 * for three reasons that all bite otherwise: a search is worth linking to (the `Ctrl+K` palette
 * hands off to `/memory?q=…`), the request object is the TanStack Query cache key so it has to be
 * derived from one stable place, and a scoped query that loses its scope on reload is a query
 * whose answer silently changes meaning.
 *
 * **`tier` and `source` repeat rather than being comma-joined** — `?tier=session&tier=global` —
 * because `URLSearchParams` already models repetition and a comma-joined list needs an escaping
 * rule the moment a value could contain one. `source_type` values are snake_case
 * (`pull_request`), so they are carried verbatim.
 */

export interface MemoryScope {
  /** The prose query. Empty means the screen is idle — no request is issued. */
  readonly q: string;
  /** Empty means *every* producible tier, which is what the Backend does with an absent list. */
  readonly tiers: readonly MemoryTier[];
  /** Empty means every source type. */
  readonly sourceTypes: readonly MemorySourceType[];
  readonly projectId: string | null;
  readonly sessionId: string | null;
  /** `null` means "use the Backend's measured default", which is the honest default. */
  readonly minScore: number | null;
}

export const EMPTY_SCOPE: MemoryScope = {
  q: '',
  tiers: [],
  sourceTypes: [],
  projectId: null,
  sessionId: null,
  minScore: null,
};

export const SCOPE_PARAMS = {
  q: 'q',
  tier: 'tier',
  source: 'source',
  project: 'project',
  session: 'session',
  floor: 'floor',
} as const;

/**
 * A UUID, loosely. The Backend pattern-validates these and answers `400` for anything else, so
 * the only job here is to keep a hand-edited URL from turning into a request that is guaranteed
 * to fail — a malformed id is dropped and the query runs unscoped, which the scope line then
 * shows honestly.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readScope(params: URLSearchParams): MemoryScope {
  const id = (key: string): string | null => {
    const value = params.get(key);
    return value !== null && UUID.test(value) ? value : null;
  };

  const floorRaw = params.get(SCOPE_PARAMS.floor);
  const floor = floorRaw === null ? Number.NaN : Number(floorRaw);

  return {
    q: params.get(SCOPE_PARAMS.q)?.trim() ?? '',
    // Deduplicated and ordered by the vocabulary, not by the URL: `?tier=global&tier=session`
    // and `?tier=session&tier=global` are the same question and must share a cache slot.
    tiers: PRODUCIBLE_MEMORY_TIERS.filter((tier) =>
      params.getAll(SCOPE_PARAMS.tier).includes(tier),
    ),
    sourceTypes: [...new Set(params.getAll(SCOPE_PARAMS.source))]
      .filter((value): value is MemorySourceType => isMemorySourceType(value))
      .sort(),
    projectId: id(SCOPE_PARAMS.project),
    sessionId: id(SCOPE_PARAMS.session),
    minScore: Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : null,
  };
}

/** Write a scope back into a `URLSearchParams`, leaving every unrelated parameter alone. */
export function applyScope(params: URLSearchParams, scope: MemoryScope): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of Object.values(SCOPE_PARAMS)) next.delete(key);

  if (scope.q.length > 0) next.set(SCOPE_PARAMS.q, scope.q);
  for (const tier of scope.tiers) next.append(SCOPE_PARAMS.tier, tier);
  for (const source of scope.sourceTypes) next.append(SCOPE_PARAMS.source, source);
  if (scope.projectId !== null) next.set(SCOPE_PARAMS.project, scope.projectId);
  if (scope.sessionId !== null) next.set(SCOPE_PARAMS.session, scope.sessionId);
  if (scope.minScore !== null) next.set(SCOPE_PARAMS.floor, String(scope.minScore));

  return next;
}

/**
 * The request body, with every absent facet genuinely absent.
 *
 * `additionalProperties: false` on the Backend's schema means an unknown field is a `400`, and
 * `tiers`/`sourceTypes` carry `minItems: 1` — so an empty array is a validation failure, not
 * "no filter". Under `exactOptionalPropertyTypes` the conditional spread is also the only way to
 * express "omit" rather than "send `undefined`", which `JSON.stringify` would drop anyway but
 * the type system would not.
 */
export function toSearchRequest(scope: MemoryScope, limit: number): MemorySearchRequest {
  return {
    q: scope.q,
    limit,
    ...(scope.tiers.length > 0 ? { tiers: scope.tiers } : {}),
    ...(scope.sourceTypes.length > 0 ? { sourceTypes: scope.sourceTypes } : {}),
    ...(scope.projectId === null ? {} : { projectId: scope.projectId }),
    // A session scope is the narrowest thing the API offers, and the Backend pins `tiers` to
    // `['session']` when it is present. The UI says so rather than sending a tier list that
    // would be overridden — see `describeScope`.
    ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
    ...(scope.minScore === null ? {} : { minScore: scope.minScore }),
  };
}

/**
 * The scope, in one sentence, for the line that sits above the results.
 *
 * "A project-scoped query must visibly be project-scoped" is a correctness property of this
 * screen, not a nicety: a result list that silently excluded four fifths of memory is
 * indistinguishable from one that searched everything and found little. Two behaviours the
 * sentence has to state because they are surprising and both come from the Backend:
 *
 *  - a **project** scope widens to include `global` memory (vault notes belong to no project, so
 *    they are not another project's), and
 *  - a **session** scope pins the tier list to `session` and overrides whatever tiers are set.
 */
export function describeScope(
  scope: MemoryScope,
  names: { readonly project: string | null; readonly session: string | null },
): string {
  const parts: string[] = [];

  if (scope.sessionId !== null) {
    parts.push(`session ${names.session ?? scope.sessionId}`);
    parts.push('session-tier chunks only — a session scope overrides the tier filter');
  } else {
    if (scope.projectId !== null) {
      const label = names.project ?? scope.projectId;
      parts.push(
        scope.tiers.length === 0 || scope.tiers.includes('global')
          ? `project ${label}, plus global memory`
          : `project ${label}`,
      );
    }
    if (scope.tiers.length > 0) parts.push(`${scope.tiers.join(' + ')} tier`);
  }

  if (scope.sourceTypes.length > 0) {
    parts.push(`${scope.sourceTypes.map((type) => type.replace('_', ' ')).join(' + ')} only`);
  }

  const scoped = parts.length === 0 ? 'Searching all memory.' : `Scoped to ${parts.join(' · ')}.`;

  // The floor is a *threshold*, not a scope — it changes what is worth showing, not what was
  // searched. Folding it into the scope list produced "Scoped to floor 0.00.", which reads as
  // though the floor were a filter over the corpus. It gets its own sentence.
  return scope.minScore === null
    ? scoped
    : `${scoped} Relevance floor overridden to ${scope.minScore.toFixed(2)} (default ${DEFAULT_MIN_SCORE.toFixed(2)}).`;
}

export function isScoped(scope: MemoryScope): boolean {
  return (
    scope.projectId !== null ||
    scope.sessionId !== null ||
    scope.tiers.length > 0 ||
    scope.sourceTypes.length > 0
  );
}

/**
 * Sources in the current filter that the operator has switched off in Settings → Memory.
 *
 * The toggle gates retrieval as well as indexing, so a filter pinned to a disabled source returns
 * nothing **whatever the index holds** — and the Backend reports that nothing as `index_empty` or
 * `below_threshold`, which are answers about the corpus and the query rather than about a
 * setting. Naming the setting is the only way this screen keeps "no results" from acquiring a
 * fifth meaning it cannot distinguish.
 *
 * A source whose flag could not be read is never listed: `undefined` is "cannot tell", exactly as
 * it is for `configured`, and accusing a working filter of being switched off is the worse error.
 */
export function disabledScopeSources(
  scope: MemoryScope,
  indexedSources: Readonly<Partial<Record<MemorySourceType, boolean>>>,
): readonly MemorySourceType[] {
  return scope.sourceTypes.filter((sourceType) => indexedSources[sourceType] === false);
}

export function toggleTier(scope: MemoryScope, tier: MemoryTier): MemoryScope {
  return {
    ...scope,
    tiers: scope.tiers.includes(tier)
      ? scope.tiers.filter((entry) => entry !== tier)
      : PRODUCIBLE_MEMORY_TIERS.filter((entry) => entry === tier || scope.tiers.includes(entry)),
  };
}

export function toggleSourceType(scope: MemoryScope, sourceType: MemorySourceType): MemoryScope {
  return {
    ...scope,
    sourceTypes: scope.sourceTypes.includes(sourceType)
      ? scope.sourceTypes.filter((entry) => entry !== sourceType)
      : [...scope.sourceTypes, sourceType].sort(),
  };
}
