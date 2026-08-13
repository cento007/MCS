import { eq } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import {
  MEMORY_SOURCE_TYPES,
  type MemorySourceType,
  memorySourceField,
  PRODUCIBLE_MEMORY_TIERS,
  type ProducibleMemoryTier,
} from '../entities/memory.js';
import { normalizeSetting, settingKey } from '../settings/registry.js';
import type {
  IndexedSourceToggles,
  MemoryRetentionDays,
  MemorySettings,
} from '../settings/types.js';

/**
 * `settings.memory.*`, read from the database — the Phase 3 half of PRD §4.4 item 4.
 *
 * ## Why this exists as a module rather than as two `read()` calls at each call site
 *
 * The two settings it carries are only worth having if **every** writer and reader obeys them,
 * and there are five places that must: the incremental indexer, the backfill sweep, the vault
 * note stage, the repository documentation stage, and retrieval. Five independent reads of the
 * same two rows is five chances for one of them to forget — which is exactly how
 * `integrations.ollama.enabled` ended up being a switch nothing consults. One shape, one parser,
 * one set of predicates.
 *
 * Modelled on `obsidian/settings.ts`, and in `@mc/shared` for the same reason: the sweep that
 * consumes `indexedSources` lives in `memory/backfill.ts`, which a worker may import and which
 * may not import a Backend module (F2.2).
 *
 * Every value goes out through the registry's own `normalize`, so a hand-edited `settings` row
 * degrades to a documented default — **on** for a source toggle, `0` (never expire) for a
 * retention window — rather than silently disabling indexing or deleting an operator's memory.
 */

const KEYS = Object.freeze({
  indexedSources: settingKey('memory.indexedSources'),
  retentionDays: settingKey('memory.retentionDays'),
});

/** The `MemorySettings` document (TDS 04 §7.2 / PRD §4.4 item 4). No secrets — memory has none. */
export type MemoryPolicy = MemorySettings;

export function parseMemoryPolicy(values: ReadonlyMap<string, unknown>): MemoryPolicy {
  return {
    indexedSources: normalizeSetting<IndexedSourceToggles>(
      'memory.indexedSources',
      values.get(KEYS.indexedSources),
    ),
    retentionDays: normalizeSetting<MemoryRetentionDays>(
      'memory.retentionDays',
      values.get(KEYS.retentionDays),
    ),
  };
}

export async function readMemoryPolicy(db: Db | DbTransaction): Promise<MemoryPolicy> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.category, 'memory'));

  return parseMemoryPolicy(new Map(rows.map((row) => [row.key, row.value])));
}

/**
 * May this source type be written to the index, and may its chunks answer a query?
 *
 * Deliberately one predicate for both halves. If indexing and retrieval consulted the toggle
 * separately they could disagree, and the disagreement an operator would meet is the worse
 * direction: a source switched off that keeps returning results, which makes the switch a lie.
 */
export function isSourceIndexed(policy: MemoryPolicy, sourceType: MemorySourceType): boolean {
  const field = memorySourceField(sourceType) as keyof IndexedSourceToggles;
  return policy.indexedSources[field];
}

/** The source types currently switched on, in `MEMORY_SOURCE_TYPES` order. */
export function enabledMemorySources(policy: MemoryPolicy): readonly MemorySourceType[] {
  return MEMORY_SOURCE_TYPES.filter((type) => isSourceIndexed(policy, type));
}

/** True when every source is on — the default, and the case retrieval must not pay for. */
export function allMemorySourcesEnabled(policy: MemoryPolicy): boolean {
  return MEMORY_SOURCE_TYPES.every((type) => isSourceIndexed(policy, type));
}

/** True when no tier expires — the default, and the case the retention tick must not wake for. */
export function retentionDisabled(policy: MemoryPolicy): boolean {
  return PRODUCIBLE_MEMORY_TIERS.every((tier) => policy.retentionDays[tier] <= 0);
}

/**
 * The instant before which this tier's chunks have expired, or `null` when it never expires.
 *
 * Compared against `memory_items.created_at` — when the chunk *entered the index*, not when its
 * source happened. Those differ, and `created_at` is the one that makes PRD §6.1's "Session
 * Memory — temporary" mean what an operator reads it as: a chunk written today survives its
 * window from today, whether it came from a session that finished this morning or from a
 * backfill of one that finished last year. Using the source's own timestamp would make a first
 * backfill delete most of what it had just spent an hour embedding.
 */
export function retentionCutoff(
  policy: MemoryPolicy,
  tier: ProducibleMemoryTier,
  now: Date,
): Date | null {
  const days = policy.retentionDays[tier];
  if (days <= 0) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
