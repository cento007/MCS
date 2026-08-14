import {
  type Assert,
  type Covers,
  type ExactShape,
  enumSchema,
  integerValue,
  nullable,
  nullableString,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../../http/response-schema.js';
import type { RelatedGapReason } from './package.js';
import { EXPORT_FORMATS, type SessionExportDocument } from './render.js';
import type { ContextPackageResult } from './service.js';

/**
 * `POST /sessions/{id}/export` and `/context-package` (TDS 04 §6.7).
 *
 * Both answer with the data envelope rather than a file download, and `routes.ts` gives the full
 * argument: a `Content-Disposition` response is outside the SPA's single error path, so a `409`
 * for an unstarted Session would arrive as a file called `export.md` containing an error object.
 */

export const sessionExportSchema = objectSchema('SessionExport', {
  format: stringEnum(EXPORT_FORMATS),
  /** The server's suggested name — deterministic in the Session, so a re-export replaces it. */
  filename: stringValue,
  content: stringValue,
});
export type _SessionExportShape = Assert<
  ExactShape<SessionExportDocument, typeof sessionExportSchema>
>;

const RELATED_GAP_REASONS = [
  'not_configured',
  'unavailable',
  'stamp_mismatch',
  'index_empty',
  'below_threshold',
  'timed_out',
  'no_query',
  'only_own_session',
] as const;
export type _RelatedGapReasonsCover = Assert<Covers<RelatedGapReason, typeof RELATED_GAP_REASONS>>;

export const contextPackageSchema = objectSchema('ContextPackage', {
  content: stringValue,
  /** §6.7's field. An estimate, and `text.ts` says exactly what kind — `bytes` is the fact. */
  tokenEstimate: integerValue,
  bytes: integerValue,
  generatedAt: timestampValue,
  /**
   * Additive to §6.7, and the reason it is here: without it a client cannot tell whether the
   * package it just received is whole, and would have to regex Markdown for a warning callout.
   */
  relatedContext: objectSchema('ContextPackageRelated', {
    resultCount: integerValue,
    gapReason: nullable(enumSchema('ContextPackageGapReason', RELATED_GAP_REASONS)),
    gapDetail: nullableString,
    embeddingModel: nullableString,
  }),
});
export type _ContextPackageShape = Assert<
  ExactShape<ContextPackageResult, typeof contextPackageSchema>
>;
