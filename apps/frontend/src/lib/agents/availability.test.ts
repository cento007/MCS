import { describe, expect, it } from 'vitest';
import { readProjectAgentAvailability } from './availability.js';

/**
 * Reading the Backend's bindability answer, with no DOM and no network.
 *
 * What is under test is **not** whether the rules are right — they are one function in
 * `apps/backend/src/agents/binding.ts`, called by the read that produces this document and by the
 * write path that enforces it. It is whether this client reads that answer without improving on
 * it, and whether it can tell "not offered" apart from "not told".
 */

const PROJECT_A = '0198a2f3-9c41-7bd2-a10e-000000000001';

function availableAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '0198a2f3-9c41-7bd2-a10e-00000000a001',
    name: 'Architect',
    description: null,
    scope: 'global',
    projectId: null,
    sessionId: null,
    runtime: 'claude_code',
    permissions: { repository: { read: true, write: false, shell: false } },
    disallowedTools: ['Bash'],
    instructions: 'You are the Architect.',
    archivedAt: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    onTeam: false,
    ...overrides,
  };
}

/** The `RefusedAgent` resource, exactly as `serializeRefusedAgent` emits it. */
function refusedAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: '0198a2f3-9c41-7bd2-a10e-00000000a009',
    name: 'Other Architect',
    scope: 'project',
    projectId: '0198a2f3-9c41-7bd2-a10e-000000000002',
    sessionId: null,
    runtime: 'claude_code',
    archivedAt: null,
    reason: 'other_project',
    explanation:
      'This agent is scoped to a different project than the session. A project agent is offered ' +
      'to its own project and nowhere else, and scope cannot be changed after an agent is created.',
    ...overrides,
  };
}

function document(overrides: Record<string, unknown> = {}): unknown {
  return { projectId: PROJECT_A, team: null, agents: [], refused: [], ...overrides };
}

describe('the offered set is the server’s, read and not filtered', () => {
  it('offers what the document offers, and carries the team flag through', () => {
    const read = readProjectAgentAvailability(
      document({
        agents: [
          availableAgent({ id: 'a-one', name: 'Architect', onTeam: true }),
          availableAgent({ id: 'a-two', name: 'Security' }),
        ],
      }),
    );

    expect(read.offered.map((entry) => entry.agent.name)).toEqual(['Architect', 'Security']);
    expect(read.offered.map((entry) => entry.onTeam)).toEqual([true, false]);
  });

  it('offers an archived, session-scoped, foreign-project agent if the server offers it', () => {
    /*
     * The single most important assertion in this file. Every one of these fields was an input to
     * a client-side refusal a fortnight ago; none of them is consulted now. If a future change
     * re-adds a local filter "for safety", this fails — which is the whole point, because the
     * client cannot know what a newer Backend permits.
     */
    const read = readProjectAgentAvailability(
      document({
        agents: [
          availableAgent({
            id: 'a-impossible',
            name: 'Impossible',
            scope: 'session',
            sessionId: 'some-other-session',
            archivedAt: '2026-08-10T00:00:00.000Z',
          }),
        ],
      }),
    );

    expect(read.offered).toHaveLength(1);
    expect(read.offered[0]?.agent.name).toBe('Impossible');
  });

  it('counts a row it cannot identify instead of rendering it blank', () => {
    const read = readProjectAgentAvailability(
      document({ agents: [availableAgent(), { name: 'no id here' }] }),
    );
    expect(read.offered).toHaveLength(1);
    expect(read.unreadable).toBe(1);
  });
});

describe('every absence is named, in the server’s own words', () => {
  it('reads the refusal reason and its sentence verbatim', () => {
    const read = readProjectAgentAvailability(
      document({
        refused: [
          refusedAgent(),
          refusedAgent({
            agentId: 'a-retired',
            name: 'Retired One',
            reason: 'archived',
            explanation:
              'This agent is archived and cannot be bound to a session. Un-archive it on the ' +
              'Agents screen if it should still be used.',
          }),
        ],
      }),
    );

    expect(read.refusalsStated).toBe(true);
    expect(read.refused.map((entry) => entry.reason)).toEqual(['other_project', 'archived']);
    // Not paraphrased, not re-cased, not truncated — the same string the API's 400/409 carries.
    expect(read.refused[0]?.explanation).toContain('scoped to a different project');
    expect(read.refused[1]?.explanation).toContain('Un-archive it');
  });

  it('keeps `session_not_yet` distinct rather than flattening it into "unavailable"', () => {
    const read = readProjectAgentAvailability(
      document({
        refused: [
          refusedAgent({
            agentId: 'a-session',
            name: 'Release Manager',
            scope: 'session',
            projectId: null,
            sessionId: '0198a2f3-9c41-7bd2-a10e-0000000000s1',
            reason: 'session_not_yet',
            explanation:
              'A session-scoped agent names the session it belongs to, and that session does not ' +
              'exist yet. Create the session first, then bind this agent with PATCH ' +
              '/sessions/{id} while it is still in ‹created›.',
          }),
        ],
      }),
    );

    // "not yet" and "not here" are different instructions, and only one of them has a way out.
    expect(read.refused[0]?.reason).toBe('session_not_yet');
    expect(read.refused[0]?.explanation).toContain('PATCH /sessions/{id}');
  });

  it('counts a refusal it cannot name rather than showing a blank bullet', () => {
    const { name: _dropped, ...nameless } = refusedAgent();
    const read = readProjectAgentAvailability(document({ refused: [refusedAgent(), nameless] }));
    expect(read.refused).toHaveLength(1);
    expect(read.unreadable).toBe(1);
  });
});

describe('“cannot tell” is a different answer from “nothing was refused”', () => {
  it('treats an empty `refused` array as an answer', () => {
    const read = readProjectAgentAvailability(document({ agents: [availableAgent()] }));
    expect(read.refusalsStated).toBe(true);
    expect(read.refused).toEqual([]);
  });

  it('treats a missing `refused` key as no answer at all', () => {
    // A Backend that serves availability without stating its refusals. The offer set is still its
    // answer, so the picker keeps working — but nothing can account for what is missing from it,
    // and reporting that as "nothing was refused" would be an invented fact.
    const { refused: _absent, ...withoutRefusals } = document() as Record<string, unknown>;
    const read = readProjectAgentAvailability({
      ...withoutRefusals,
      agents: [availableAgent()],
    });

    expect(read.refusalsStated).toBe(false);
    expect(read.refused).toEqual([]);
    expect(read.offered).toHaveLength(1);
  });

  it('names a document field it does not read, so a rename is visible rather than silent', () => {
    const { refused: _absent, ...withoutRefusals } = document() as Record<string, unknown>;
    const read = readProjectAgentAvailability({ ...withoutRefusals, refusedAgents: [] });

    expect(read.refusalsStated).toBe(false);
    expect(read.unrecognised).toEqual(['refusedAgents']);
  });

  it('answers nothing at all for a body that is not a document', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      const read = readProjectAgentAvailability(body);
      expect(read.offered).toEqual([]);
      expect(read.refusalsStated).toBe(false);
    }
  });
});

describe('the team block', () => {
  it('reads the name and the archived-seat count that explains a short group', () => {
    const read = readProjectAgentAvailability(
      document({
        team: {
          id: 't1',
          name: 'Feature squad',
          description: null,
          scope: 'global',
          projectId: null,
          memberCount: 5,
          archivedMemberCount: 1,
          assignedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    );

    expect(read.team).toEqual({ name: 'Feature squad', archivedMemberCount: 1 });
  });

  it('is null when no team is assigned, which is not an error', () => {
    expect(readProjectAgentAvailability(document()).team).toBeNull();
  });
});
