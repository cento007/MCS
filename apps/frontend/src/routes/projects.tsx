import { PagePlaceholder } from '../components/PagePlaceholder.js';

/** `/projects` — Projects list (PRD §8.2, TDS 06 §5.3.1). */
export function Component() {
  return (
    <PagePlaceholder
      title="Projects"
      summary="Project list with repository counts, active session counts and workflow mode."
      owner="TDS 06 §5.3.1"
    />
  );
}
