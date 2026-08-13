import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusDot } from '../../components/StatusDot.js';
import type { Project, Session } from '../../lib/api/index.js';
import { useIsLive } from '../../lib/liveness.js';
import { useActiveProjects, useActiveSessions } from './queries.js';
import { Widget } from './Widget.js';

/**
 * Active Projects (TDS 06 §5.2) — the count, then the projects themselves with the state of
 * whatever is running inside them.
 *
 * The per-project dot is derived from the Active Sessions data this page already holds rather
 * than from a second endpoint: `running` wins over `paused`, and a project with neither shows
 * no dot at all. Inventing a "project state" would be inventing vocabulary — F7 states belong
 * to Sessions (F4.1/F7), and this is a projection of them, not a new one.
 */
const MAX_PROJECT_ROWS = 5;

export function ActiveProjectsWidget() {
  const projects = useActiveProjects();
  const active = useActiveSessions();
  const isLive = useIsLive();

  const rows = [...(projects.data ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PROJECT_ROWS);

  return (
    <Widget
      title="Active projects"
      count={projects.data?.length}
      to="/projects"
      toLabel="View all projects"
    >
      {projects.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading projects</span>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : projects.isError ? (
        <ErrorPanel error={projects.error} onRetry={() => void projects.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          title="No projects yet"
          action={
            <Link
              to="/projects"
              className="rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ minHeight: 24 }}
            >
              Add project
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-05">
          {rows.map((project) => (
            <li key={project.id}>
              <ProjectRow project={project} sessions={active.sessions} muted={!isLive} />
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

function ProjectRow({
  project,
  sessions,
  muted,
}: {
  project: Project;
  sessions: readonly Session[];
  muted: boolean;
}) {
  const inProject = sessions.filter((session) => session.projectId === project.id);
  const running = inProject.some((session) => session.state === 'running');
  const paused = inProject.some((session) => session.state === 'paused');

  return (
    <Link
      to={`/projects/${project.id}`}
      className="flex min-w-0 items-center gap-2 rounded-xs py-1 text-sm text-text"
      style={{ minHeight: 24 }}
    >
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {running ? (
        <StatusDot state="running" muted={muted} />
      ) : paused ? (
        <StatusDot state="paused" muted={muted} />
      ) : null}
    </Link>
  );
}
