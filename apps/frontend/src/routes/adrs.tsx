import { PagePlaceholder } from '../components/PagePlaceholder.js';

/** `/adrs` — ADR list (Phase 2, PRD §7.3). */
export function Component() {
  return (
    <PagePlaceholder
      title="ADRs"
      summary="Architecture Decision Records, generated from Sessions and synced two-way with the Obsidian vault."
      owner="TDS 06 §5.6.1 — Phase 2"
    />
  );
}
