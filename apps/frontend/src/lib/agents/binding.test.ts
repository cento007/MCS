import { describe, expect, it } from 'vitest';
import * as bindingModule from './binding.js';
import { bindingConsequence, sessionBindability } from './binding.js';
import type { AgentView } from './shape.js';
import { readAgent } from './shape.js';

/**
 * What is left of `binding.ts` once bindability became a server answer.
 *
 * The refusal rules this file used to assert — archived, other project, session-not-yet — are gone
 * from the client entirely. They are now `GET /projects/{id}/available-agents`'s answer, produced
 * by the same `agentBindingRefusal` the write path enforces, and read by
 * `availability.test.ts`. The guard against them coming back is the first test below.
 */

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

describe('no client-side rule decides bindability any more', () => {
  /**
   * A named assertion rather than a comment, because the failure it guards against is a *re-add*:
   * the cheapest way to make a picker behave is to filter it locally, and the whole point of this
   * change is that the local filter is what silently offered agents `POST /sessions` rejected.
   */
  it('exports no agent-refusal engine', () => {
    const surface = Object.keys(bindingModule);
    expect(surface).not.toContain('agentBindingRefusal');
    expect(surface).not.toContain('partitionAgentsForBinding');
    expect(surface.sort()).toEqual([
      'agentOptionLabel',
      'bindingConsequence',
      'sessionBindability',
    ]);
  });

  it('does not decide anything from an agent’s scope, project or archived state', () => {
    // Every input the deleted rules keyed on, on one agent. Nothing in this module reads them:
    // the only per-agent answer left is what the *Backend* said this agent removes.
    const retiredForeignSessionAgent = agent({
      scope: 'session',
      sessionId: 'some-other-session',
      archivedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(bindingConsequence(retiredForeignSessionAgent).kind).toBe('removes');
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
