import { type Db, normalizeSetting, settingDefault, settingKey } from '@mc/shared';
import { readCategoryValues } from './values.js';

/**
 * `general` settings (TDS 04 §7.2, PRD §4.4.1) — the internal read path.
 *
 *   `general.timezone` -> `('general', 'timezone')`, string, IANA name
 *
 * It is the calendar boundary for the spend read model (§7.8) and for the daily-report
 * schedule row (§7.7). It is explicitly **not** the server's `TZ`, not PostgreSQL's session
 * `TimeZone`, not the browser's zone, and not UTC-by-accident — a Backend running UTC while
 * the operator is in `Europe/Amsterdam` would roll "today" at 01:00 or 02:00 local.
 *
 * The default and the validation rule are the registry's (§7.6): the API and this reader must
 * agree on what an unset timezone means, and they do so by construction rather than by two
 * constants that happen to match today.
 */

/** §7.8: an unset or unparseable zone falls back to UTC and *reports* UTC. */
export const DEFAULT_TIMEZONE = settingDefault<string>('general.timezone');

export const GENERAL_SETTING_KEYS = Object.freeze({
  timezone: settingKey('general.timezone'),
  instanceName: settingKey('general.instanceName'),
} as const);

/**
 * Resolve a stored timezone to a name this process can actually compute with.
 *
 * Validated through `Intl` rather than trusted: an unrecognised name reaches PostgreSQL as
 * `AT TIME ZONE 'Mars/Olympus'` and raises `invalid_parameter_value`, which would turn a bad
 * settings row into a 500 on the Dashboard's most-read endpoint. Pure, so the fallback is unit
 * tested without a database.
 */
export function resolveTimezone(raw: unknown): string {
  return normalizeSetting<string>('general.timezone', raw);
}

/** The instance timezone, or `UTC` when unset/unparseable (§7.8). */
export async function readTimezone(db: Db): Promise<string> {
  const values = await readCategoryValues(db, 'general');
  return resolveTimezone(values.get(GENERAL_SETTING_KEYS.timezone));
}
