import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../events/index.js';
import type { SessionAgentPort } from '../sessions/agent-binding.js';
import { AgentBindingResolver } from './binding.js';
import { registerAgentRoutes } from './routes.js';
import { AgentService } from './service.js';
import { type AgentTeamModule, registerAgentTeams } from './teams/index.js';

/**
 * `agents/` — the Agent domain (PRD §5, TDS 04 §13.2). Phase 4.
 *
 * Layout:
 *   permissions.ts  PRD §5.5 -> the runtime's tool gate. The only place that mapping exists
 *   store.ts        every `agents` read and write; there is no delete function
 *   validation.ts   name/description/instructions rules, the scope⇄target rule, permission rules
 *   serialize.ts    row -> the §13.2 resource, `disallowedTools` derived so it is auditable
 *   service.ts      list/get/create/update(+archive), audit rows and the two F6 events
 *   binding.ts      `SessionAgentPort`: may this agent be bound, and what must the runtime do
 *   routes.ts       `/api/v1/agents/*`
 *   teams/          PRD §5.7: the roster, its project assignments, and the read that consumes
 *                   them (`GET /projects/{id}/available-agents`) — slice 2
 *
 * What is **not** here, and is not an oversight:
 *   - **Workflows** (PRD §5.6). A workflow is an ordered chain of executions and no execution
 *     primitive exists, so the tables would describe something nothing can run. See
 *     `teams/index.ts` for why the ordering they need would not live on team membership anyway.
 *   - **Executions** (§13.2's `POST /agents/{id}/executions`). An agent that can call Mission
 *     Control is a later slice — and until one exists there is nothing for PRD §5.5's Memory and
 *     Documentation permission groups to gate.
 *   - **`POST /agents/{id}/assignments`.** Still not built, and now for a sharper reason than in
 *     slice 1: assignment turned out to be a *team* relationship, not a per-agent one. Binding an
 *     Agent to a Session remains a Session-lifecycle rule on the Session resource; making an
 *     Agent available to a Project is `PATCH /agent-teams/{id} { projectIds }`. A third spelling
 *     would be a second way to write the same rows.
 */

export * from './binding.js';
export * from './permissions.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';
export * from './teams/index.js';
export * from './validation.js';

export interface RegisterAgentsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
}

export interface AgentModule {
  readonly agents: AgentService;
  /** Handed to `registerSessions`; nothing else may reach into the agents store. */
  readonly binding: SessionAgentPort;
  /** PRD §5.7 teams, their project assignments, and the availability read (slice 2). */
  readonly teams: AgentTeamModule['teams'];
}

export function registerAgents(app: FastifyInstance, options: RegisterAgentsOptions): AgentModule {
  const agents = new AgentService({ db: options.db, outbox: options.outbox });
  const binding = new AgentBindingResolver({ db: options.db });

  registerAgentRoutes(app, { agents });
  const { teams } = registerAgentTeams(app, { db: options.db, outbox: options.outbox });

  return { agents, binding, teams };
}
