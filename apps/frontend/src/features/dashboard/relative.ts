/**
 * Relative time for dashboard rows (`2m`, `1h`, `3d`) and schedule countdowns (`in 12m`).
 *
 * Pure functions of an injected `now`, never `Date.now()`, for two reasons: they are unit
 * testable without faking the clock, and every caller passes the **frozen** clock from
 * `lib/liveness.ts` — so when the socket dies these values stop advancing along with every
 * other ticking value on the screen (TDS 06 §3.3) instead of quietly counting on.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `now` · `2m` · `4h` · `3d` — the compact past-tense form the §5.2 rows use. */
export function formatRelativePast(timestamp: string | null | undefined, now: number): string {
  const at = parse(timestamp);
  if (at === null) return '—';

  const elapsed = now - at;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/**
 * `in 12m` · `in 3h` · `due now`.
 *
 * A computed `nextRunAt` in the past is **not** an error and is not clamped: TDS 04 §7.7 is
 * explicit that "the endpoint reports the schedule, not the queue", so an overdue run reads
 * `due now` rather than being hidden behind a comfortable future time.
 */
export function formatCountdown(timestamp: string | null | undefined, now: number): string {
  const at = parse(timestamp);
  if (at === null) return '—';

  const remaining = at - now;
  if (remaining <= 0) return 'due now';
  if (remaining < MINUTE) return 'in <1m';
  if (remaining < HOUR) return `in ${Math.floor(remaining / MINUTE)}m`;
  if (remaining < DAY) return `in ${Math.floor(remaining / HOUR)}h`;
  return `in ${Math.floor(remaining / DAY)}d`;
}

function parse(timestamp: string | null | undefined): number | null {
  if (timestamp === null || timestamp === undefined) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}
