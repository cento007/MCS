import { useParams } from 'react-router';
import { PagePlaceholder } from '../components/PagePlaceholder.js';
import { sessionIdTail } from '../lib/format/index.js';

/** `/projects/:projectId` — tabs: Repositories, Sessions; Agents/Memory are Phase 4/3. */
export function Component() {
  const { projectId = '' } = useParams();
  return (
    <PagePlaceholder
      title="Project"
      summary={`Repositories and Sessions tabs for project ${sessionIdTail(projectId)}. Agents and Memory tabs render the phase placeholder.`}
      owner="TDS 06 §5.3.2"
    />
  );
}
