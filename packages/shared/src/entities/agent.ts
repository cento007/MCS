/**
 * F4.1 — Agent vocabulary (PRD §5, storage `db/schema/agents.ts`).
 *
 * Declared here rather than inline in the schema for the reason `memory.ts` and `adr.ts` give:
 * the CHECK constraints, the route schemas, the settings registry and the runtime binding must
 * all be driven from one list, because a scope the database admits and the API cannot express
 * (or vice versa) is a row an operator can create and never use (F9.5 vocabulary discipline).
 *
 * ## What an Agent is, and what it is not
 *
 * PRD §5.1: `Runtime → Agent → Task`. An Agent is a **persona operating through a runtime**, not
 * a model. It carries instructions (which become the runtime's system prompt) and permissions
 * (which become the runtime's tool gate). It does not carry a model, an API key, or a provider.
 *
 * ## Why the permission set here is smaller than PRD §5.5
 *
 * §5.5 lists three groups — Repository (Read/Write/Commit/Create PR/Merge/Delete), Memory
 * (Read/Write/Delete) and Documentation (Create ADR/Create Notes/Edit Notes). Only the fields
 * below are declared, and the omissions are deliberate:
 *
 *  - **Commit / Create PR / Merge / Delete** are all `git`/`gh` invocations through the runtime's
 *    Bash tool. There is no separate tool for any of them, so separating them would mean parsing
 *    shell command strings — and a permission that `sh -c 'git commit …'` steps around is not a
 *    permission. They are therefore collapsed into `repository.shell`, which says exactly what it
 *    grants: arbitrary command execution, and with it all four.
 *  - **Memory** and **Documentation** have no control surface to gate. Memory search, ADR
 *    creation and Obsidian notes are Mission Control API routes that the *operator* calls; a
 *    Claude Code session has no path to them (there is no MCP server exposing them). A toggle
 *    over nothing is the `integrations.ollama.enabled` mistake repeated, so it is not shipped.
 *
 * When an execution surface exists that an agent can reach — a Phase 4+ slice that lets an agent
 * call Mission Control — those groups become expressible and get added here.
 */

/** PRD §5.2 — Global / Project / Session agents, verbatim. */
export const AGENT_SCOPES = ['global', 'project', 'session'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === 'string' && (AGENT_SCOPES as readonly string[]).includes(value);
}

/**
 * PRD §5.4 lists Claude Code (primary) and Ollama (optional) for V1. **Only `claude_code` is
 * here**, because only `claude_code` is launchable: `ManagedRuntime` drives the Claude Agent SDK
 * for every managed Session (F1.5), so an agent recorded as `ollama` would silently run on
 * Claude Code — a stored value that contradicts what happens.
 *
 * A one-member vocabulary is the honest shape of "one runtime exists". It widens by CHECK alter
 * the day a second runtime can actually be launched, exactly as `sessions.runtime` says.
 */
export const AGENT_RUNTIMES = ['claude_code'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && (AGENT_RUNTIMES as readonly string[]).includes(value);
}

/**
 * The three capabilities Mission Control can actually take away from a runtime session.
 *
 * Every one of them is **subtractive**: granting changes nothing relative to a Session launched
 * with no agent at all, denying removes the tools that could achieve it. That inversion is what
 * makes the model honest — Mission Control cannot widen what the operator's own Claude Code
 * settings already allow, so a grant here can never be a surprise.
 */
export interface AgentRepositoryPermissions {
  /** File reads: `Read`, `Glob`, `Grep`. */
  readonly read: boolean;
  /** File writes: `Write`, `Edit`, `NotebookEdit`. */
  readonly write: boolean;
  /**
   * Arbitrary command execution (`Bash`), and therefore PRD §5.5's Commit, Create PR, Merge and
   * Delete — which the runtime cannot separate from each other or from anything else a shell can
   * do. Granting this grants all four; there is no smaller true statement available.
   */
  readonly shell: boolean;
}

export interface AgentPermissions {
  readonly repository: AgentRepositoryPermissions;
}

/**
 * PRD §5.8's Permissions section, as three named starting points.
 *
 * `full` is not "everything": it is read + write + shell, which is what a Session launched
 * without any agent already has. There is no template that grants more than that, because there
 * is nothing more to grant.
 */
export const AGENT_PERMISSION_TEMPLATES = ['read_only', 'read_write', 'full'] as const;
export type AgentPermissionTemplate = (typeof AGENT_PERMISSION_TEMPLATES)[number];

export function isAgentPermissionTemplate(value: unknown): value is AgentPermissionTemplate {
  return (
    typeof value === 'string' && (AGENT_PERMISSION_TEMPLATES as readonly string[]).includes(value)
  );
}

/**
 * The template an agent gets when `POST /agents` names no permissions.
 *
 * `read_only`, because the default has to be the one an operator opts *out* of: an agent created
 * without thinking about permissions must not be able to edit a working tree. Overridden per
 * install by `settings.agents.defaultPermissionTemplate`.
 */
export const DEFAULT_AGENT_PERMISSION_TEMPLATE: AgentPermissionTemplate = 'read_only';

export function agentPermissionsFromTemplate(template: AgentPermissionTemplate): AgentPermissions {
  switch (template) {
    case 'read_only':
      return { repository: { read: true, write: false, shell: false } };
    case 'read_write':
      return { repository: { read: true, write: true, shell: false } };
    case 'full':
      return { repository: { read: true, write: true, shell: true } };
  }
}

/**
 * The invariant that makes the three booleans mean what they say: **`shell` subsumes `read` and
 * `write`.** A shell can `cat` a file and can `>` one, so `{ read: false, shell: true }` is a
 * denial that does not hold. It is rejected at the API boundary (`VALIDATION_FAILED`) and by
 * `ck_agents_permissions_shell_subsumes`, so the stored row can never describe an unenforceable
 * grant.
 */
export function isEnforceableAgentPermissions(permissions: AgentPermissions): boolean {
  const repository = permissions.repository;
  return !repository.shell || (repository.read && repository.write);
}

/**
 * Repair an untrusted `permissions` value into a canonical one.
 *
 * Deny-biased in both directions: an unreadable field reads as **not granted**, and a `shell`
 * that survives without `read`/`write` is dropped rather than allowed to imply them. A corrupt
 * JSONB row must be able to make an agent *less* capable than intended and never more.
 */
export function normalizeAgentPermissions(raw: unknown): AgentPermissions {
  const object = isRecord(raw) ? raw : {};
  const repository = isRecord(object['repository']) ? object['repository'] : {};

  const read = repository['read'] === true;
  const write = repository['write'] === true;
  const shell = repository['shell'] === true && read && write;

  return { repository: { read, write, shell } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounds shared by the `agents` CHECK constraints and the route schemas — one declaration. */
export const MAX_AGENT_NAME_LENGTH = 100;
export const MAX_AGENT_DESCRIPTION_LENGTH = 2_000;
/**
 * The instructions become the runtime's system-prompt append, so the ceiling is a context
 * budget rather than a storage one. 20 000 characters is roughly 5 000 tokens — a generous
 * persona, and small enough that it cannot crowd out the conversation it is meant to steer.
 */
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 20_000;
