import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../events/index.js';
import type { SessionAgentPort } from '../sessions/agent-binding.js';
import { AgentBindingResolver } from './binding.js';
import { registerAgentRoutes } from './routes.js';
import { AgentService } from './service.js';

/**
 * `agents/` — the Agent domain (PRD §5, TDS 04 §13.2). Phase 4, first slice.
 *
 * Layout:
 *   permissions.ts  PRD §5.5 -> the runtime's tool gate. The only place that mapping exists
 *   store.ts        every `agents` read and write; there is no delete function
 *   validation.ts   name/description/instructions rules, the scope⇄target rule, permission rules
 *   serialize.ts    row -> the §13.2 resource, `disallowedTools` derived so it is auditable
 *   service.ts      list/get/create/update(+archive), audit rows and the two F6 events
 *   binding.ts      `SessionAgentPort`: may this agent be bound, and what must the runtime do
 *   routes.ts       `/api/v1/agents/*`
 *
 * What is **not** here, and is not an oversight:
 *   - **Teams and workflows** (PRD §5.6/§5.7). They presuppose agents that exist and run;
 *     `agent_teams` is still the skeleton it was and `agent_team_members` does not exist.
 *   - **Assignments and executions** (§13.2's other two routes). Binding to a Session is done
 *     through the Session resource today; a general assignment surface, and an agent that can
 *     call Mission Control, are later slices — and until one exists there is nothing for PRD
 *     §5.5's Memory and Documentation permission groups to gate.
 */

export * from './binding.js';
export * from './permissions.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';
export * from './validation.js';

export interface RegisterAgentsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
}

export interface AgentModule {
  readonly agents: AgentService;
  /** Handed to `registerSessions`; nothing else may reach into the agents store. */
  readonly binding: SessionAgentPort;
}

export function registerAgents(app: FastifyInstance, options: RegisterAgentsOptions): AgentModule {
  const agents = new AgentService({ db: options.db, outbox: options.outbox });
  const binding = new AgentBindingResolver({ db: options.db });

  registerAgentRoutes(app, { agents });

  return { agents, binding };
}
