import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusDot } from '../../components/StatusDot.js';
import type { Project, Repository } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format/index.js';
import { formatRelativePast } from '../../lib/format/relative.js';
import { useIsLive, useLiveClock } from '../../lib/liveness.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../lib/media.js';
import { CreateProjectModal } from './CreateProjectModal.js';
import {
  PROJECT_SESSION_STATES,
  type ProjectSessionState,
  useAllRepositories,
  useProjectSessionCounts,
  useProjectsList,
} from './queries.js';

/**
 * `/projects` — the Projects list (PRD §8.2, TDS 06 §5.3.1).
 *
 * Columns follow the wireframe: NAME · REPOSITORIES · SESSIONS · updated. Two of those need a
 * note, because both are places where a plausible-looking number would be a lie:
 *
 *  - **The SESSIONS cell uses verbatim F7 state names** (`1 running`, `1 paused`) and never the
 *    word "active" (§5.3.1, F9.5). "Active" reads as `running` to a new operator while actually
 *    spanning `running` + `paused` elsewhere in the product — the one place the ambiguity costs
 *    something is exactly this cell.
 *  - **The last column is `updated`, not "last activity".** The wireframe asks for LAST ACTIVITY
 *    and the API has no such field: `Project.updatedAt` moves when the row is written (a rename,
 *    a workflow-mode change), not when a Session runs. Labelling row-mtime as activity would
 *    claim a measurement that does not exist, so the honest header is the one the data supports.
 */

export function ProjectsListPage() {
  const navigate = useNavigate();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);

  const [searchParams, setSearchParams] = useSearchParams();
  const archived = searchParams.get('archived') === 'true';
  const createOpen = searchParams.get('create') === '1';

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

  const [filter, setFilter] = useState('');

  const query = useProjectsList({ archived, limit: 50 });
  const repositories = useAllRepositories();
  const sessionCounts = useProjectSessionCounts();

  const repositoryCounts = useMemo(
    () => countRepositoriesByProject(repositories.data ?? []),
    [repositories.data],
  );

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter((project) => project.name.toLowerCase().includes(needle));
  }, [query.data, filter]);

  return (
    <section className="px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-medium text-text text-xl">Projects</h1>
        <button
          type="button"
          onClick={() => setParam('create', '1')}
          className="ml-auto rounded-sm px-3 font-medium text-sm"
          style={{
            height: 'var(--mc-control-md)',
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          + Add Project
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Filter projects by name"
          placeholder="Filter by name…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="rounded-sm border bg-transparent px-2 text-2xs text-text"
          style={{ height: 'var(--mc-control-sm)', borderColor: 'var(--color-border-control)' }}
        />

        {/* §4's `?archived=` filter is exclusive — `true` returns *only* archived Projects — so
            this is a two-state segmented control rather than a "Show archived" checkbox, which
            would promise a combined list the API cannot produce. */}
        <fieldset className="flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">Filter by archived state</legend>
          <FilterChip
            label="Active"
            pressed={!archived}
            onClick={() => setParam('archived', null)}
          />
          <FilterChip
            label="Archived"
            pressed={archived}
            onClick={() => setParam('archived', 'true')}
          />
        </fieldset>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <span className="sr-only">Loading projects</span>
            <Skeleton height={36} />
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : query.isError ? (
          <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(archived, filter)}
            {...(emptyHint(archived, filter) === null
              ? {}
              : { hint: emptyHint(archived, filter) as string })}
            {...(archived || filter.trim().length > 0
              ? {}
              : {
                  action: (
                    <button
                      type="button"
                      onClick={() => setParam('create', '1')}
                      className="rounded-sm border border-border-control px-3 text-sm text-text"
                      style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                    >
                      Add Project
                    </button>
                  ),
                })}
          />
        ) : mobile ? (
          <ul className="flex flex-col gap-2">
            {rows.map((project) => (
              <li key={project.id}>
                <MobileCard
                  project={project}
                  repositoryCount={repositoryCounts.get(project.id) ?? 0}
                  counts={sessionCounts.byProject.get(project.id) ?? null}
                  countsUnavailable={sessionCounts.isError}
                  onOpen={() => void navigate(`/projects/${project.id}`)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-2xs text-text-secondary uppercase">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Repositories
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Sessions
                </th>
                <th scope="col" className="py-2 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  repositoryCount={repositoryCounts.get(project.id) ?? 0}
                  repositoriesUnavailable={repositories.isError}
                  counts={sessionCounts.byProject.get(project.id) ?? null}
                  countsUnavailable={sessionCounts.isError}
                  onOpen={() => void navigate(`/projects/${project.id}`)}
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

      <CreateProjectModal
        open={createOpen}
        onClose={() => setParam('create', null)}
        onCreated={(project) => {
          setParam('create', null);
          void navigate(`/projects/${project.id}`);
        }}
      />
    </section>
  );
}

/**
 * Three distinguishable empties, never one (§11.2: "empty ≠ loading ≠ error", and a
 * filtered-to-empty result is a different state from a genuinely empty one).
 */
function emptyTitle(archived: boolean, filter: string): string {
  if (filter.trim().length > 0) return 'No projects match that name.';
  return archived ? 'No archived projects.' : 'No projects yet.';
}

function emptyHint(archived: boolean, filter: string): string | null {
  if (filter.trim().length > 0) return null;
  return archived
    ? 'Archiving a project keeps its sessions and repositories; it only takes the project out of the active list.'
    : 'Projects group repositories, sessions and knowledge. Create one to register a repository against it.';
}

function FilterChip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="rounded-xs border px-2 text-2xs"
      style={{
        minHeight: 24,
        borderColor: pressed ? 'var(--color-accent)' : 'var(--color-border)',
        color: pressed ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        backgroundColor: pressed ? 'var(--color-selected)' : 'transparent',
      }}
    >
      {label}
    </button>
  );
}

function ProjectRow({
  project,
  repositoryCount,
  repositoriesUnavailable,
  counts,
  countsUnavailable,
  onOpen,
}: {
  project: Project;
  repositoryCount: number;
  repositoriesUnavailable: boolean;
  counts: ReadonlyMap<ProjectSessionState, number> | null;
  countsUnavailable: boolean;
  onOpen: () => void;
}) {
  const clock = useLiveClock();

  return (
    <tr className="border-border border-t align-top" style={{ height: 'var(--mc-row-dense)' }}>
      <td className="py-2 pr-3">
        <button
          type="button"
          onClick={onOpen}
          className="block text-left"
          style={{ minHeight: 24 }}
        >
          <span className="block truncate text-sm text-text">{project.name}</span>
          {project.description === null || project.description.length === 0 ? null : (
            <span className="block max-w-md truncate text-2xs text-text-muted">
              {project.description}
            </span>
          )}
        </button>
      </td>
      <td className="py-2 pr-3 text-text-secondary text-xs">
        {repositoriesUnavailable ? (
          <span className="text-text-muted" title="The repositories list could not be read.">
            —
          </span>
        ) : (
          repositoryCount
        )}
      </td>
      <td className="py-2 pr-3">
        <SessionCountsCell counts={counts} unavailable={countsUnavailable} />
      </td>
      <td className="py-2 text-text-secondary text-xs" title={formatDateTime(project.updatedAt)}>
        {formatRelativePast(project.updatedAt, clock.now)}
      </td>
    </tr>
  );
}

function MobileCard({
  project,
  repositoryCount,
  counts,
  countsUnavailable,
  onOpen,
}: {
  project: Project;
  repositoryCount: number;
  counts: ReadonlyMap<ProjectSessionState, number> | null;
  countsUnavailable: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-border p-3 text-left"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span className="block truncate text-sm text-text">{project.name}</span>
      <span className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <span>
          {repositoryCount} repositor{repositoryCount === 1 ? 'y' : 'ies'}
        </span>
        <SessionCountsCell counts={counts} unavailable={countsUnavailable} />
      </span>
    </button>
  );
}

/**
 * `▶ 2 running · ‖ 1 paused` — the highest-priority two states, in the `running → paused →
 * failed` order §5.3.1 fixes. A Project with none renders an em dash, never `0 running`: a zero
 * beside a state name reads as a measured absence of that state, and the row has nothing to say.
 */
export function SessionCountsCell({
  counts,
  unavailable,
}: {
  counts: ReadonlyMap<ProjectSessionState, number> | null;
  unavailable: boolean;
}) {
  const isLive = useIsLive();

  if (unavailable) {
    return (
      <span className="text-2xs text-text-muted" title="Session counts could not be read.">
        unknown
      </span>
    );
  }

  const present = PROJECT_SESSION_STATES.filter((state) => (counts?.get(state) ?? 0) > 0).slice(
    0,
    2,
  );

  if (present.length === 0) return <span className="text-text-muted text-xs">—</span>;

  return (
    <span className="flex flex-wrap items-center gap-2">
      {present.map((state) => (
        <span key={state} className="flex items-center gap-1 text-text-secondary text-xs">
          {/* The dot carries its glyph and the verbatim F7 name in `aria-label` (§2.1.6); the
              count text beside it is not a state label, so the glyph is mandatory here. */}
          <StatusDot state={state} muted={!isLive} />
          {counts?.get(state) ?? 0} {state}
        </span>
      ))}
    </span>
  );
}

function countRepositoriesByProject(
  repositories: readonly Repository[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const repository of repositories) {
    if (repository.projectId === null) continue;
    counts.set(repository.projectId, (counts.get(repository.projectId) ?? 0) + 1);
  }
  return counts;
}
