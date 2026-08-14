import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentLine } from './SessionAgent.js';
import { SessionsTable } from './SessionsTable.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
  SESSION_ID,
} from './test-support.js';

/**
 * "Which agent did this session run as?" (PRD §5.1).
 *
 * The reason this is on the identity surfaces rather than filed in a panel tab: a bound agent had
 * a system prompt appended and a set of tools removed, and **a denied tool leaves no trace in the
 * transcript** — it is a step the model simply did not take. A session whose agent is not stated is
 * a session whose behaviour cannot be explained afterwards, and "why did it not run the tests" has
 * two very different answers depending on whether `Bash` was in that session's deny list.
 */

const AGENT_ID = '0198a2f3-9c41-7bd2-a10e-00000000a001';

function agentResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT_ID,
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
  };
}

/** `makeSession`'s project — the one the bind dialog asks about. */
const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';

let api: ApiMock;

function seedAvailability(body: { agents?: readonly unknown[]; refused?: readonly unknown[] }) {
  api.on('GET', '/available-agents', {
    body: dataBody({
      projectId: PROJECT_ID,
      team: null,
      agents: body.agents ?? [],
      refused: body.refused ?? [],
    }),
  });
}

beforeEach(() => {
  api = mockApi();
  api.on('GET', `/api/v1/agents/${AGENT_ID}`, { body: dataBody(agentResource()) });
  api.on('GET', '/api/v1/agents?', { body: listBody([agentResource()]) });
  // The bind dialog offers what `GET /projects/{id}/available-agents` offers, and nothing else —
  // there is no client-side rule left that could widen or narrow it.
  seedAvailability({ agents: [{ ...agentResource(), onTeam: false }] });
});

afterEach(() => {
  api.restore();
});

describe('the session detail header states its agent', () => {
  it('names the agent and what it removed from the runtime', async () => {
    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'running', agentId: AGENT_ID })}
        onBind={() => {}}
        saving={false}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('session-agent-tag')).toHaveTextContent('Architect'),
    );
    const line = screen.getByTestId('session-agent-line');
    // The count leads; the names are capped so the header's identity block stays on one line.
    expect(line).toHaveTextContent('removes 3 tools (Bash, Edit, Write)');
    // Past `created`, the binding is a fact rather than a control — the runtime cannot be handed
    // another system prompt mid-conversation.
    expect(line).toHaveTextContent('fixed at launch');
    expect(screen.queryByTestId('session-agent-bind')).toBeNull();
  });

  it('keeps stating an agent that has since been archived, and says so', async () => {
    api.on('GET', `/api/v1/agents/${AGENT_ID}`, {
      body: dataBody(agentResource({ archivedAt: '2026-08-13T00:00:00.000Z' })),
    });

    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'completed', agentId: AGENT_ID })}
        onBind={() => {}}
        saving={false}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('session-agent-line')).toHaveTextContent('archived since'),
    );
  });

  it('renders nothing for a finished session that had no agent', () => {
    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'completed', agentId: null })}
        onBind={() => {}}
        saving={false}
      />,
    );
    expect(screen.queryByTestId('session-agent-line')).toBeNull();
  });

  it('offers a binding only while the session is `created`, and PATCHes agentId', async () => {
    const user = userEvent.setup();
    const onBind = vi.fn();

    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'created', agentId: null })}
        onBind={onBind}
        saving={false}
      />,
    );

    // With no agent yet, the line still exists — it is the affordance.
    expect(screen.getByTestId('session-agent-line')).toHaveTextContent('none — no persona');
    await user.click(screen.getByTestId('session-agent-bind'));

    await user.selectOptions(await screen.findByLabelText('Agent'), AGENT_ID);
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onBind).toHaveBeenCalledWith(AGENT_ID);
  });

  /**
   * Defensive, and no longer the ordinary case.
   *
   * This surface now asks `GET /projects/{id}/available-agents?sessionId=…` (see the test below),
   * so the Backend evaluates the rule against a Session that *exists*: an agent scoped to this one
   * is offered, and one scoped elsewhere comes back as `session_elsewhere`. A `session_not_yet`
   * arriving here therefore means the answer was computed for a different moment — an older
   * Backend, or a cache entry from the create-time question.
   *
   * The screen still refuses to reprint "that session does not exist yet" beside a Session the
   * operator is looking at, because that would be a confident falsehood. It states the gap and
   * does not re-derive a rule to close it.
   */
  it('does not reprint a create-time refusal at a session that exists', async () => {
    const user = userEvent.setup();
    seedAvailability({
      refused: [
        {
          agentId: 'a-session',
          name: 'Release Manager',
          scope: 'session',
          projectId: null,
          sessionId: 'some-session',
          runtime: 'claude_code',
          archivedAt: null,
          reason: 'session_not_yet',
          explanation:
            'A session-scoped agent names the session it belongs to, and that session does not ' +
            'exist yet. Create the session first, then bind this agent with PATCH /sessions/{id}.',
        },
      ],
    });

    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'created', agentId: null })}
        onBind={() => {}}
        saving={false}
      />,
    );
    await user.click(screen.getByTestId('session-agent-bind'));

    const row = await screen.findByTestId('agent-excluded-session_not_yet');
    expect(row).toHaveTextContent('Release Manager');
    expect(row).toHaveTextContent('cannot say whether this agent belongs to');
    expect(row).not.toHaveTextContent('does not exist yet');
  });

  /**
   * The parameter is the whole reason a session-scoped agent is bindable anywhere.
   *
   * Without `?sessionId=` the Backend answers the create-time question — "which agent may a *new*
   * session here be launched as" — and every session-scoped agent comes back `session_not_yet`,
   * including the one that names this very Session. That is a capability loss, not a cosmetic
   * one: this is the only surface where such an agent can be bound at all.
   *
   * Pinned as a request assertion rather than a rendering one because a dropped parameter is
   * invisible in the output — the screen would simply offer one agent fewer, which looks like an
   * answer rather than a question that was never asked.
   */
  it('asks about this session, not about a hypothetical new one', async () => {
    const user = userEvent.setup();
    seedAvailability({});

    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'created', agentId: null })}
        onBind={() => {}}
        saving={false}
      />,
    );
    await user.click(screen.getByTestId('session-agent-bind'));

    await waitFor(() => expect(api.callsTo('available-agents').length).toBeGreaterThan(0));
    const asked = api.callsTo('available-agents').at(-1);
    expect(asked?.url).toContain(`sessionId=${SESSION_ID}`);
  });

  it('refuses to offer a binding on an observed session', () => {
    renderWithProviders(
      <SessionAgentLine
        session={makeSession({ state: 'created', sessionType: 'observed', agentId: null })}
        onBind={() => {}}
        saving={false}
      />,
    );
    // Nothing at all: no agent, and none can be given, so there is nothing true to say.
    expect(screen.queryByTestId('session-agent-line')).toBeNull();
  });
});

describe('the sessions list marks a session that ran as an agent', () => {
  it('shows the agent chip on the bound row and nothing on the others', async () => {
    renderWithProviders(
      <SessionsTable
        mobile={false}
        onOpen={() => {}}
        sessions={[
          makeSession({ id: 's-1', agentId: AGENT_ID }),
          makeSession({ id: 's-2', agentId: null }),
        ]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('session-agent-tag')).toHaveTextContent('Architect'),
    );
    // The unbound row carries no chip at all — an absence that is already the default reading.
    expect(screen.getAllByTestId('session-agent-tag')).toHaveLength(1);
  });

  it('never reads as “unreadable” while the lookup is still in flight', async () => {
    // The failure this guards: the chip took `agent === null` to mean "could not be read", so
    // every bound row briefly claimed its agent was broken. That is a statement about the
    // operator's data made from a fact about the clock.
    renderWithProviders(
      <SessionsTable
        mobile={false}
        onOpen={() => {}}
        sessions={[makeSession({ id: 's-1', agentId: AGENT_ID })]}
      />,
    );

    expect(screen.getByTestId('session-agent-tag')).toHaveTextContent('…');
    await waitFor(() =>
      expect(screen.getByTestId('session-agent-tag')).toHaveTextContent('Architect'),
    );
  });

  it('makes no agents request at all when no row is bound', async () => {
    renderWithProviders(
      <SessionsTable
        mobile={false}
        onOpen={() => {}}
        sessions={[makeSession({ id: 's-2', agentId: null })]}
      />,
    );

    await waitFor(() => expect(screen.getByText('DEV')).toBeInTheDocument());
    expect(api.callsTo('/agents')).toHaveLength(0);
  });
});
