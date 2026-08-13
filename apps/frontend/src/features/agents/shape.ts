import {
  type AgentPermissions,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_INSTRUCTIONS_LENGTH,
  MAX_AGENT_NAME_LENGTH,
} from '@mc/shared/types';
import type { Draft, DraftValue } from '../../lib/forms/dirty.js';
import {
  isEnforceable,
  type PermissionsShape,
  permissionDraftKey,
  permissionsFromDraft,
  readAgentPermissions,
  toPermissionsDraft,
} from './permissions.js';

/**
 * The Agent resource as pure functions: read it, draft it, validate it, write it back.
 *
 * No DOM anywhere, which is the point — the two invariants (scope names its target; `shell`
 * subsumes `read` and `write`) and the create/patch bodies are the things most worth asserting
 * directly, and all of them are decisions about data rather than about layout.
 *
 * Every bound and every rule here is **imported from `@mc/shared/types`**, which is the module the
 * Backend's route schemas and CHECK constraints are built from. Restating `maxLength: 100` or
 * re-deriving "shell needs read and write" in this file would create a second source of truth for
 * a rule whose whole purpose is that there is one.
 */

// ------------------------------------------------------------------------------------ reading

/** An Agent as the screen renders it: every field read rather than trusted. */
export interface AgentView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** `string`, not `AgentScope` — an unrecognised scope renders verbatim, never as blank. */
  readonly scope: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly runtime: string;
  readonly instructions: string;
  readonly permissions: PermissionsShape;
  readonly archivedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** Keys served on the resource that this screen neither renders nor understands. */
  readonly unrecognised: readonly string[];
  /** The document exactly as served. */
  readonly raw: unknown;
}

/** Fields this screen reads. Anything else on the resource is reported as unrecognised. */
const KNOWN_FIELDS = new Set([
  'id',
  'name',
  'description',
  'scope',
  'projectId',
  'sessionId',
  'runtime',
  'permissions',
  'disallowedTools',
  'instructions',
  'archivedAt',
  'createdAt',
  'updatedAt',
]);

function stringAt(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Project one Agent resource.
 *
 * Returns `null` only when the row has no usable identity — no `id`, or no `name` for the cell. A
 * row that cannot be identified cannot be linked to or edited, and rendering it as a blank line
 * would be worse than the honest "n rows could not be read" the list prints. This matters more
 * than usual here: `AppShell` has no error boundary of its own — the nearest is on the
 * `RequireAuth` parent — so a throw inside this projection would replace the whole authenticated
 * area rather than one table.
 */
export function readAgent(raw: unknown): AgentView | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const id = stringAt(record, 'id');
  const name = stringAt(record, 'name');
  if (id === null || id.length === 0 || name === null) return null;

  const projectId = stringAt(record, 'projectId');
  const sessionId = stringAt(record, 'sessionId');

  return {
    id,
    name,
    description: stringAt(record, 'description') ?? '',
    // An absent scope is not defaulted to `global`: `''` renders as "not stated" and nothing on
    // the screen guesses, where a silent default would quietly widen an agent's reach.
    scope: stringAt(record, 'scope') ?? '',
    projectId: projectId !== null && projectId.length > 0 ? projectId : null,
    sessionId: sessionId !== null && sessionId.length > 0 ? sessionId : null,
    runtime: stringAt(record, 'runtime') ?? '',
    instructions: stringAt(record, 'instructions') ?? '',
    permissions: readAgentPermissions(record),
    archivedAt: stringAt(record, 'archivedAt'),
    createdAt: stringAt(record, 'createdAt'),
    updatedAt: stringAt(record, 'updatedAt'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_FIELDS.has(key)),
    raw,
  };
}

export interface AgentListRead {
  readonly agents: readonly AgentView[];
  /** Rows the projection refused. Counted and disclosed, never silently dropped. */
  readonly unreadable: number;
}

export function readAgentList(rows: readonly unknown[]): AgentListRead {
  const agents: AgentView[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const agent = readAgent(row);
    if (agent === null) unreadable += 1;
    else agents.push(agent);
  }
  return { agents, unreadable };
}

// -------------------------------------------------------------------------- knowledge sources

/**
 * PRD §5.8's seventh Builder section, and PRD §5.3's `knowledge:` / `memory:` fields.
 *
 * **The Backend stores neither, and says why**: `packages/shared/src/db/schema/agents.ts` leaves
 * both columns out because nothing reads them — the `agent` memory tier has no producer
 * (`PRODUCIBLE_MEMORY_TIERS` still excludes it) and there is no knowledge-source consumer. So this
 * reader looks for one under any of three plausible names and reports what it finds, which is the
 * difference between "the Backend has no such concept" and "the Backend has one this build cannot
 * edit" — two states with completely different next actions.
 *
 * It is deliberately read-only. A picker over a field with no schema would be exactly the artefact
 * `permissions.ts` exists to prevent, one section further down the page.
 */
export interface KnowledgeSourcesRead {
  readonly served: boolean;
  /** The field that carried it, so the note quotes the Backend rather than guessing. */
  readonly field: string | null;
  /** A short, safe rendering of the served value. Never parsed into controls. */
  readonly preview: string | null;
}

const KNOWLEDGE_FIELDS = ['knowledgeSources', 'knowledge', 'memory'] as const;

export function readKnowledgeSources(raw: unknown): KnowledgeSourcesRead {
  if (typeof raw !== 'object' || raw === null) return { served: false, field: null, preview: null };
  const record = raw as Record<string, unknown>;

  for (const field of KNOWLEDGE_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    let preview: string;
    try {
      preview = JSON.stringify(value);
    } catch {
      // Circular or otherwise unserialisable. It exists; that is the whole claim being made.
      preview = '(unreadable)';
    }
    return {
      served: true,
      field,
      preview: preview.length > 400 ? `${preview.slice(0, 400)}…` : preview,
    };
  }

  return { served: false, field: null, preview: null };
}

// ------------------------------------------------------------------------------------- drafting

export const AGENT_FIELDS = {
  name: 'name',
  description: 'description',
  instructions: 'instructions',
  scope: 'scope',
  projectId: 'projectId',
  runtime: 'runtime',
  archived: 'archived',
} as const;

export const AGENT_LIMITS = {
  name: MAX_AGENT_NAME_LENGTH,
  description: MAX_AGENT_DESCRIPTION_LENGTH,
  instructions: MAX_AGENT_INSTRUCTIONS_LENGTH,
} as const;

export interface NewAgentDefaults {
  /**
   * `settings.agents.defaultPermissionTemplate`, resolved to a permission document.
   *
   * The create form starts from the same document `POST /agents` would apply if the body named no
   * permissions, so the switches an operator sees before touching anything are the ones they
   * would get by not touching anything. Seeding a different default here would make the form and
   * the API disagree about what "leave it alone" means.
   */
  readonly permissions: AgentPermissions;
}

export function newAgentDraft(defaults: NewAgentDefaults): Draft {
  const repository = defaults.permissions.repository;
  return {
    [AGENT_FIELDS.name]: '',
    [AGENT_FIELDS.description]: '',
    [AGENT_FIELDS.instructions]: '',
    // `global` because it is the only scope that is true of every install and needs no target.
    [AGENT_FIELDS.scope]: 'global',
    [AGENT_FIELDS.projectId]: '',
    // One member in `AGENT_RUNTIMES`, so this is a fact rather than a default.
    [AGENT_FIELDS.runtime]: 'claude_code',
    [AGENT_FIELDS.archived]: false,
    [permissionDraftKey('repository.read')]: repository.read,
    [permissionDraftKey('repository.write')]: repository.write,
    [permissionDraftKey('repository.shell')]: repository.shell,
  };
}

export function toAgentDraft(agent: AgentView): Draft {
  const draft: Record<string, DraftValue> = {
    [AGENT_FIELDS.name]: agent.name,
    [AGENT_FIELDS.description]: agent.description,
    [AGENT_FIELDS.instructions]: agent.instructions,
    [AGENT_FIELDS.scope]: agent.scope,
    [AGENT_FIELDS.projectId]: agent.projectId ?? '',
    [AGENT_FIELDS.runtime]: agent.runtime,
    [AGENT_FIELDS.archived]: agent.archivedAt !== null,
    ...toPermissionsDraft(agent.permissions),
  };
  return draft;
}

export function draftString(draft: Draft, field: string): string {
  const value = draft[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Switching to `global` clears the project rather than leaving it to fail validation.
 *
 * A global agent carrying a `projectId` is not a mistake the operator made; it is a leftover from
 * the field they just abandoned, and the Backend rejects it outright (`assertScopeTarget`: *"A
 * 'global' scoped agent must not name a project"*). Switching *to* `project` deliberately does not
 * guess a project — that is the choice the invariant exists to force.
 */
export function applyScopeChange(draft: Draft, scope: string): Draft {
  if (scope === 'project') return { ...draft, [AGENT_FIELDS.scope]: scope };
  return { ...draft, [AGENT_FIELDS.scope]: scope, [AGENT_FIELDS.projectId]: '' };
}

/**
 * Granting `shell` grants `read` and `write` with it, in the form rather than at the API.
 *
 * `isEnforceableAgentPermissions` forbids `{ read: false, shell: true }`, and the Backend answers
 * a `400` naming the field. Turning shell on could therefore either (a) raise a blocking issue and
 * make the operator tick two more boxes, or (b) do what the rule says the value means. (b) is
 * chosen because the rule is not a policy the operator can disagree with — a shell *can* read and
 * write, so `read: false` beside `shell: true` was never a real denial, it was a wrong label.
 *
 * The reverse is not automatic: turning `read` off while `shell` is on leaves an unenforceable
 * pair, which surfaces as a blocking issue naming both — because that operator is trying to
 * express something, and silently switching `shell` off underneath them would answer a question
 * they did not ask.
 */
export function applyPermissionChange(draft: Draft, path: string, granted: boolean): Draft {
  if (path === 'repository.shell' && granted) {
    return {
      ...draft,
      [permissionDraftKey('repository.read')]: true,
      [permissionDraftKey('repository.write')]: true,
      [permissionDraftKey('repository.shell')]: true,
    };
  }
  return { ...draft, [permissionDraftKey(path)]: granted };
}

// ----------------------------------------------------------------------------------- validating

export type IssueSeverity = 'blocking' | 'advisory';

export interface AgentFormIssue {
  /** Draft key the issue belongs to, so the field marks itself. */
  readonly field: string;
  readonly severity: IssueSeverity;
  /** What is wrong, in one line. */
  readonly message: string;
  /** Why it cannot be saved — the half a bare "required" leaves out. */
  readonly why: string;
}

export interface ValidationContext {
  /** False when `GET /projects` failed — a project cannot be chosen from a list that is not there. */
  readonly projectsAvailable: boolean;
  readonly mode: 'create' | 'edit';
}

/**
 * Everything wrong with the draft, in field order.
 *
 * The two invariants earn the `why` field. Both are enforced by the Backend in the database, so a
 * form that merely disabled `[Create]` would be refusing without saying what would fix it — and in
 * both cases the fix is a *different decision*, not a missing keystroke:
 *
 *  - an operator who does not want to pick a project does not need a project field, they need the
 *    **Global** scope;
 *  - an operator who wants a read-only agent does not need to argue with `shell`, they need to
 *    turn `shell` **off**, because a shell that cannot read is not a thing.
 */
export function agentIssues(draft: Draft, context: ValidationContext): readonly AgentFormIssue[] {
  const issues: AgentFormIssue[] = [];

  const name = draftString(draft, AGENT_FIELDS.name).trim();
  if (name.length === 0) {
    issues.push({
      field: AGENT_FIELDS.name,
      severity: 'blocking',
      message: 'An agent needs a name.',
      why: 'It is how the agent is picked everywhere else, and the Backend enforces uniqueness on it within a scope — there is no other identifier a person reads.',
    });
  } else if (name.length > AGENT_LIMITS.name) {
    issues.push({
      field: AGENT_FIELDS.name,
      severity: 'blocking',
      message: `The name is ${name.length} characters; the limit is ${AGENT_LIMITS.name}.`,
      why: 'The Backend rejects a longer one at the route schema, so saving would fail rather than truncate.',
    });
  }

  const description = draftString(draft, AGENT_FIELDS.description).trim();
  if (description.length > AGENT_LIMITS.description) {
    issues.push({
      field: AGENT_FIELDS.description,
      severity: 'blocking',
      message: `The description is ${description.length} characters; the limit is ${AGENT_LIMITS.description}.`,
      why: 'The route schema rejects a longer one.',
    });
  }

  const instructions = draftString(draft, AGENT_FIELDS.instructions);
  if (instructions.length > AGENT_LIMITS.instructions) {
    issues.push({
      field: AGENT_FIELDS.instructions,
      severity: 'blocking',
      message: `The prompt is ${instructions.length.toLocaleString()} characters; the limit is ${AGENT_LIMITS.instructions.toLocaleString()}.`,
      why: 'The ceiling is a context budget rather than a storage one — roughly 5 000 tokens, small enough that a persona cannot crowd out the conversation it is meant to steer.',
    });
  } else if (instructions.trim().length === 0) {
    issues.push({
      field: AGENT_FIELDS.instructions,
      severity: 'advisory',
      message: 'This agent has no prompt.',
      why: 'The prompt is the persona (PRD §5.1: agents are personas operating through runtimes, not models). With none, this agent is its permissions and nothing else.',
    });
  }

  // Scope is immutable after create (`apps/backend/src/agents/service.ts`), so it is not editable
  // in edit mode and cannot be wrong there — nothing on this screen can change it.
  if (context.mode === 'create') {
    const scope = draftString(draft, AGENT_FIELDS.scope);
    const projectId = draftString(draft, AGENT_FIELDS.projectId);

    if (scope.length === 0) {
      issues.push({
        field: AGENT_FIELDS.scope,
        severity: 'blocking',
        message: 'Choose a scope.',
        why: 'Scope decides where this agent is offered, and it cannot be changed afterwards. There is no neutral value: an agent is available to every project, or to exactly one.',
      });
    }

    if (scope === 'project' && projectId.length === 0) {
      issues.push({
        field: AGENT_FIELDS.projectId,
        severity: 'blocking',
        message: 'A project agent needs a project.',
        why: context.projectsAvailable
          ? 'A project-scoped agent belongs to exactly one project and is offered nowhere else, so the Backend stores the project on the row and refuses it empty — `ck_agents_scope_target` makes the combination unstorable. If this agent should be available everywhere, its scope is Global, not Project with no project. Scope cannot be changed after it is created.'
          : 'The projects list could not be read, so there is nothing to choose from. Retry it before saving — or scope this agent Global, which needs no project at all.',
      });
    }
  }

  if (!isEnforceable(draft)) {
    const permissions = permissionsFromDraft(draft);
    const missing = [
      permissions.repository.read ? null : 'Read',
      permissions.repository.write ? null : 'Write',
    ].filter((entry): entry is string => entry !== null);

    issues.push({
      field: permissionDraftKey('repository.shell'),
      severity: 'blocking',
      message: `Shell is granted while ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} denied.`,
      why: 'A shell can read a file and write one, so that denial would not hold — the agent would be told it may not write, and would write anyway. Grant Read and Write as well, or turn Shell off. The Backend refuses the combination outright, and so does the database.',
    });
  }

  return issues;
}

export function blockingIssues(issues: readonly AgentFormIssue[]): readonly AgentFormIssue[] {
  return issues.filter((issue) => issue.severity === 'blocking');
}

export function issueFor(
  issues: readonly AgentFormIssue[],
  field: string,
): AgentFormIssue | undefined {
  return issues.find((issue) => issue.field === field);
}

// ------------------------------------------------------------------------------------- writing

/**
 * `POST /agents` — the whole document, because there is nothing on the server to merge with.
 *
 * `description` and `instructions` go as `null` rather than `''` when empty: the Backend collapses
 * both to `null` anyway (`normalizeOptionalText`), and sending the empty string would make the
 * response differ from the request for no reason. `projectId` is forced to `null` outside project
 * scope regardless of the draft — which is what makes `applyScopeChange`'s tidy-up a guarantee
 * rather than a habit, and matters because the Backend rejects a global agent that names one.
 *
 * `sessionId` is never sent: this screen does not create session-scoped agents (see
 * `OFFERED_AGENT_SCOPES`).
 */
export function toCreateBody(draft: Draft): Record<string, unknown> {
  const scope = draftString(draft, AGENT_FIELDS.scope);
  const projectId = draftString(draft, AGENT_FIELDS.projectId);
  const description = draftString(draft, AGENT_FIELDS.description).trim();
  const instructions = draftString(draft, AGENT_FIELDS.instructions).trim();

  return {
    name: draftString(draft, AGENT_FIELDS.name).trim(),
    description: description.length === 0 ? null : description,
    scope,
    projectId: scope === 'project' && projectId.length > 0 ? projectId : null,
    runtime: draftString(draft, AGENT_FIELDS.runtime),
    instructions: instructions.length === 0 ? null : instructions,
    permissions: permissionsFromDraft(draft),
  };
}

/**
 * `PATCH /agents/{id}` — **only what changed**.
 *
 * This is the opposite of the Settings rule, and the difference is the verb: a settings save is a
 * full-category `PUT` where an omitted field resets to its default (arbitration A14), whereas
 * `PATCH` leaves an omitted field alone. Sending the whole document here would make this screen
 * overwrite fields it never displayed.
 *
 * **`scope`, `projectId` and `sessionId` are never sent.** They are absent from the Backend's
 * update schema, which is `additionalProperties: false` — so including them is not a no-op, it is
 * a `400` naming the field. Scope is immutable by design: moving an agent between scopes would
 * silently re-point every Session that ran as it.
 *
 * `permissions` goes whole whenever any switch moved, because a nested object in a `PATCH` is
 * replaced rather than merged — half a permissions object would revoke everything it omitted.
 */
export function toPatchBody(baseline: Draft, draft: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const changed = (field: string): boolean => draft[field] !== baseline[field];

  if (changed(AGENT_FIELDS.name)) {
    body['name'] = draftString(draft, AGENT_FIELDS.name).trim();
  }
  if (changed(AGENT_FIELDS.description)) {
    const description = draftString(draft, AGENT_FIELDS.description).trim();
    body['description'] = description.length === 0 ? null : description;
  }
  if (changed(AGENT_FIELDS.instructions)) {
    const instructions = draftString(draft, AGENT_FIELDS.instructions).trim();
    body['instructions'] = instructions.length === 0 ? null : instructions;
  }
  if (changed(AGENT_FIELDS.runtime)) {
    body['runtime'] = draftString(draft, AGENT_FIELDS.runtime);
  }
  if (changed(AGENT_FIELDS.archived)) {
    body['archived'] = draft[AGENT_FIELDS.archived] === true;
  }

  const permissionsChanged = (['repository.read', 'repository.write', 'repository.shell'] as const)
    .map(permissionDraftKey)
    .some((key) => draft[key] !== baseline[key]);
  if (permissionsChanged) {
    body['permissions'] = permissionsFromDraft(draft);
  }

  return body;
}
