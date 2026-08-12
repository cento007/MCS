/**
 * The §7.7 derivation rules, pure — so the honest-when-unconfigured behaviour is unit tested
 * with no database and no clock.
 *
 * `enabled: false` ⇒ `nextRunAt: null`. The row is still returned so the UI can say *why*
 * nothing is scheduled and link to Settings, rather than rendering an empty widget that looks
 * like a loading state.
 */

export interface IntervalScheduleInput {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly lastRunAt: Date | null;
  readonly now: Date;
}

/**
 * `lastRunAt + interval`, or `now + interval` when there is no prior run (§7.7 table).
 *
 * A result in the past is **not clamped**: it means the run is due or overdue, and the
 * endpoint reports the schedule, not the queue. Clamping would hide a stalled worker behind a
 * comfortable future time.
 */
export function nextIntervalRunAt(input: IntervalScheduleInput): Date | null {
  if (!input.enabled || input.intervalMinutes <= 0) return null;
  const base = input.lastRunAt ?? input.now;
  return new Date(base.getTime() + input.intervalMinutes * 60_000);
}
