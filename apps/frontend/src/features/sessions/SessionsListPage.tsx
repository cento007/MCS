import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import type { SessionListFilters } from '../../lib/api/index.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../lib/media.js';
import { useUiStore } from '../../stores/ui-store.js';
import { LaunchSessionModal } from './LaunchSessionModal.js';
import { useProjects, useSessionsList } from './queries.js';
import { SessionsTable } from './SessionsTable.js';

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
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);
  const openSession = useUiStore((state) => state.openSession);

  const [state, setState] = useState<StateFilter>('all');
  const [sessionType, setSessionType] = useState<'all' | 'managed' | 'observed'>('all');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  /**
   * `?launch=1` opens the Launch modal; `?projectId=` scopes the list and seeds that modal.
   *
   * Both the Dashboard's and the Project detail's `+ New Session` need this screen's modal, and
   * the modal belongs to this feature (TDS 05 §2.1: no cross-feature imports). A search param is
   * the same linkable-state mechanism §6.7 already uses for the session right panel, so the
   * hand-off costs one parameter rather than an ownership violation — and it makes a
   * project-scoped Sessions list a URL an operator can keep. Closing clears `launch`, so a
   * reload does not reopen the modal.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const launchOpen = searchParams.get('launch') === '1';
  const projectId = searchParams.get('projectId') ?? '';

  const setParam = (key: string, value: string | null): void => {
    setSearchParams(
      (params) => {
        if (value === null) params.delete(key);
        else params.set(key, value);
        return params;
      },
      { replace: true },
    );
  };

  const setLaunchOpen = (open: boolean): void => setParam('launch', open ? '1' : null);
  const setProjectId = (id: string): void => setParam('projectId', id === '' ? null : id);

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
        ) : (
          <SessionsTable
            sessions={rows}
            mobile={mobile}
            onOpen={(session) => {
              openSession(session.id);
              void navigate(`/sessions/${session.id}`);
            }}
          />
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

      <LaunchSessionModal
        open={launchOpen}
        initialProjectId={projectId === '' ? null : projectId}
        onClose={() => setLaunchOpen(false)}
      />
    </section>
  );
}
