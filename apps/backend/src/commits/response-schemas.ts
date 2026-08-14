import {
  type Assert,
  arrayOf,
  type ExactShape,
  entityId,
  integerValue,
  nullableEntityId,
  nullableString,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { CommitDetailResource, CommitFileResource, CommitResource } from './serialize.js';
import { COMMIT_FILE_STATUSES } from './serialize.js';

/**
 * The `Commit` response shapes (TDS 04 §5.2), in the two forms `serialize.ts` produces.
 *
 * The list/detail split is contractual, not incidental — `files[]` on a list would make the
 * Session Files tab an N+1 walk — so it is two named schemas rather than one with an optional
 * array. A client that receives `Commit` knows it will never carry `files`, which is exactly what
 * an optional field could not tell it.
 */

export const commitSchema = objectSchema('Commit', {
  id: entityId,
  repositoryId: entityId,
  /** Set when the commit was made during a tracked Session (`github/attribution.ts`). */
  sessionId: nullableEntityId,
  sha: stringValue,
  message: stringValue,
  authorName: stringValue,
  authorEmail: nullableString,
  committedAt: timestampValue,
  filesChanged: integerValue,
  additions: integerValue,
  deletions: integerValue,
  createdAt: timestampValue,
});
export type _CommitShape = Assert<ExactShape<CommitResource, typeof commitSchema>>;

export const commitFileSchema = objectSchema('CommitFile', {
  path: stringValue,
  status: stringEnum(COMMIT_FILE_STATUSES),
  additions: integerValue,
  deletions: integerValue,
});
export type _CommitFileShape = Assert<ExactShape<CommitFileResource, typeof commitFileSchema>>;

export const commitDetailSchema = objectSchema('CommitDetail', {
  ...commitSchema.properties,
  files: arrayOf(commitFileSchema),
});
export type _CommitDetailShape = Assert<
  ExactShape<CommitDetailResource, typeof commitDetailSchema>
>;
