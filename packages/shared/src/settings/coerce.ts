/**
 * Coercion helpers for stored settings values (TDS 03 §3.12, TDS 04 §7.6).
 *
 * **A stored row is untrusted input.** `settings.value` is `jsonb` with only the
 * `value_type` CHECK behind it: nothing stops an operator, a restore, or a future bug from
 * putting a string where a number belongs. Every helper here therefore *degrades to a stated
 * default* instead of throwing — a corrupt row must not be able to 500 a read model the
 * Dashboard polls, and it must not be able to make the Settings page unopenable either.
 *
 * They live in `@mc/shared` rather than in the Backend because the registry beside this file
 * uses them to define each key's `normalize`, and the registry is the single source both the
 * Backend's routes and its internal readers consume (§7.6).
 */

export function stringValue(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/** A finite number, floored to an integer, clamped to `[min, max]`; anything else is `fallback`. */
export function integerValue(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer < bounds.min || integer > bounds.max) return fallback;
  return integer;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A JSONB object row read whole (§7.6 rule 1). Arrays and scalars are not objects. */
export function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** One member of a closed value set, or the documented default. */
export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** `"HH:mm"` on a 24-hour clock (TDS 04 §7.2 `dailyReport.time`, `quietHours`). */
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && HH_MM.test(value);
}

export function timeOfDayValue(value: unknown, fallback: string): string {
  return isTimeOfDay(value) ? value : fallback;
}

/**
 * A non-negative money amount, or `null`.
 *
 * `null` is a real value here and means "no budget configured" (TDS 04 §7.8), which is a
 * different statement from `0`; a negative or non-finite stored value is corrupt and reads as
 * "unset" rather than as a budget nobody can satisfy.
 */
export function moneyValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export interface StringListBounds {
  readonly maxItems: number;
  readonly maxLength: number;
}

/**
 * A stored `array` row as a clean list of non-empty strings.
 *
 * Entries are trimmed, blanks dropped, duplicates collapsed (first occurrence wins, so the
 * *order* of `discoveryRoots` — which is meaningful — survives), and the list is capped. The
 * cap is not a contract number: it stops a corrupt or hostile row turning an allowlist lookup
 * or a discovery scan into an unbounded set.
 */
export function stringListValue(value: unknown, bounds: StringListBounds): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > bounds.maxLength) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    list.push(trimmed);
    if (list.length === bounds.maxItems) break;
  }
  return list;
}

/**
 * Is this a timezone name this process — and therefore PostgreSQL's `AT TIME ZONE` — can
 * actually compute with?
 *
 * Validated through `Intl` rather than trusted: an unrecognised name reaches PostgreSQL as
 * `AT TIME ZONE 'Mars/Olympus'` and raises `invalid_parameter_value`, which would turn one bad
 * settings row into a 500 on the Dashboard's most-read endpoint.
 */
export const MAX_TIMEZONE_LENGTH = 64;

export function isKnownTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TIMEZONE_LENGTH) {
    return false;
  }
  try {
    // Throws RangeError for a zone ICU does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
