import { type MemorySourceType, memorySourceField } from '@mc/shared/types';

/**
 * PRD §6.3's indexed sources, spelled for people, in exactly one place.
 *
 * Two screens name these sources and they live in feature slices that may not import each
 * other (TDS 05 §2.1): the Memory screen labels results and filter chips with them, and
 * Settings → Memory renders one toggle per source (PRD §4.4 item 4). A second copy of the
 * words is how "Obsidian note" and "Obsidian Note" end up on the same instance, so the copy
 * lives here — beside `session-state.ts` and `service-health.ts`, which are here for the same
 * reason.
 *
 * The **tokens** are never re-declared: `MemorySourceType` comes from `@mc/shared` (F4.1), so
 * a source the Backend can index and this client cannot name is a compile error rather than a
 * memory an operator can write and never read back.
 */
export const MEMORY_SOURCE_LABELS: Readonly<Record<MemorySourceType, string>> = {
  session: 'Session',
  commit: 'Commit',
  adr: 'ADR',
  obsidian_note: 'Obsidian note',
  pull_request: 'Pull request',
  document: 'Document',
};

/** An unknown token from a newer Backend renders as itself rather than crashing the screen. */
export function memorySourceLabel(sourceType: string): string {
  return MEMORY_SOURCE_LABELS[sourceType as MemorySourceType] ?? sourceType;
}

/**
 * `pull_request` → `pullRequest` — a source's field name inside the `memory.indexedSources`
 * settings document — re-exported from `@mc/shared`, never re-implemented here.
 *
 * The Backend derives its settings key registry from the same function (`MEMORY_KEYS
 * .indexedSources`), so the toggles this panel renders and the toggles the indexer obeys are the
 * same names by construction. A local copy would drift silently in the worst direction: an
 * unmatched field name reads as "the Backend does not serve this toggle", which is exactly what
 * a missing key looks like.
 */
export { memorySourceField };
