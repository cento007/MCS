import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import type { Session, SessionListFilters } from '../../lib/api/index.js';
import {
  formatCostUsd,
  formatDuration,
  sessionIdTail,
  sessionLabel,
} from '../../lib/format/index.js';
import { useIsLive } from '../../lib/liveness.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../lib/media.js';
import { useUiStore } from '../../stores/ui-store.js';
import { allSessionActions, type SessionActionDescriptor } from './actions.js';
import { LaunchSessionModal } from './LaunchSessionModal.js';
import { useSessionActionMutation } from './mutations.js';
import { useProjects, useSessionsList } from './queries.js';

/**
 * `/sessions` — the Sessions list (TDS 06 §5.4).
 *
 * The column order encodes §9.3's identity rule and is not negotiable: **title leads**, with
 * `project · branch` beneath it, and the ID demoted to a compact column showing the **last six
 * hex characters**. A UUIDv7 prefix column made every row of a busy list look identical,
 * because those leading characters are the millisecond the Session started — the least
 * discriminating substring the identifier has.
 */

const STATE_FILTERS = ['all', 'created', 'running', 'paused', 'completed', 'failed'] as const;

type StateFilter = (typeof STATE_FILTERS)[number];

export function SessionsListPage() {
  const navigate = useNavigate();
  const isLive = useIsLive();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);
  const openSession = useUiStore((state) => state.openSession);

  const [state, setState] = useState<StateFilter>('all');
  const [sessionType, setSessionType] = useState<'all' | 'managed' | 'observed'>('all');
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);

  const filters: SessionListFilters = useMemo(
    () => ({
      ...(state === 'all' ? {} : { state }),
      ...(sessionType === 'all' ? {} : { sessionType }),
      ...(projectId === '' ? {} : { projectId }),
      order: 'desc',
      limit: 50,
    }),
    [state, sessionType, projectId],
  );

  const query = useSessionsList(filters);
  // The Project filter is only offered when the Projects API answers. A permanently empty
  // dropdown would read as "no projects exist", which is a claim this client cannot make.
  const projects = useProjects(true);

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter((session) => {
      // §5.4: the default view excludes `archived`. The API filter set (§6.2) takes one
      // state, not a negation, so the exclusion is applied here — a documented consequence of
      // the F5.3 filter vocabulary, not an oversight.
      if (!showArchived && session.state === 'archived') return false;
      if (needle.length === 0) return true;
      return `${session.title} ${session.branch ?? ''} ${session.id.slice(-6)}`
        .toLowerCase()
        .includes(needle);
    });
  }, [query.data, search, showArchived]);

  return (
    <section className="px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-medium text-text text-xl">Sessions</h1>
        {/* §9.2 / arbitration A12: no New Session entry point on mobile. Composing a launch
            target requires the working-tree disclosure, which cannot be honestly reviewed on
            a phone; mobile launches by Resume-as-new or Clone from a vetted Session. */}
        {mobile ? null : (
          <button
            type="button"
            onClick={() => setLaunchOpen(true)}
            className="ml-auto rounded-sm px-3 font-medium text-sm"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            + New Session
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <fieldset className="flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">Filter by state</legend>
          {STATE_FILTERS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={state === candidate}
              onClick={() => setState(candidate)}
              className="rounded-xs border px-2 text-2xs"
              style={{
                minHeight: 24,
                borderColor: state === candidate ? 'var(--color-accent)' : 'var(--color-border)',
                color: state === candidate ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                backgroundColor: state === candidate ? 'var(--color-selected)' : 'transparent',
              }}
            >
              {candidate === 'all' ? 'All' : candidate}
            </button>
          ))}
        </fieldset>

        <select
          aria-label="Filter by type"
          value={sessionType}
          onChange={(event) => setSessionType(event.target.value as 'all' | 'managed' | 'observed')}
          className="rounded-sm border bg-transparent px-2 text-2xs text-text"
          style={{ height: 'var(--mc-control-sm)', borderColor: 'var(--color-border-control)' }}
        >
          <option value="all">All types</option>
          <option value="managed">managed</option>
          <option value="observed">observed</option>
        </select>

        {projects.isSuccess ? (
          <select
            aria-label="Filter by project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="rounded-sm border bg-transparent px-2 text-2xs text-text"
            style={{ height: 'var(--mc-control-sm)', borderColor: 'var(--color-border-control)' }}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}

        <input
          type="search"
          aria-label="Search sessions"
          placeholder="Search…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="rounded-sm border bg-transparent px-2 text-2xs text-text"
          style={{ height: 'var(--mc-control-sm)', borderColor: 'var(--color-border-control)' }}
        />

        <label className="flex items-center gap-1 text-2xs text-text-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          Show archived
        </label>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton height={36} />
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : query.isError ? (
          <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              search.trim().length > 0 || state !== 'all'
                ? 'No sessions match these filters.'
                : 'No sessions yet.'
            }
            hint="Launch a managed session or attach to a running Claude Code session."
          />
        ) : mobile ? (
          <ul className="flex flex-col gap-2">
            {rows.map((session) => (
              <li key={session.id}>
                <MobileCard
                  session={session}
                  muted={!isLive}
                  onOpen={() => {
                    openSession(session.id);
                    void navigate(`/sessions/${session.id}`);
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-2xs text-text-secondary uppercase">
                <th scope="col" className="py-2 pr-3 font-medium">
                  State
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Session
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Type
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Duration
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  ID
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Cost
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  muted={!isLive}
                  onOpen={() => {
                    openSession(session.id);
                    void navigate(`/sessions/${session.id}`);
                  }}
                />
              ))}
            </tbody>
          </table>
        )}

        {query.hasNextPage ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ height: 'var(--mc-control-md)' }}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </div>

      <LaunchSessionModal open={launchOpen} onClose={() => setLaunchOpen(false)} />
    </section>
  );
}

function SessionRow({
  session,
  muted,
  onOpen,
}: {
  session: Session;
  muted: boolean;
  onOpen: () => void;
}) {
  return (
    <tr className="border-border border-t align-top" style={{ height: 'var(--mc-row-dense)' }}>
      <td className="py-2 pr-3">
        <StatusBadge state={session.state} muted={muted} />
      </td>
      <td className="py-2 pr-3">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-md text-left"
          style={{ minHeight: 24 }}
        >
          <span className="block truncate text-sm text-text" title={session.title}>
            {sessionLabel({ id: session.id, title: session.title })}
          </span>
          <span className="block truncate text-2xs text-text-muted">
            <span className="font-mono">{session.branch ?? 'no branch'}</span>
          </span>
        </button>
      </td>
      <td className="py-2 pr-3 text-text-secondary text-xs">{session.sessionType}</td>
      <td className="py-2 pr-3 font-mono text-text-secondary text-xs">
        {formatDuration(session.durationSeconds)}
      </td>
      <td className="py-2 pr-3">
        {/* Last six hex characters — the random tail. Title carries the full UUID; clicking
            copies it, per §5.4. */}
        <button
          type="button"
          title={session.id}
          onClick={() => void navigator.clipboard?.writeText(session.id)}
          className="rounded-xs font-mono text-2xs text-text-muted"
          style={{ minHeight: 24 }}
        >
          {sessionIdTail(session.id)}
        </button>
      </td>
      <td className="py-2 pr-3 font-mono text-text-secondary text-xs">
        {session.sessionType === 'observed' && session.costUsd === null
          ? '—'
          : formatCostUsd(session.costUsd)}
      </td>
      <td className="py-2">
        <RowMenu session={session} />
      </td>
    </tr>
  );
}

function MobileCard({
  session,
  muted,
  onOpen,
}: {
  session: Session;
  muted: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-border p-3 text-left"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span className="flex items-center gap-2">
        <StatusBadge state={session.state} muted={muted} />
        <span className="min-w-0 flex-1 truncate text-sm text-text">
          {sessionLabel({ id: session.id, title: session.title })}
        </span>
      </span>
      <span className="mt-1 block truncate text-2xs text-text-muted">
        <span className="font-mono">{session.branch ?? 'no branch'}</span> ·{' '}
        <span className="font-mono">{formatDuration(session.durationSeconds)}</span> ·{' '}
        <span className="font-mono">{formatCostUsd(session.costUsd)}</span>
      </span>
    </button>
  );
}

/**
 * The row overflow menu. It offers **only state-legal actions**, derived from the same
 * predicate as the header and the palette (§6.6), so an illegal transition is never presented
 * anywhere — the API would reject it with `INVALID_STATE_TRANSITION` regardless.
 */
function RowMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<SessionActionDescriptor | null>(null);
  const mutation = useSessionActionMutation(session.id);
  const navigate = useNavigate();

  // `turnInFlight` is false here on purpose: a list row has no live buffer, so `[Stop]` is
  // not one of its options — `[Pause]` is the process-level control this surface can offer.
  const actions = allSessionActions(session, false).filter((action) => action.id !== 'stop');

  const run = (action: SessionActionDescriptor): void => {
    void mutation.mutateAsync({ action: action.id }).then((outcome) => {
      if (outcome.session.id !== session.id) void navigate(`/sessions/${outcome.session.id}`);
    });
  };

  if (actions.length === 0) return null;

  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${sessionLabel({ id: session.id, title: session.title })}`}
        onClick={() => setOpen((value) => !value)}
        className="rounded-xs px-2 text-text-muted"
        style={{ minWidth: 24, minHeight: 24 }}
      >
        ⋯
      </button>
      {open ? (
        <span
          role="menu"
          className="absolute right-0 z-20 mt-1 flex min-w-48 flex-col rounded-md border border-border p-1"
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            boxShadow: 'var(--shadow-overlay)',
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                if (action.confirm === undefined) run(action);
                else setConfirming(action);
              }}
              className="rounded-xs px-3 py-2 text-left text-sm text-text"
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.confirm?.title ?? ''}
        body={confirming?.confirm?.body ?? ''}
        confirmLabel={confirming?.confirm?.confirmLabel ?? 'Confirm'}
        destructive={confirming?.confirm?.destructive ?? false}
        pending={mutation.isPending}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action !== null) run(action);
        }}
        onCancel={() => setConfirming(null)}
      />
    </span>
  );
}
