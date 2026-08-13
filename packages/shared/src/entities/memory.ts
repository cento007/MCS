/**
 * F4.1 — MemoryItem vocabulary (PRD §6, storage TDS 03 §6).
 *
 * Declared here rather than inline in the schema for the same reason `adr.ts` is: the CHECK
 * constraints, the Qdrant payload filters and the in-memory fake's filters must all be driven
 * from one list, because a tier that exists in the database and not in the retrieval filter is
 * a memory an operator can write and never read back (F9.5 vocabulary discipline).
 */

/**
 * PRD §6.1 — the four memory tiers, verbatim.
 *
 * **`agent` is Phase 4 and nothing produces it.** It stays in the vocabulary and in the CHECK
 * because the alternative is a migration that widens a constraint later, and because a tier
 * silently missing from the filter list is exactly the bug this file exists to prevent. Every
 * Phase 3 writer produces `session`, `project` or `global`; `agent` rows appear when the agent
 * framework lands and `memory_items.agent_id` gets a real FK target.
 */
export const MEMORY_TIERS = ['session', 'project', 'agent', 'global'] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export function isMemoryTier(value: unknown): value is MemoryTier {
  return typeof value === 'string' && (MEMORY_TIERS as readonly string[]).includes(value);
}

/** The tiers a Phase 3 writer may actually produce. `agent` is deliberately absent. */
export const PRODUCIBLE_MEMORY_TIERS = [
  'session',
  'project',
  'global',
] as const satisfies readonly MemoryTier[];

/**
 * PRD §6.3 — the indexed sources, one snake_case token each.
 *
 * `pull_request` covers §6.3's "PR Descriptions" and `document` its "Documentation"; the six
 * entries map one-to-one onto the bullet list and no further, so the Settings → Memory panel's
 * "indexed sources" toggles (PRD §4.4 item 4) can be generated from this list when they land.
 */
export const MEMORY_SOURCE_TYPES = [
  'session',
  'commit',
  'adr',
  'obsidian_note',
  'pull_request',
  'document',
] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export function isMemorySourceType(value: unknown): value is MemorySourceType {
  return typeof value === 'string' && (MEMORY_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Sources identified by a **row id** in this database versus by an external **reference**.
 *
 * `obsidian_note` and `document` live in a vault or on disk and have no `uuid` of their own, so
 * they are addressed by `source_ref` (a vault-relative path). Everything else is a table row.
 * `ck_memory_items_source_identity` enforces exactly one of the two per row.
 */
export const REFERENCE_MEMORY_SOURCE_TYPES = [
  'obsidian_note',
  'document',
] as const satisfies readonly MemorySourceType[];

export function isReferenceMemorySource(sourceType: MemorySourceType): boolean {
  return (REFERENCE_MEMORY_SOURCE_TYPES as readonly MemorySourceType[]).includes(sourceType);
}

/**
 * Qdrant's own ceiling on a collection's `vectors.size`.
 *
 * Declared with the vocabulary rather than beside the table because two places need it and
 * neither may import the other: `memory_items`'s CHECK (a stored dimension above this could
 * never have come from a real collection) and the settings/health layer, which would otherwise
 * let an operator configure a model whose width the store will refuse.
 */
export const MAX_EMBEDDING_DIMENSION = 65_536;
