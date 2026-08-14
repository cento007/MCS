import { type PermissionsShape, readAgentPermissions } from './permissions.js';

/**
 * The Agent resource as this client reads it — one projection, shared by every screen that
 * renders an agent.
 *
 * Three screens now depend on it and they are in two different feature slices: the Agents list
 * and Builder (`features/agents/`), the Launch Session modal and the Session header
 * (`features/sessions/`). TDS 05 §2.1 forbids the second from importing the first, so the
 * projection lives here — the alternative being two readers that disagree about what an agent
 * with a missing `name` is.
 */

/** An Agent as a screen renders it: every field read rather than trusted. */
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
  /** Keys served on the resource that this build neither renders nor understands. */
  readonly unrecognised: readonly string[];
  /** The document exactly as served. */
  readonly raw: unknown;
}

/** Fields this client reads. Anything else on the resource is reported as unrecognised. */
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
