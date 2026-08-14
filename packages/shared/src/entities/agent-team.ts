/**
 * F4.1 — AgentTeam vocabulary (PRD §5.7, storage `db/schema/agent-teams.ts`).
 *
 * Declared here rather than inline in the schema for the reason `agent.ts` gives: the CHECK
 * constraints, the route schemas and the serializers must all be driven from one list, because a
 * scope the database admits and the API cannot express is a row an operator can create and never
 * use (F9.5 vocabulary discipline).
 *
 * ## What a team is
 *
 * PRD §5.7: *"Example team: Product Owner, Architect, Developer, QA, Security. Teams can be
 * assigned per project."* A team is therefore two things and nothing more — **a named set of
 * Agents**, and **an assignment to the Projects it works on**. It is not a workflow (§5.6's
 * ordered `Developer → QA → Security → Architect` chain is a different entity, and this slice
 * does not build it), it is not a permission boundary, and it grants nothing: every agent a team
 * contains is already usable in the projects the team serves, because the scope rules below make
 * any other combination unrepresentable.
 *
 * ## Why the scope vocabulary is two values, not `AGENT_SCOPES`
 *
 * An Agent has three scopes; a team has two, and `session` is deliberately missing rather than
 * merely unused. A session agent names the one conversation it belongs to and dies with it — it
 * cannot be a standing member of anything, and a team holding one would be a roster with a seat
 * that expires. Re-using `AGENT_SCOPES` would have made that combination expressible and then
 * required a second rule to forbid it; a separate two-member vocabulary makes it unsayable.
 *
 * ## Why membership has no `role`
 *
 * §5.7 names its members by role — "Product Owner", "Architect". **Those are agent names.** An
 * Agent carries `instructions` that define exactly one persona, so an agent that is the Architect
 * on one team cannot be the QA on another without being a different agent with different
 * instructions. A `role` column would therefore duplicate `agents.name` in every row it is
 * populated and disagree with it in the rest — a second place for one fact, which is the defect
 * `integrations.ollama.enabled` was the standing example of in this codebase until it was
 * withdrawn from the key registry for gating nothing.
 *
 * ## Why membership has no ordinal
 *
 * A team is a **set**; §5.6's workflows are the ordered thing. And when workflows land the order
 * will belong to the *workflow* (the same five agents can run in two different orders in two
 * different chains), so an ordinal here would be in the wrong table even then. Members are
 * returned sorted by agent name, which is deterministic and needs no column.
 */

/**
 * PRD §5.7's "assigned per project", as the two kinds of team that implies.
 *
 *   `global`   reusable across projects  -> no `project_id`; may hold only **global** agents
 *   `project`  belongs to one project    -> `project_id`; may hold global agents **and** that
 *                                           project's own agents
 *
 * The asymmetry is the point: a global team must be safe to assign anywhere, so it cannot
 * contain an agent that is only meaningful inside one project. That is enforced by
 * `ck_agent_team_members_agent_scope`, not by convention — see the schema.
 */
export const AGENT_TEAM_SCOPES = ['global', 'project'] as const;
export type AgentTeamScope = (typeof AGENT_TEAM_SCOPES)[number];

export function isAgentTeamScope(value: unknown): value is AgentTeamScope {
  return typeof value === 'string' && (AGENT_TEAM_SCOPES as readonly string[]).includes(value);
}

/** Bounds shared by the `agent_teams` CHECK constraints and the route schemas — one declaration. */
export const MAX_AGENT_TEAM_NAME_LENGTH = 100;
export const MAX_AGENT_TEAM_DESCRIPTION_LENGTH = 2_000;

/**
 * Ceilings on the two arrays a team write carries.
 *
 * Not CHECK constraints — a row cannot count its siblings — so they are enforced by the route
 * schemas (`maxItems`), which is where an oversized request should die anyway. The numbers are
 * chosen as "obviously more than an operator will ever need" rather than as product limits:
 * PRD §5.7's example team has five members, and a single-operator install has tens of projects.
 * Their job is to bound the work one request can ask for, since a team write emits one
 * `agent.assigned` event per assigned project.
 */
export const MAX_AGENT_TEAM_MEMBERS = 50;
export const MAX_AGENT_TEAM_PROJECTS = 100;
