import { type AdrStatus, isAdrStatus } from '@mc/shared';
import { ApiError } from '../http/errors.js';

/**
 * ADR field rules, in one place so the route schema and the service cannot disagree.
 *
 * The four template sections (PRD §7.3) are markdown and unbounded in the schema; the cap here
 * is a boundary check, not a product rule — `text` has no limit, but a body big enough to be a
 * denial-of-service is not a decision record.
 */

export const MAX_ADR_TITLE_LENGTH = 300;
export const MAX_ADR_SECTION_LENGTH = 100_000;

export function normalizeAdrTitle(raw: string): string {
  const title = raw.trim();
  if (title.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'title must not be empty', { field: 'title' });
  }
  if (title.length > MAX_ADR_TITLE_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `title must be at most ${MAX_ADR_TITLE_LENGTH} characters`,
      { field: 'title' },
    );
  }
  return title;
}

export function normalizeAdrSection(field: string, raw: string): string {
  if (raw.length > MAX_ADR_SECTION_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${field} must be at most ${MAX_ADR_SECTION_LENGTH} characters`,
      { field },
    );
  }
  // No trim: leading indentation can be meaningful markdown (a fenced block, a list).
  return raw;
}

/**
 * There is no `draft` (TDS 04 §9, arbitration A4). A request that sends one gets told which
 * four values exist rather than a generic schema error, because "draft" is the single most
 * likely thing an integrator will try.
 */
export function normalizeAdrStatus(raw: string): AdrStatus {
  if (!isAdrStatus(raw)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'status must be one of proposed, accepted, rejected, superseded',
      { field: 'status', value: raw },
    );
  }
  return raw;
}
