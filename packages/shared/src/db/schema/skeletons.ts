/**
 * Phase 4 skeleton tables (TDS 03 §6).
 *
 * > **Phase 5 — interface only.** This module is a placeholder/extension point.
 * > Detailed design is out of TDS scope per the project-plan scope guard.
 *
 * DO NOT EXTEND before the corresponding phase's design document exists.
 *
 * Two tables have now graduated out of here. `memory_items` went first — Phase 3 is the phase
 * TDS 03 §6 deferred its design to, and the real table is `memory.ts`. `agents` followed in
 * Phase 4's first slice; the real table is `agents.ts`, and `sessions.agent_id` (which this file
 * used to promise as "an additive migration in Phase 4") landed with it.
 *
 * What is left is `agent_teams` (PRD §5.7), which presupposes agents that exist and run and is
 * therefore explicitly out of the agent framework's first slice. Its membership join table
 * (`agent_team_members`) is still name-reserved only and must not be created here.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';

/** Phase 4 skeleton. PRD §5.7 team composition and per-project assignment are a later slice. */
export const agentTeams = pgTable('agent_teams', {
  id: primaryKeyId(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
