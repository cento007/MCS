import { MemoryPage } from '../features/memory/MemoryPage.js';

/**
 * `/memory` — semantic search across the four-tier memory system (PRD §8.4, TDS 05 §2.2,
 * TDS 06 §6.1).
 *
 * This was a `PhasePlaceholder` while the route, the nav slot and the reserved `memory:*` channel
 * and query-key namespace were the only commitments made. The Phase 3 backend — retrieval,
 * ingestion, backfill — now exists, so the placeholder is replaced by the screen it reserved space
 * for: the same search field and results region the §6.1 wireframe sketched.
 */
export function Component() {
  return <MemoryPage />;
}
