import type { Db } from '@mc/shared';
import { readCategoryValues, stringValue } from './values.js';

/**
 * `general` settings (TDS 04 §7.2, PRD §4.4.1). Phase 1 needs exactly one field of this
 * category, and it is the most consequential one in the product:
 *
 *   `general.timezone` -> `('general', 'timezone')`, string, IANA name
 *
 * It is the calendar boundary for the spend read model (§7.8) and for the daily-report
 * schedule row (§7.7). It is explicitly **not** the server's `TZ`, not PostgreSQL's session
 * `TimeZone`, not the browser's zone, and not UTC-by-accident — a Backend running UTC while
 * the operator is in `Europe/Amsterdam` would roll "today" at 01:00 or 02:00 local.
 */

/** §7.8: an unset or unparseable zone falls back to UTC and *reports* UTC. */
export const DEFAULT_TIMEZONE = 'UTC';

export const GENERAL_SETTING_KEYS = Object.freeze({
  timezone: 'timezone',
  instanceName: 'instance_name',
} as const);

/** An IANA name is at most a few dozen characters; anything longer is not one. */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * Resolve a stored timezone to a name this process can actually compute with.
 *
 * Validated through `Intl` rather than trusted: an unrecognised name reaches PostgreSQL as
 * `AT TIME ZONE 'Mars/Olympus'` and raises `invalid_parameter_value`, which would turn a bad
 * settings row into a 500 on the Dashboard's most-read endpoint. Pure, so the fallback is unit
 * tested without a database.
 */
export function resolveTimezone(raw: unknown): string {
  const name = stringValue(raw);
  if (name === null || name.length > MAX_TIMEZONE_LENGTH) return DEFAULT_TIMEZONE;

  try {
    // Throws RangeError for a zone ICU does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format(0);
    return name;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** The instance timezone, or `UTC` when unset/unparseable (§7.8). */
export async function readTimezone(db: Db): Promise<string> {
  const values = await readCategoryValues(db, 'general');
  return resolveTimezone(values.get(GENERAL_SETTING_KEYS.timezone));
}
