import { describe, expect, it } from 'vitest';
import {
  AGENT_BINDING_REFUSALS,
  type AgentBindingSubject,
  agentBindingRefusal,
} from './binding.js';

/**
 * `agentBindingRefusal` — **the one function** both the launch path and the availability read call.
 *
 * These cases are the contract that makes that claim worth anything. Each names the refusal, its
 * F5.4 code and the shape of `details`, because all three cross the seam: the write path turns them
 * into an `ApiError`, and the read publishes `reason` and `explanation` on
 * `GET /projects/{id}/available-agents`. Database-free and network-free by construction — the
 * function takes a row-shaped object and answers.
 */

const PROJECT_A = '018f2a00-0000-7000-8000-0000000000a1';
const PROJECT_B = '018f2a00-0000-7000-8000-0000000000b2';
const SESSION_A = '018f2a00-0000-7000-8000-0000000000c3';
const SESSION_B = '018f2a00-0000-7000-8000-0000000000d4';

function agent(overrides: Partial<AgentBindingSubject> = {}): AgentBindingSubject {
  return {
    id: '018f2a00-0000-7000-8000-0000000000e5',
    scope: 'global',
    projectId: null,
    sessionId: null,
    archivedAt: null,
    ...overrides,
  };
}

describe('agentBindingRefusal', () => {
  it('offers a live global agent in any project', () => {
    expect(agentBindingRefusal(agent(), { projectId: PROJECT_A, sessionId: null })).toBeNull();
    expect(agentBindingRefusal(agent(), { projectId: PROJECT_B, sessionId: SESSION_A })).toBeNull();
  });

  it('refuses an archived agent with CONFLICT — a state the operator can undo', () => {
    const refusal = agentBindingRefusal(agent({ archivedAt: new Date() }), {
      projectId: PROJECT_A,
      sessionId: null,
    });

    expect(refusal).toMatchObject({ reason: 'archived', code: 'CONFLICT' });
    expect(refusal?.details).toMatchObject({ field: 'agentId' });
    expect(refusal?.explanation).toContain('archived');
  });

  it('offers a project agent to its own project and refuses it everywhere else', () => {
    const projectAgent = agent({ scope: 'project', projectId: PROJECT_A });

    expect(agentBindingRefusal(projectAgent, { projectId: PROJECT_A, sessionId: null })).toBeNull();

    const refusal = agentBindingRefusal(projectAgent, { projectId: PROJECT_B, sessionId: null });
    expect(refusal).toMatchObject({ reason: 'other_project', code: 'VALIDATION_FAILED' });
    expect(refusal?.details).toMatchObject({ scope: 'project', agentProjectId: PROJECT_A });
  });

  it('refuses a project agent that names no project, and says which rule that breaks', () => {
    const refusal = agentBindingRefusal(agent({ scope: 'project', projectId: null }), {
      projectId: PROJECT_A,
      sessionId: null,
    });

    expect(refusal?.reason).toBe('project_unstated');
    // Named rather than reported as "a different project": there is no other project to name.
    expect(refusal?.explanation).toContain('ck_agents_scope_target');
  });

  it('separates "not yet" from "not here" for a session agent', () => {
    const sessionAgent = agent({ scope: 'session', sessionId: SESSION_A });

    // Create time: the Session does not exist, so this is temporary and PATCH is the way out.
    const atCreate = agentBindingRefusal(sessionAgent, { projectId: PROJECT_A, sessionId: null });
    expect(atCreate?.reason).toBe('session_not_yet');
    expect(atCreate?.explanation).toContain('PATCH /sessions/{id}');

    // The Session it names: bindable.
    expect(
      agentBindingRefusal(sessionAgent, { projectId: PROJECT_A, sessionId: SESSION_A }),
    ).toBeNull();

    // A different Session: permanent, and a different sentence.
    const elsewhere = agentBindingRefusal(sessionAgent, {
      projectId: PROJECT_A,
      sessionId: SESSION_B,
    });
    expect(elsewhere?.reason).toBe('session_elsewhere');
    expect(elsewhere?.details).toMatchObject({ scope: 'session', agentSessionId: SESSION_A });
  });

  it('does not refuse a scope this build does not recognise', () => {
    // The rule checks `project` and `session`; anything else is accepted by `resolveForSession`,
    // so refusing it in the read would hide an option the API takes.
    expect(
      agentBindingRefusal(agent({ scope: 'workspace' }), { projectId: PROJECT_A, sessionId: null }),
    ).toBeNull();
  });

  it('gives every declared reason a sentence, and declares every reason it gives', () => {
    const produced = new Set<string>();
    const cases: readonly AgentBindingSubject[] = [
      agent({ archivedAt: new Date() }),
      agent({ scope: 'project', projectId: null }),
      agent({ scope: 'project', projectId: PROJECT_B }),
      agent({ scope: 'session', sessionId: SESSION_A }),
    ];

    for (const subject of cases) {
      const atCreate = agentBindingRefusal(subject, { projectId: PROJECT_A, sessionId: null });
      const withSession = agentBindingRefusal(subject, {
        projectId: PROJECT_A,
        sessionId: SESSION_B,
      });
      for (const refusal of [atCreate, withSession]) {
        if (refusal === null) continue;
        produced.add(refusal.reason);
        // Operator-facing means a sentence, not a code word.
        expect(refusal.explanation.length).toBeGreaterThan(40);
        expect(refusal.details['field']).toBe('agentId');
      }
    }

    // The array the response schema publishes is exactly what the function can answer — a sixth
    // refusal added without its enum entry fails here rather than reaching a picker.
    expect([...produced].sort()).toEqual([...AGENT_BINDING_REFUSALS].sort());
  });
});
