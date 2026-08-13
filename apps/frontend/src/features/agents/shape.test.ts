import { describe, expect, it } from 'vitest';
import type { Draft } from '../../lib/forms/dirty.js';
import { permissionDraftKey, readAgentPermissions } from './permissions.js';
import {
  AGENT_FIELDS,
  agentIssues,
  applyPermissionChange,
  applyScopeChange,
  blockingIssues,
  newAgentDraft,
  readAgent,
  readAgentList,
  readKnowledgeSources,
  toAgentDraft,
  toCreateBody,
  toPatchBody,
} from './shape.js';

/**
 * The Agent projections and the two invariants, asserted with no DOM.
 *
 * Both invariants are enforced by the Backend in the database, so what is under test here is not
 * whether they hold — it is whether the *form* refuses the same things the server does, and says
 * something useful while refusing. A form that lets an operator build an unstorable agent turns a
 * design decision into a 400 they have to reverse-engineer.
 */

const READ_ONLY = { repository: { read: true, write: false, shell: false } } as const;

function createDraft(overrides: Partial<Record<string, unknown>> = {}): Draft {
  return { ...newAgentDraft({ permissions: READ_ONLY }), ...overrides } as Draft;
}

describe('readAgent', () => {
  it('projects the Backend’s resource, including the disallowedTools evidence', () => {
    const agent = readAgent({
      id: 'a1',
      name: 'Architect',
      description: null,
      scope: 'global',
      projectId: null,
      sessionId: null,
      runtime: 'claude_code',
      permissions: READ_ONLY,
      disallowedTools: ['Bash', 'Write'],
      instructions: null,
      archivedAt: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
    });

    expect(agent?.name).toBe('Architect');
    // `null` description/instructions become `''` — a form field cannot hold `null`, and the
    // write path turns `''` back into `null` so the round trip is lossless.
    expect(agent?.description).toBe('');
    expect(agent?.instructions).toBe('');
    expect(agent?.permissions.disallowedTools).toEqual(['Bash', 'Write']);
    expect(agent?.unrecognised).toEqual([]);
  });

  it('refuses a row with no id or no name, and the list counts what it refused', () => {
    // A row that cannot be identified cannot be linked to or edited. Rendering it as a blank line
    // would be worse than saying how many were dropped.
    expect(readAgent({ name: 'nameless' })).toBeNull();
    expect(readAgent({ id: 'a1' })).toBeNull();
    expect(readAgent(null)).toBeNull();
    expect(readAgent([])).toBeNull();

    const list = readAgentList([{ id: 'a1', name: 'ok' }, { name: 'broken' }, 42]);
    expect(list.agents).toHaveLength(1);
    expect(list.unreadable).toBe(2);
  });

  it('never invents a scope for a Backend that served none', () => {
    // Defaulting an absent scope to `global` would silently widen an agent's reach — the screen
    // renders "not stated" instead and nothing guesses.
    expect(readAgent({ id: 'a1', name: 'x' })?.scope).toBe('');
  });

  it('reports fields it does not render, so a save that leaves them alone can say so', () => {
    const agent = readAgent({ id: 'a1', name: 'x', temperature: 0.4 });
    expect(agent?.unrecognised).toEqual(['temperature']);
  });
});

describe('permissions projection', () => {
  it('renders the three the Backend models, and marks them enforced only on evidence', () => {
    const withTools = readAgentPermissions({
      permissions: READ_ONLY,
      disallowedTools: ['Bash', 'Write'],
    });
    expect(withTools.rows.map((row) => row.key)).toEqual(['read', 'write', 'shell']);
    expect(withTools.rows.map((row) => row.granted)).toEqual([true, false, false]);
    expect(withTools.rows.every((row) => row.enforced === true)).toBe(true);

    // No `disallowedTools` -> no evidence -> `null`, never `true`. Under-claiming makes an
    // operator careful; over-claiming makes them careless.
    const withoutTools = readAgentPermissions({ permissions: READ_ONLY });
    expect(withoutTools.rows.every((row) => row.enforced === null)).toBe(true);
    expect(withoutTools.disallowedTools).toBeNull();
  });

  it('repairs an unenforceable stored document downwards, exactly as the Backend does', () => {
    // `normalizeAgentPermissions` is imported from `@mc/shared`, not reimplemented: a corrupt row
    // must make an agent *less* capable on this screen, and by the same rule as on the server.
    const shape = readAgentPermissions({
      permissions: { repository: { read: false, write: false, shell: true } },
    });
    expect(shape.rows.find((row) => row.key === 'shell')?.granted).toBe(false);
  });

  it('discloses a permission group this build has no switch for', () => {
    const shape = readAgentPermissions({
      permissions: { repository: { read: true }, memory: { read: true } },
    });
    expect(shape.unrecognised).toContain('memory');
  });
});

describe('the scope/project invariant', () => {
  it('blocks a project-scoped agent with no project, and explains the way out', () => {
    const draft = createDraft({ name: 'X', scope: 'project', projectId: '' });
    const issues = blockingIssues(agentIssues(draft, { projectsAvailable: true, mode: 'create' }));

    const issue = issues.find((entry) => entry.field === AGENT_FIELDS.projectId);
    expect(issue).toBeDefined();
    // The half a bare "required" leaves out: what to do instead. An operator who does not want to
    // pick a project does not need a project field, they need the Global scope.
    expect(issue?.why).toMatch(/scope is Global/i);
    expect(issue?.why).toMatch(/cannot be changed after/i);
  });

  it('clears the project when the scope leaves `project`', () => {
    const draft = createDraft({ scope: 'project', projectId: PROJECT });
    const next = applyScopeChange(draft, 'global');
    expect(next[AGENT_FIELDS.projectId]).toBe('');
    // …and the Backend would have rejected it: "A 'global' scoped agent must not name a project".
    expect(toCreateBody(next)['projectId']).toBeNull();
  });

  it('says the projects list is missing rather than repeating "choose a project"', () => {
    const draft = createDraft({ name: 'X', scope: 'project', projectId: '' });
    const issues = agentIssues(draft, { projectsAvailable: false, mode: 'create' });
    // Exactly one issue on the field — two competing messages leave the operator picking which to
    // believe.
    expect(issues.filter((entry) => entry.field === AGENT_FIELDS.projectId)).toHaveLength(1);
    expect(issues.find((entry) => entry.field === AGENT_FIELDS.projectId)?.why).toMatch(
      /could not be read/i,
    );
  });

  it('does not police scope in edit mode, because nothing there can change it', () => {
    // `PATCH /agents/{id}` has no `scope`/`projectId`/`sessionId` at all.
    const draft = createDraft({ name: 'X', scope: 'project', projectId: '' });
    const issues = agentIssues(draft, { projectsAvailable: true, mode: 'edit' });
    expect(issues.some((entry) => entry.field === AGENT_FIELDS.projectId)).toBe(false);
  });
});

describe('the shell-subsumes-read/write invariant', () => {
  it('grants read and write along with shell, rather than raising an error to tick two boxes', () => {
    const draft = createDraft({ name: 'X' });
    const next = applyPermissionChange(draft, 'repository.shell', true);
    expect(next[permissionDraftKey('repository.read')]).toBe(true);
    expect(next[permissionDraftKey('repository.write')]).toBe(true);
    // Nothing blocking. (The empty prompt is still flagged, advisory — it does not stop a save.)
    expect(blockingIssues(agentIssues(next, { projectsAvailable: true, mode: 'create' }))).toEqual(
      [],
    );
  });

  it('blocks the pair the Backend refuses, and names both halves', () => {
    // Turning `read` off while `shell` is on is someone trying to express something; switching
    // `shell` off underneath them would answer a question they did not ask.
    const draft = applyPermissionChange(
      applyPermissionChange(createDraft({ name: 'X' }), 'repository.shell', true),
      'repository.read',
      false,
    );

    const issue = blockingIssues(
      agentIssues(draft, { projectsAvailable: true, mode: 'create' }),
    ).find((entry) => entry.field === permissionDraftKey('repository.shell'));

    expect(issue?.message).toMatch(/Shell is granted while Read is denied/);
    expect(issue?.why).toMatch(/would not hold/);
  });
});

describe('bodies', () => {
  it('POST sends the whole document, with empty text as null', () => {
    const draft = createDraft({ name: '  Architect  ', description: '  ', instructions: '' });
    expect(toCreateBody(draft)).toEqual({
      name: 'Architect',
      description: null,
      scope: 'global',
      projectId: null,
      runtime: 'claude_code',
      instructions: null,
      permissions: { repository: { read: true, write: false, shell: false } },
    });
  });

  it('PATCH sends only what changed, and never scope', () => {
    const agent = readAgent({
      id: 'a1',
      name: 'Architect',
      description: null,
      scope: 'project',
      projectId: PROJECT,
      sessionId: null,
      runtime: 'claude_code',
      permissions: READ_ONLY,
      disallowedTools: [],
      instructions: 'old',
      archivedAt: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
    });
    if (agent === null) throw new Error('fixture');

    const baseline = toAgentDraft(agent);
    const draft = { ...baseline, [AGENT_FIELDS.name]: 'Architect II' };

    // `scope`/`projectId` are absent from the Backend's update schema, which is
    // `additionalProperties: false` — sending them is a 400, not a no-op.
    expect(toPatchBody(baseline, draft)).toEqual({ name: 'Architect II' });
    expect(toPatchBody(baseline, baseline)).toEqual({});
  });

  it('PATCH sends the whole permissions object when any switch moves', () => {
    const agent = readAgent(
      Object.assign(
        {},
        {
          id: 'a1',
          name: 'A',
          scope: 'global',
          runtime: 'claude_code',
          permissions: READ_ONLY,
          disallowedTools: [],
        },
      ),
    );
    if (agent === null) throw new Error('fixture');

    const baseline = toAgentDraft(agent);
    const draft = applyPermissionChange(baseline, 'repository.write', true);

    // A nested object in a PATCH is replaced rather than merged, so half a permissions document
    // would revoke everything it omitted.
    expect(toPatchBody(baseline, draft)['permissions']).toEqual({
      repository: { read: true, write: true, shell: false },
    });
  });

  it('archives through PATCH, because there is no delete route', () => {
    const agent = readAgent({
      id: 'a1',
      name: 'A',
      scope: 'global',
      runtime: 'claude_code',
      permissions: READ_ONLY,
      disallowedTools: [],
      archivedAt: null,
    });
    if (agent === null) throw new Error('fixture');

    const baseline = toAgentDraft(agent);
    expect(toPatchBody(baseline, { ...baseline, [AGENT_FIELDS.archived]: true })).toEqual({
      archived: true,
    });
  });
});

describe('readKnowledgeSources', () => {
  it('reports absence as absence, not as an empty picker', () => {
    expect(readKnowledgeSources({ id: 'a1' })).toEqual({
      served: false,
      field: null,
      preview: null,
    });
  });

  it('reports a field this build cannot edit, quoting its name', () => {
    const read = readKnowledgeSources({ id: 'a1', knowledge: ['docs/tds'] });
    expect(read.served).toBe(true);
    expect(read.field).toBe('knowledge');
    expect(read.preview).toBe('["docs/tds"]');
  });
});

const PROJECT = '0198a2f3-9c41-7bd2-a10e-000000000001';
