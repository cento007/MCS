import {
  type Assert,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  nullableEntityId,
  numberValue,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { SearchResultContext, SearchResultResource } from './types.js';
import { SEARCH_TYPES } from './types.js';

/** The `GET /api/v1/search` result shape (TDS 04 §11). */

const searchResultContextSchema = objectSchema('SearchResultContext', {
  /** The Project this result belongs to. Never null in practice — every branch has one. */
  projectId: nullableEntityId,
  /** Set for `commit` and `pull_request` (and for a `session` bound to a Repository). */
  repositoryId: nullableEntityId,
  /** Containment for `message`; attribution for `commit`. */
  sessionId: nullableEntityId,
});
export type _SearchResultContextShape = Assert<
  ExactShape<SearchResultContext, typeof searchResultContextSchema>
>;

export const searchResultSchema = objectSchema('SearchResult', {
  type: enumSchema('SearchType', SEARCH_TYPES),
  id: entityId,
  title: describe(
    stringValue,
    'PLAIN TEXT - render as text, never as HTML. It is the branch label straight from the corpus, so a commit subject containing markup arrives with those characters intact.',
  ),
  snippet: describe(
    stringValue,
    'HTML - and <mark>/</mark> are the only tags it can contain. Everything from the corpus is escaped first, which is what makes that promise also the bound.',
  ),
  occurredAt: timestampValue,
  /** `ts_rank_cd(…, 32)`, so every value is in `(0,1)` and ranks across types are comparable. */
  rank: numberValue,
  context: searchResultContextSchema,
});
export type _SearchResultShape = Assert<
  ExactShape<SearchResultResource, typeof searchResultSchema>
>;
