import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../lib/media.js';
import { useUiStore } from '../../stores/ui-store.js';
import { useSessionsList } from './queries.js';
import { SessionsTable } from './SessionsTable.js';

/**
 * The Sessions tab of the Project detail view (TDS 06 §5.3.2).
 *
 * > "identical table to §5.4 pre-filtered to the Project (shared component)"
 *
 * It lives in the **Sessions** slice, not the Projects one, because it is a Sessions view: it
 * reads `['sessions','list',{projectId}]`, renders `SessionsTable`, and inherits its row menu,
 * identity rule and state vocabulary for free. `routes/project-detail.tsx` composes it into the
 * Project page, which is where crossing feature boundaries is legitimate (TDS 05 §2.1).
 */

export interface ProjectSessionsPanelProps {
  readonly projectId: string;
}

export function ProjectSessionsPanel({ projectId }: ProjectSessionsPanelProps) {
  const navigate = useNavigate();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);
  const openSession = useUiStore((state) => state.openSession);
  const [showArchived, setShowArchived] = useState(false);

  const query = useSessionsList({ projectId, order: 'desc', limit: 50 });

  const rows = useMemo(() => {
    // §5.4: the default view excludes `archived`. §6.2's filter set takes one state, not a
    // negation, so the exclusion is applied here — the same documented consequence the Sessions
    // list carries, not a second opinion about it.
    const all = query.data ?? [];
    return showArchived ? all : all.filter((session) => session.state !== 'archived');
  }, [query.data, showArchived]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-2xs text-text-secondary uppercase">Sessions</h2>
        <label className="ml-auto flex items-center gap-1 text-2xs text-text-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          Show archived
        </label>
        <button
          type="button"
          onClick={() => void navigate(`/sessions?launch=1&projectId=${projectId}`)}
          className="rounded-sm px-3 font-medium text-sm"
          style={{
            height: 'var(--mc-control-sm)',
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          + New Session
        </button>
      </div>

      {query.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading sessions</span>
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            showArchived
              ? 'No sessions in this project yet.'
              : 'No active sessions in this project.'
          }
          hint={
            showArchived
              ? 'Launch a managed session against one of this project’s repositories, or attach to a Claude Code session you are already running.'
              : 'Archived sessions are hidden — tick “Show archived” to include them.'
          }
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
        <div>
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
  );
}
