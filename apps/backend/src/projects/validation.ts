import { ApiError } from '../http/errors.js';

/**
 * The pure half of Project validation — no database, no Fastify, so the rules are unit-tested
 * at the tier that runs on every change (TDS 07 §1).
 *
 * Route schemas (`routes.ts`) already reject the wrong *shape*; these functions own the
 * normalisations that have to hold at the storage boundary as well: `ck_projects_name_length`
 * counts characters *after* trimming, and `ux_projects_workspace_name` compares them
 * case-insensitively, so a name has to be trimmed before either can be reasoned about.
 */

export const MAX_PROJECT_NAME_LENGTH = 200;

/** Trim, then enforce `ck_projects_name_length` (TDS 03 §3.5). */
export function normalizeProjectName(name: string): string {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'name must not be empty', { field: 'name' });
  }
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`,
      { field: 'name' },
    );
  }

  return trimmed;
}

/** Empty and whitespace-only descriptions normalise to `null`, so "absent" has one form. */
export function normalizeDescription(description: string | null | undefined): string | null {
  if (description === null || description === undefined) return null;
  const trimmed = description.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `archivedAt` on a PATCH: an ISO 8601 instant to archive at, or `null` to un-archive.
 *
 * The contract (TDS 04 §4) makes this a timestamp field rather than an `/archive` sub-action,
 * so the caller's value is honoured verbatim instead of being replaced with `now()` — but it
 * still has to *be* a timestamp, and `new Date('nonsense')` is an `Invalid Date` that would
 * otherwise reach PostgreSQL as a null-ish write.
 */
export function parseArchivedAt(value: string | null): Date | null {
  if (value === null) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', 'archivedAt must be an ISO 8601 timestamp', {
      field: 'archivedAt',
    });
  }
  return parsed;
}
