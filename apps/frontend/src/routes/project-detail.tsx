import { useParams } from 'react-router';
import { ProjectDetailPage } from '../features/projects/ProjectDetailPage.js';
import { ProjectSessionsPanel } from '../features/sessions/ProjectSessionsPanel.js';

/**
 * `/projects/:projectId` — tabs: Repositories, Sessions; Agents/Memory are Phase 4/3.
 *
 * **This route is the composition point for two feature slices, deliberately.** The Sessions
 * tab is specified as the §5.4 table pre-filtered to the Project (TDS 06 §5.3.2, "shared
 * component"), and that view belongs to the Sessions slice — TDS 05 §2.1 forbids the Projects
 * slice from importing it. A route module is the one layer entitled to import both, so the
 * Project page takes the Sessions tab as a slot instead of reaching across the boundary.
 *
 * Keyed on `projectId` so switching Projects remounts the page rather than leaving the previous
 * Project's tab state and repository rows on screen during the refetch.
 */
export function Component() {
  const { projectId = '' } = useParams();

  return (
    <ProjectDetailPage
      key={projectId}
      projectId={projectId}
      sessionsTab={<ProjectSessionsPanel projectId={projectId} />}
    />
  );
}
