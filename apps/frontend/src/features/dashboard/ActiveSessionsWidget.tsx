import { useNavigate } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusDot } from '../../components/StatusDot.js';
import type { Session } from '../../lib/api/index.js';
import { formatCostUsd, sessionLabel } from '../../lib/format/index.js';
import { useDurationLabel, useIsLive, useLastUpdatedLabel } from '../../lib/liveness.js';
import { useUiStore } from '../../stores/ui-store.js';
import { secondaryLine } from './attention.js';
import {
  MAX_ACTIVE_SESSION_ROWS,
  projectNames,
  useActiveProjects,
  useActiveSessions,
} from './queries.js';
import { Widget } from './Widget.js';

/**
 * Active Sessions (TDS 06 §5.2).
 *
 * "Shows only `running` + `paused` (that is what 'active' means here), newest first, max 6."
 *
 * Identity follows §9.3 without exception: **the row label is the Session title** and the
 * second line is `project · branch`. No ID appears in this widget at all — a UUIDv7 prefix
 * encodes the millisecond the Session started, so on a dashboard showing six Sessions from
 * the same afternoon it is the least discriminating string available.
 *
 * Durations tick client-side and **freeze with a `~` prefix** when the connection chip is not
 * `live` (§3.3), via the shared `useDurationLabel` — the rule is implemented once in
 * `lib/liveness.ts`, never per widget.
 */
export function ActiveSessionsWidget() {
  const isLive = useIsLive();
  const lastUpdated = useLastUpdatedLabel();
  const { sessions, isPending, isError, error, refetch } = useActiveSessions();
  const projects = useActiveProjects();

  const rows = sessions.slice(0, MAX_ACTIVE_SESSION_ROWS);
  const names = projectNames(projects.data);

  return (
    <Widget
      title="Active sessions"
      to="/sessions"
      toLabel="View all sessions"
      note={lastUpdated}
      className="lg:col-span-2"
    >
      {isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading active sessions</span>
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : isError ? (
        <ErrorPanel error={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          title="No active sessions"
          hint="Nothing is running or paused right now."
        />
      ) : (
        <ul aria-live="polite" className="flex flex-col">
          {rows.map((session) => (
            <li key={session.id} className="border-border border-t first:border-t-0">
              <ActiveSessionRow
                session={session}
                project={secondaryLine(session, names)}
                muted={!isLive}
              />
            </li>
          ))}
        </ul>
      )}

      {sessions.length > MAX_ACTIVE_SESSION_ROWS ? (
        <p className="mt-2 text-2xs text-text-muted">
          {sessions.length - MAX_ACTIVE_SESSION_ROWS} more active — use View all
        </p>
      ) : null}
    </Widget>
  );
}

function ActiveSessionRow({
  session,
  project,
  muted,
}: {
  session: Session;
  project: string | null;
  muted: boolean;
}) {
  const navigate = useNavigate();
  const openSession = useUiStore((state) => state.openSession);
  const duration = useDurationLabel(session.startedAt, session.completedAt);

  const open = (): void => {
    // Opening from the Dashboard adds the Session to the operator's open set, exactly as the
    // list does — one source of truth for both switcher surfaces (§6.5).
    openSession(session.id);
    void navigate(`/sessions/${session.id}`);
  };

  return (
    <div className="flex min-w-0 items-center gap-2 py-2">
      <StatusDot state={session.state} muted={muted} />

      <button
        type="button"
        onClick={open}
        className="min-w-0 flex-1 text-left"
        style={{ minHeight: 24 }}
      >
        <span className={`block truncate text-sm ${muted ? 'text-text-muted' : 'text-text'}`}>
          {sessionLabel({ id: session.id, title: session.title })}
        </span>
        <span className="block truncate text-2xs text-text-muted">
          {project === null ? 'no project · no branch' : project}
        </span>
        <span className="block truncate text-2xs text-text-muted">
          {session.state} · <span className="font-mono">{duration}</span> ·{' '}
          <span className="font-mono">
            {session.sessionType === 'observed' && session.costUsd === null
              ? '—'
              : formatCostUsd(session.costUsd)}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={open}
        aria-label={`Open ${sessionLabel({ id: session.id, title: session.title })}`}
        className="shrink-0 rounded-sm border border-border-control px-2 text-2xs text-text"
        style={{ height: 24 }}
      >
        Open
      </button>
    </div>
  );
}
