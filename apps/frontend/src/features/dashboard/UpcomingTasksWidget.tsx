import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import type { ScheduleEntry } from '../../lib/api/index.js';
import { formatClock, formatDateTime } from '../../lib/format/index.js';
import { formatCountdown, formatRelativePast } from '../../lib/format/relative.js';
import { type LiveClock, useLiveClock } from '../../lib/liveness.js';
import { useSchedule } from './queries.js';
import { Widget } from './Widget.js';

/**
 * Upcoming Tasks (TDS 06 §5.2) — **a schedule read model, not a to-do list**.
 *
 * WS7 arbitration A1 settled this: the PRD names the widget, but **no Task entity exists in
 * F4.1, none is stored, none is exposed by any API and none is planned**. What renders here is
 * `GET /schedule` (TDS 04 §7.7) — next Obsidian sync, next repository poll, next daily report
 * — derived at read time from Settings plus last-run records, with no persistence, no event
 * and no entity behind it. The subtitle says so out loud, because the guardrail on record is
 * that nobody should later mistake this for a place to add user tasks.
 *
 * **Disabled rows are shown, not hidden.** The API returns them with `nextRunAt: null` on
 * purpose, "so the UI can say *why* nothing is scheduled and link to Settings, rather than
 * rendering an empty widget that looks like a loading state".
 */
export function UpcomingTasksWidget() {
  const query = useSchedule();
  const clock = useLiveClock();

  const rows = [...(query.data ?? [])].sort(compareSchedule);

  return (
    <Widget
      title="Upcoming tasks"
      subtitle="System-scheduled runs — set in Settings, not a to-do list"
      to="/settings/integrations"
      toLabel="Open integration settings"
    >
      {query.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading schedule</span>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          title="No scheduled work"
          hint="Set sync intervals in Settings."
          action={
            <Link
              to="/settings/integrations"
              className="rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ minHeight: 24 }}
            >
              Open Settings
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((entry) => (
            <li key={entry.kind}>
              <ScheduleRow entry={entry} clock={clock} />
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

/** Soonest first; rows with no next run sink to the bottom without disappearing. */
function compareSchedule(a: ScheduleEntry, b: ScheduleEntry): number {
  const left = a.nextRunAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.nextRunAt);
  const right = b.nextRunAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.nextRunAt);
  return left - right;
}

function ScheduleRow({ entry, clock }: { entry: ScheduleEntry; clock: LiveClock }) {
  const scheduled = entry.nextRunAt !== null;

  return (
    <div className="flex min-w-0 items-baseline gap-2" data-testid={`schedule-${entry.kind}`}>
      <span
        className={`shrink-0 font-mono text-2xs ${scheduled ? 'text-text' : 'text-text-muted'}`}
        title={entry.nextRunAt === null ? undefined : formatDateTime(entry.nextRunAt)}
      >
        {scheduled ? formatWhen(entry.nextRunAt as string, clock.now) : '—'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-text-secondary text-xs">{entry.label}</span>
        <span className="block truncate text-2xs text-text-muted">
          {scheduled ? (
            // A ticking value, so it rides the frozen clock (§3.3) and stops advancing with
            // everything else when the socket drops.
            <>
              {clock.frozen ? '~' : ''}
              {formatCountdown(entry.nextRunAt, clock.now)}
            </>
          ) : (
            // Honest, and actionable: the row stays, and it says where to turn it on.
            <>
              Not scheduled —{' '}
              <Link to="/settings/integrations" className="rounded-xs underline decoration-dotted">
                enable in Settings
              </Link>
            </>
          )}
          {` · ${lastRunLabel(entry, clock.now)}`}
        </span>
      </span>
    </div>
  );
}

function lastRunLabel(entry: ScheduleEntry, now: number): string {
  if (entry.lastRunAt === null) return 'never run';
  const elapsed = formatRelativePast(entry.lastRunAt, now);
  return elapsed === 'now' ? 'last run just now' : `last run ${elapsed} ago`;
}

/** `18:30` for a run inside the next day, the full local date-time beyond it. */
function formatWhen(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  return at - now < 24 * 60 * 60 * 1000 ? formatClock(iso) : formatDateTime(iso);
}
