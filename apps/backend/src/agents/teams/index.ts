import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../../events/index.js';
import { registerAgentTeamRoutes } from './routes.js';
import { AgentTeamService } from './service.js';

/**
 * `agents/teams/` — the AgentTeam domain (PRD §5.7, TDS 04 §13.2). Phase 4, second slice.
 *
 * Layout:
 *   store.ts         every read and write of the three tables; the availability query lives here
 *   validation.ts    name/description rules, the scope⇄target rule, id-list normalisation
 *   serialize.ts     rows -> the §13.2 resources
 *   availability.ts  `GET /projects/{id}/available-agents` — the consumer that makes teams matter
 *   service.ts       list/get/create/update/delete, audit rows and the four F6 events
 *   routes.ts        `/api/v1/agent-teams/*` and the availability read
 *
 * What is **not** here, and is not an oversight:
 *   - **Workflows** (PRD §5.6). A workflow is an ordered chain of *executions*, and no execution
 *     primitive exists — `POST /agents/{id}/executions` is unbuilt and the three
 *     `agent.execution_*` event names are still unproduced. Tables for a chain nothing can run
 *     would be a drawing of a feature, and the ordering they need belongs to the workflow rather
 *     than to team membership (see `entities/agent-team.ts`).
 *   - **A `role` on membership.** PRD §5.7 names members by role; those names are the agents'
 *     names, because an Agent's `instructions` define exactly one persona. A `role` column would
 *     duplicate `agents.name` wherever it agreed and contradict it wherever it did not.
 */

export * from './availability.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';
export * from './validation.js';

export interface RegisterAgentTeamsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
}

export interface AgentTeamModule {
  readonly teams: AgentTeamService;
}

export function registerAgentTeams(
  app: FastifyInstance,
  options: RegisterAgentTeamsOptions,
): AgentTeamModule {
  const teams = new AgentTeamService({ db: options.db, outbox: options.outbox });
  registerAgentTeamRoutes(app, { teams, db: options.db });
  return { teams };
}
