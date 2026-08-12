/**
 * Phase 3/4 skeleton tables (TDS 03 §6).
 *
 * > **Phase 3/4 — interface only.** This module is a placeholder/extension point.
 * > Detailed design is out of TDS scope per the project-plan scope guard.
 *
 * These exist so Phase 1–2 never has to renumber or rename anything when memory and agents
 * land: `audit_log_entries.actor_id` can already point at `agents.id`, and `sessions` gains a
 * nullable `agent_id` FK by additive migration in Phase 4.
 *
 * DO NOT EXTEND before the corresponding phase's design document exists.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, updatedAt, valueList } from './columns.js';

/** PRD §6.1 — the four memory tiers. */
const MEMORY_TIERS = ['session', 'project', 'agent', 'global'] as const;

/**
 * Phase 3 skeleton. Reserves the entity name and the columns Phase 1–2 must not collide
 * with. The actual vectors live in Qdrant (F2.1 #6); this table will later hold the
 * relational spine (source linkage, tier, retention) with a `qdrant_point_id` reference.
 */
export const memoryItems = pgTable(
  'memory_items',
  {
    id: primaryKeyId(),
    tier: text('tier').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check('ck_memory_items_tier', sql`${table.tier} IN (${valueList(MEMORY_TIERS)})`)],
);

/** Phase 4 skeleton. PRD §5.3 agent structure is Phase 4 design work. */
export const agents = pgTable('agents', {
  id: primaryKeyId(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Phase 4 skeleton. The membership join table (`agent_team_members`) is name-reserved only. */
export const agentTeams = pgTable('agent_teams', {
  id: primaryKeyId(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
