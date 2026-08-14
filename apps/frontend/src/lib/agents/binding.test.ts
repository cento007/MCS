import { describe, expect, it } from 'vitest';
import {
  agentBindingRefusal,
  bindingConsequence,
  partitionAgentsForBinding,
  sessionBindability,
} from './binding.js';
import type { AgentView } from './shape.js';
import { readAgent } from './shape.js';

/**
 * Which agents a Session may be bound to, asserted with no DOM.
 *
 * What is under test is not whether the Backend's rules hold — they are enforced in
 * `apps/backend/src/agents/binding.ts` and in the database. It is whether this client **refuses the
 * same things the server does, and can say why**. A picker that offers a choice the API rejects
 * turns a design rule into a `400` the operator has to reverse-engineer; a picker that silently
 * drops an agent turns it into a mystery.
 */

const PROJECT_A = '0198a2f3-9c41-7bd2-a10e-000000000001';
const PROJECT_B = '0198a2f3-9c41-7bd2-a10e-000000000002';
const SESSION_A = '0198a2f3-9c41-7bd2-a10e-0000000000s1';
const SESSION_B = '0198a2f3-9c41-7bd2-a10e-0000000000s2';

function agent(overrides: Record<string, unknown> = {}): AgentView {
  const view = readAgent({
    id: `agent-${overrides['name'] ?? 'x'}`,
    name: 'Architect',
    description: '',
    scope: 'global',
    projectId: null,
    sessionId: null,
    runtime: 'claude_code',
    permissions: { repository: { read: true, write: false, shell: false } },
    disallowedTools: ['Bash', 'Edit', 'Write'],
    instructions: 'You are the Architect.',
    archivedAt: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  });
  if (view === null) throw new Error('fixture is not a readable agent');
  return view;
}

describe('agentBindingRefusal — the four refusals, transcribed from the Backend', () => {
  it('offers a global agent at create time', () => {
    expect(agentBindingRefusal(agent(), { projectId: PROJECT_A, sessionId: null })).toBeNull();
  });

  it('refuses an archived agent, and names the way back', () => {
    const refusal = agentBindingRefusal(agent({ archivedAt: '2026-08-10T00:00:00.000Z' }), {
      projectId: PROJECT_A,
      sessionId: null,
    });
    expect(refusal?.reason).toBe('archived');
    expect(refusal?.explanation).toContain('Un-archive it');
  });

  it('offers a project agent to its own project and refuses it to another', () => {
    const projectAgent = agent({ scope: 'project', projectId: PROJECT_A });

    expect(agentBindingRefusal(projectAgent, { projectId: PROJECT_A, sessionId: null })).toBeNull();

    const refusal = agentBindingRefusal(projectAgent, { projectId: PROJECT_B, sessionId: null });
    expect(refusal?.reason).toBe('other_project');
    expect(refusal?.explanation).toContain('different project');
  });

  it('distinguishes "no project chosen yet" from "wrong project"', () => {
    const refusal = agentBindingRefusal(agent({ scope: 'project', projectId: PROJECT_A }), {
      projectId: null,
      sessionId: null,
    });
    // Two different instructions: one says pick a project, the other says pick another agent.
    expect(refusal?.reason).toBe('project_unknown');
    expect(refusal?.explanation).toContain('Choose the session’s project first');
  });

  it('refuses a session agent at create time, and points at the surface that can bind it', () => {
    const refusal = agentBindingRefusal(agent({ scope: 'session', sessionId: SESSION_A }), {
      projectId: PROJECT_A,
      sessionId: null,
    });
    expect(refusal?.reason).toBe('session_not_yet');
    expect(refusal?.explanation).toContain('does not exist yet');
  });

  it('offers a session agent to its own session and refuses it to another', () => {
    const sessionAgent = agent({ scope: 'session', sessionId: SESSION_A });

    expect(
      agentBindingRefusal(sessionAgent, { projectId: PROJECT_A, sessionId: SESSION_A }),
    ).toBeNull();
    expect(
      agentBindingRefusal(sessionAgent, { projectId: PROJECT_A, sessionId: SESSION_B })?.reason,
    ).toBe('session_elsewhere');
  });

  it('offers an agent whose scope this build does not recognise, with a caveat', () => {
    // The Backend checks only `project` and `session`, so it would accept this binding. Hiding an
    // option the API accepts is the same category of lie as offering one it refuses.
    const { offerable } = partitionAgentsForBinding([agent({ scope: 'workspace' })], {
      projectId: PROJECT_A,
      sessionId: null,
    });
    expect(offerable).toHaveLength(1);
    expect(offerable[0]?.caveat).toContain('workspace');
  });
});

describe('partitionAgentsForBinding', () => {
  it('accounts for every agent — nothing disappears without a reason', () => {
    const agents = [
      agent({ name: 'Global' }),
      agent({ name: 'Mine', scope: 'project', projectId: PROJECT_A }),
      agent({ name: 'Theirs', scope: 'project', projectId: PROJECT_B }),
      agent({ name: 'Retired', archivedAt: '2026-08-10T00:00:00.000Z' }),
      agent({ name: 'Ephemeral', scope: 'session', sessionId: SESSION_A }),
    ];

    const { offerable, excluded } = partitionAgentsForBinding(agents, {
      projectId: PROJECT_A,
      sessionId: null,
    });

    expect(offerable).toHaveLength(2);
    expect(excluded).toHaveLength(3);
    expect(offerable.length + excluded.length).toBe(agents.length);
    expect(excluded.map((entry) => entry.reason)).toEqual([
      'other_project',
      'archived',
      'session_not_yet',
    ]);
    // Every exclusion carries a sentence, not just a code.
    for (const entry of excluded) expect(entry.explanation.length).toBeGreaterThan(20);
  });
});

describe('bindingConsequence — what the operator is told before pressing Create', () => {
  it('names the tools the agent removes, verbatim from the Backend', () => {
    const consequence = bindingConsequence(agent());
    expect(consequence.kind).toBe('removes');
    expect(consequence.tools).toEqual(['Bash', 'Edit', 'Write']);
    expect(consequence.hasPrompt).toBe(true);
  });

  it('says "removes nothing" rather than staying silent for a fully-granted agent', () => {
    expect(bindingConsequence(agent({ disallowedTools: [] })).kind).toBe('removes_nothing');
  });

  it('never claims a restriction the Backend did not state', () => {
    // A Backend that predates `disallowedTools`. Under-claiming makes an operator careful.
    const { disallowedTools: _dropped, ...rest } = {
      disallowedTools: [],
      scope: 'global',
    } as Record<string, unknown>;
    const withoutTools = readAgent({
      id: 'a1',
      name: 'Architect',
      permissions: { repository: { read: true, write: true, shell: true } },
      instructions: null,
      ...rest,
    });
    expect(withoutTools).not.toBeNull();
    const consequence = bindingConsequence(withoutTools as AgentView);
    expect(consequence.kind).toBe('not_stated');
    expect(consequence.hasPrompt).toBe(false);
  });
});

describe('sessionBindability — when an existing Session still accepts an agent', () => {
  it('accepts a managed session in `created`', () => {
    expect(sessionBindability({ sessionType: 'managed', state: 'created' })).toEqual({
      bindable: true,
      reason: null,
    });
  });

  it('refuses an observed session, because Mission Control did not launch the process', () => {
    const result = sessionBindability({ sessionType: 'observed', state: 'created' });
    expect(result.bindable).toBe(false);
    expect(result.reason).toContain('observed');
  });

  it('refuses a session past `created`, because the system prompt is fixed at spawn', () => {
    for (const state of ['running', 'paused', 'completed', 'failed', 'archived']) {
      const result = sessionBindability({ sessionType: 'managed', state });
      expect(result.bindable).toBe(false);
      expect(result.reason).toContain(state);
    }
  });
});
