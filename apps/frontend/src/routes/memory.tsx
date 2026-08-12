import { PhasePlaceholder } from '../components/PhasePlaceholder.js';

/**
 * `/memory` — Phase 3 placeholder route (TDS 05 §10, TDS 06 §6.1).
 *
 * The route module, the nav slot and a reserved `memory:*` channel / query-key namespace
 * are the only frontend commitments made today. The nav entry is reachable and badged, not
 * disabled.
 */
export function Component() {
  return (
    <PhasePlaceholder
      phase={3}
      title="Memory"
      description="Semantic search across the four-tier memory system — session, project, agent and global — backed by Qdrant."
    />
  );
}
