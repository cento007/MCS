import { type AgentPermissions, normalizeAgentPermissions } from '@mc/shared/types';

/**
 * Agent permissions, as pure functions (PRD §5.5, `packages/shared/src/entities/agent.ts`).
 *
 * **This file exists because of one failure mode.** PRD §5.5 names twelve permissions across
 * three groups — Repository: Read, Write, Commit, Create PR, Merge, Delete · Memory: Read, Write,
 * Delete · Documentation: Create ADR, Create Notes, Edit Notes — and it would be trivial to draw
 * twelve switches from that list. It would also be the most dangerous thing the Agents screen
 * could do. A switch reading `Merge: off` that gates nothing is worse than no switch at all: an
 * operator reads it as a guarantee and stops watching. This codebase already shipped one setting
 * nothing reads (`integrations.ollama.enabled`); that one wasted a configuration step, and this
 * one would be a safety claim.
 *
 * ## Three switches, and where the other nine went
 *
 * The Backend declares exactly `repository.{read, write, shell}` and argues each omission:
 *
 *  - **Commit / Create PR / Merge / Delete** are all `git`/`gh` invocations through the runtime's
 *    Bash tool. There is no separate tool for any of them, so separating them would mean deciding
 *    permissions by parsing shell command strings — and `sh -c 'git merge …'` defeats that in one
 *    move. They collapse into `repository.shell`, which says what it actually grants.
 *  - **Memory and Documentation** have no control surface at all: memory search, ADR creation and
 *    Obsidian notes are Mission Control API routes the *operator* calls, and a Claude Code session
 *    has no path to them.
 *
 * ## What "enforced" means here, and the evidence for it
 *
 * The Agent resource carries **`disallowedTools`** — derived server-side by `disallowedToolsFor`,
 * the same function the launch path calls, and rejected on write. It is the exact
 * `--disallowedTools` list a Session running as this agent receives. So enforcement is not a
 * claim a screen makes from a spec: it is a list the API produced, in the runtime's own
 * vocabulary, which the UI renders verbatim.
 *
 * When that field is absent — an older Backend, or a shape this build has not seen — enforcement
 * is `null`, "not stated", and is never upgraded to enforced. Under-claiming makes an operator
 * careful; over-claiming makes them careless, and only one of those is recoverable.
 *
 * ## Subtractive, not additive
 *
 * A *granted* permission changes nothing relative to a Session launched with no agent: the tool is
 * simply not in the deny list. A *denied* one removes tools. Mission Control can therefore never
 * widen what the operator's own Claude Code settings already allow — which is why the Launch modal
 * describes binding an agent as *removing* tools rather than as granting anything.
 *
 * ## Why `lib/` and not `features/agents/`
 *
 * Same reason as `vocabulary.ts`: the Launch Session modal has to state what binding an agent
 * *costs* a session, and it cannot import a feature slice (TDS 05 §2.1). The draft/write half of
 * the permission model — the bits only the Builder form needs — stays in
 * `features/agents/permissions.ts`.
 */

export const REPOSITORY_GROUP = 'repository';

/** The three capabilities, in the order the Backend declares them. */
export const REPOSITORY_CAPABILITIES = ['read', 'write', 'shell'] as const;

export type RepositoryCapability = (typeof REPOSITORY_CAPABILITIES)[number];

export interface PermissionRow {
  readonly key: RepositoryCapability;
  /** Dotted path: the draft key and the row's stable identity. */
  readonly path: string;
  readonly label: string;
  /** What it grants and what denying it removes — the runtime tools, named. */
  readonly description: string;
  readonly granted: boolean;
  /**
   * `true` the Backend demonstrated the gate (it served `disallowedTools`) · `null` it did not
   * say. Never `false` for these three: the Backend either maps them onto the runtime's deny list
   * or does not answer at all.
   */
  readonly enforced: boolean | null;
}

export interface PermissionsShape {
  readonly rows: readonly PermissionRow[];
  /** Did the resource carry a readable `permissions` object at all? */
  readonly served: boolean;
  /** The Backend's derived deny list — the evidence. `null` when it served none. */
  readonly disallowedTools: readonly string[] | null;
  /** Keys served under `permissions` that this build has no switch for. Disclosed, not dropped. */
  readonly unrecognised: readonly string[];
  /** The canonical document, repaired by the Backend's own normaliser. */
  readonly permissions: AgentPermissions;
}

const LABELS: Readonly<Record<RepositoryCapability, string>> = {
  read: 'Read',
  write: 'Write',
  shell: 'Shell',
};

const DESCRIPTIONS: Readonly<Record<RepositoryCapability, string>> = {
  read: 'File reads. Denying it removes Read, Glob and Grep from the runtime.',
  write: 'File writes. Denying it removes Write, Edit and NotebookEdit.',
  shell:
    'Arbitrary command execution (Bash) — and therefore PRD §5.5’s Commit, Create PR, Merge and Delete together, because the runtime cannot separate them from each other or from anything else a shell can do. There is no smaller true statement available.',
};

/** Every PRD §5.5 permission the Backend does not model, so a screen can say so out loud. */
export const UNMODELLED_PERMISSIONS: readonly string[] = [
  'Repository: Commit, Create PR, Merge, Delete',
  'Memory: Read, Write, Delete',
  'Documentation: Create ADR, Create Notes, Edit Notes',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Project an Agent resource into the switches that may honestly be drawn.
 *
 * Takes `unknown` deliberately: `permissions` is a JSONB column and the declared type is a promise
 * about the row, not a fact about it. `normalizeAgentPermissions` is the Backend's own repair
 * function, imported rather than reimplemented — so a corrupt or future row degrades to a
 * *narrower* agent on screen in exactly the way it does on the server, instead of the two
 * disagreeing about what an operator is looking at.
 */
export function readAgentPermissions(resource: unknown): PermissionsShape {
  const record = asRecord(resource);
  const rawPermissions = record === null ? undefined : record['permissions'];
  const servedObject = asRecord(rawPermissions);
  const permissions = normalizeAgentPermissions(rawPermissions);

  const rawTools = record === null ? undefined : record['disallowedTools'];
  const disallowedTools = Array.isArray(rawTools)
    ? rawTools.filter((tool): tool is string => typeof tool === 'string')
    : null;

  const unrecognised: string[] = [];
  if (servedObject !== null) {
    for (const [group, value] of Object.entries(servedObject)) {
      if (group !== REPOSITORY_GROUP) {
        unrecognised.push(group);
        continue;
      }
      const keys = asRecord(value);
      if (keys === null) {
        unrecognised.push(group);
        continue;
      }
      for (const key of Object.keys(keys)) {
        if (!(REPOSITORY_CAPABILITIES as readonly string[]).includes(key)) {
          unrecognised.push(`${group}.${key}`);
        }
      }
    }
  }

  const enforced = disallowedTools === null ? null : true;

  return {
    rows: REPOSITORY_CAPABILITIES.map((key) => ({
      key,
      path: `${REPOSITORY_GROUP}.${key}`,
      label: LABELS[key],
      description: DESCRIPTIONS[key],
      granted: permissions.repository[key],
      enforced,
    })),
    served: servedObject !== null,
    disallowedTools,
    unrecognised,
    permissions,
  };
}

/**
 * The list column: how many of the three are granted.
 *
 * `3 of 3` is deliberately *not* dressed up as "full access": PRD §5.5's other nine permissions
 * are not modelled, so a word like "full" would claim a completeness the model does not have.
 */
export interface PermissionSummary {
  readonly granted: number;
  readonly total: number;
  /** True when the Backend served no `disallowedTools`, so enforcement is unproven. */
  readonly enforcementUnknown: boolean;
  /** Short caption: `read` / `read, write` / `read, write, shell` / `nothing`. */
  readonly caption: string;
}

export function summarisePermissions(shape: PermissionsShape): PermissionSummary {
  const grantedRows = shape.rows.filter((row) => row.granted);
  return {
    granted: grantedRows.length,
    total: shape.rows.length,
    enforcementUnknown: shape.disallowedTools === null,
    caption:
      grantedRows.length === 0
        ? 'nothing'
        : grantedRows.map((row) => row.label.toLowerCase()).join(', '),
  };
}
