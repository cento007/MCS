/**
 * Phase 4 skeleton tables (TDS 03 §6).
 *
 * > **Phase 4 — interface only.** This module is a placeholder/extension point.
 * > Detailed design is out of TDS scope per the project-plan scope guard.
 *
 * These exist so earlier phases never have to renumber or rename anything when agents land:
 * `audit_log_entries.actor_id` can already point at `agents.id`, `memory_items.agent_id`
 * already has its FK target, and `sessions` gains a nullable `agent_id` FK by additive
 * migration in Phase 4.
 *
 * DO NOT EXTEND before the corresponding phase's design document exists.
 *
 * `memory_items` used to live here. **It graduated**: Phase 3 is the phase TDS 03 §6 deferred
 * its design to, so the real table is `memory.ts`.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';

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
