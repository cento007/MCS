import { PagePlaceholder } from '../components/PagePlaceholder.js';

/** `/adrs/:adrId` — Context / Decision / Alternatives / Consequences (Phase 2). */
export function Component() {
  return (
    <PagePlaceholder
      title="ADR"
      summary="Context, Decision, Alternatives and Consequences, with the status chip and vault sync state."
      owner="TDS 06 §5.6.2 — Phase 2"
    />
  );
}
