import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchSessionModal } from './LaunchSessionModal.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
} from './test-support.js';

/**
 * The Agent picker in the Launch dialog (PRD §5.1).
 *
 * ## What changed under this suite
 *
 * The picker used to read every agent (`GET /agents?limit=200&includeArchived=true`) and decide
 * locally which ones could be bound, from a hand-written copy of the Backend's refusals. It now
 * reads **one document** — `GET /projects/{id}/available-agents` — which carries the offer set,
 * the Project's team, and every refused agent with the Backend's own sentence attached. So these
 * tests no longer seed agents and assert a partition; they seed a *server answer* and assert the
 * screen renders it without editing it.
 *
 * Five things have to keep being true:
 *
 *  1. **None is the default**, and costs nothing — most sessions will not use an agent.
 *  2. **The server's offer set is the offer set**, and no client rule narrows it.
 *  3. **Every absence is named, in the server's words** — the same string its `400`/`409` carries.
 *  4. **"Cannot tell" is not "nothing"** — four distinct silences, told apart.
 *  5. **The consequence is shown**, not just the name: binding an agent *removes tools*.
 */

const PROJECT_A = '0198a2f3-9c41-7bd2-a10e-000000000001';
const PROJECT_B = '0198a2f3-9c41-7bd2-a10e-000000000002';
const AGENT_ID = '0198a2f3-9c41-7bd2-a10e-00000000a001';

const PROJECTS = [
  {
    id: PROJECT_A,
    workspaceId: '0198a2f3-9c41-7bd2-a10e-00000000000f',
    name: 'mission-control',
    description: null,
    workflowMode: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
  },
  {
    id: PROJECT_B,
    workspaceId: '0198a2f3-9c41-7bd2-a10e-00000000000f',
    name: 'erp-core',
    description: null,
    workflowMode: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
  },
];

function makeAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT_ID,
    name: 'Architect',
    description: 'Reviews designs against the Foundation Contract.',
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
    onTeam: false,
    ...overrides,
  };
}

function makeRefusal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'a-theirs',
    name: 'Other Architect',
    scope: 'project',
    projectId: PROJECT_B,
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

let api: ApiMock;

/** Seed `GET /projects/{id}/available-agents`, per project. */
function seedAvailability(
  projectId: string,
  body: {
    agents?: readonly unknown[];
    refused?: readonly unknown[];
    team?: unknown;
    omitRefused?: boolean;
  } = {},
): void {
  const document: Record<string, unknown> = {
    projectId,
    team: body.team ?? null,
    agents: body.agents ?? [],
  };
  if (body.omitRefused !== true) document['refused'] = body.refused ?? [];
  api.on('GET', `/projects/${projectId}/available-agents`, { body: dataBody(document) });
}

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/api/v1/projects?', { body: listBody(PROJECTS) });
  api.on('GET', '/api/v1/repositories', { body: listBody([]) });
  seedAvailability(PROJECT_A);
  seedAvailability(PROJECT_B);
});

afterEach(() => {
  api.restore();
});

describe('the agent picker defaults to none', () => {
  it('opens on “None” and creates a session with no agentId at all', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, { agents: [makeAgent()] });
    api.on('POST', '/api/v1/sessions', {
      status: 201,
      body: dataBody(makeSession({ state: 'created' })),
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.type(screen.getByLabelText('Working directory'), 'D:\\Repos\\MCS');

    const picker = await screen.findByLabelText('Agent');
    expect(picker).toHaveValue('');
    expect(screen.getByTestId('agent-none-note')).toHaveTextContent('No persona');

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.callsTo('/sessions').length).toBeGreaterThan(0));
    const created = api.calls.find((call) => call.method === 'POST');
    // Not `agentId: ''` and not `agentId: null` — the key is simply absent. `POST /sessions`
    // patterns the field as a UUID, so an empty string is a 400 for the most common case there is.
    expect(created?.body).toEqual({
      projectId: PROJECT_A,
      workingDirectory: 'D:\\Repos\\MCS',
    });
  });

  it('is inert until a project is chosen, and says why', async () => {
    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);

    const picker = await screen.findByLabelText('Agent');
    expect(picker).toBeDisabled();
    expect(screen.getByTestId('agent-field-disabled')).toHaveTextContent('Choose a project first');
    // Nothing was asked, so nothing is claimed about which agents exist.
    expect(api.callsTo('available-agents')).toHaveLength(0);
  });
});

describe('the server decides what is offered, and this screen does not narrow it', () => {
  it('offers exactly the agents the document offers', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, {
      agents: [
        makeAgent({ id: 'a-global', name: 'Architect' }),
        makeAgent({ id: 'a-mine', name: 'ERP Architect', scope: 'project', projectId: PROJECT_A }),
      ],
      refused: [
        makeRefusal(),
        makeRefusal({
          agentId: 'a-retired',
          name: 'Retired One',
          scope: 'global',
          projectId: null,
          archivedAt: '2026-08-10T00:00:00.000Z',
          reason: 'archived',
          explanation:
            'This agent is archived and cannot be bound to a session. Un-archive it on the ' +
            'Agents screen if it should still be used.',
        }),
        makeRefusal({
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
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    const picker = await screen.findByLabelText('Agent');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    expect(within(picker).getByRole('option', { name: /Architect · Global/ })).toBeInTheDocument();
    expect(
      within(picker).getByRole('option', { name: /ERP Architect · Project/ }),
    ).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Other Architect/ })).toBeNull();

    // The three that are missing are named, each with the Backend's own sentence.
    const exclusions = screen.getByTestId('agent-exclusions');
    expect(exclusions).toHaveTextContent('3 agents are not offered here.');
    expect(screen.getByTestId('agent-excluded-other_project')).toHaveTextContent(
      'scoped to a different project',
    );
    expect(screen.getByTestId('agent-excluded-archived')).toHaveTextContent('Un-archive it');
    expect(screen.getByTestId('agent-excluded-session_not_yet')).toHaveTextContent(
      'does not exist yet',
    );
    // The one refusal with a way out keeps naming it — create-time versus PATCH is the whole
    // reason these explanations exist.
    expect(screen.getByTestId('agent-excluded-session_not_yet')).toHaveTextContent(
      'PATCH /sessions/{id}',
    );
  });

  it('offers an agent no client rule would have offered', async () => {
    const user = userEvent.setup();
    /*
     * Archived, session-scoped and pointed at a different session — every input the deleted
     * client-side rules keyed on, on one agent the server nonetheless put in `agents`. A picker
     * that still held those rules would drop it. This one offers it, because the server's answer
     * is the answer.
     */
    seedAvailability(PROJECT_A, {
      agents: [
        makeAgent({
          id: 'a-impossible',
          name: 'Impossible',
          scope: 'session',
          sessionId: 'some-other-session',
          archivedAt: '2026-08-10T00:00:00.000Z',
        }),
      ],
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    const picker = await screen.findByLabelText('Agent');
    await waitFor(() =>
      expect(within(picker).getByRole('option', { name: /Impossible/ })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('agent-exclusions')).toBeNull();
  });

  it('reads no agent list of its own — one document answers the whole field', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, { agents: [makeAgent()] });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await screen.findByRole('option', { name: /Architect · Global/ });

    // `GET /agents` is for *naming* an agent a Session already ran as. Reading it here is how the
    // client ended up with enough data to re-derive a rule it should be asking about.
    expect(api.calls.filter((call) => /\/api\/v1\/agents(\?|$)/.test(call.url))).toHaveLength(0);
    expect(api.callsTo(`/projects/${PROJECT_A}/available-agents`).length).toBeGreaterThan(0);
  });
});

describe('where the server cannot tell, the screen says so rather than guessing', () => {
  it('names the missing route rather than showing an empty picker', async () => {
    const user = userEvent.setup();
    api.on('GET', `/projects/${PROJECT_A}/available-agents`, {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'req-1' } },
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    expect(await screen.findByTestId('agent-route-missing')).toHaveTextContent('available-agents');
    // The session is still creatable — an agent was never required.
    expect(screen.getByLabelText('Agent')).toBeDisabled();
    expect(screen.queryByTestId('agent-exclusions')).toBeNull();
  });

  it('distinguishes a failed read from an empty one', async () => {
    const user = userEvent.setup();
    api.on('GET', `/projects/${PROJECT_A}/available-agents`, {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'req-2' } },
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    expect(await screen.findByTestId('agent-field-error')).toHaveTextContent(
      'no absence can be explained',
    );
    expect(screen.getByLabelText('Agent')).toBeDisabled();
  });

  it('admits it cannot account for absences when the document states no refusals', async () => {
    const user = userEvent.setup();
    // A Backend that serves availability without a `refused` array. The offer set is still its
    // answer, so the field works — but "3 agents are not offered here" would be a claim this
    // client has no source for, and "nothing was refused" would be worse.
    seedAvailability(PROJECT_A, { agents: [makeAgent()], omitRefused: true });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    expect(await screen.findByTestId('agent-refusals-unstated')).toHaveTextContent(
      'does not say which agents it left out',
    );
    expect(screen.queryByTestId('agent-exclusions')).toBeNull();
    // The offer is still made: this is a gap in the explanation, not in the answer.
    expect(
      within(screen.getByLabelText('Agent')).getByRole('option', { name: /Architect/ }),
    ).toBeInTheDocument();
  });

  it('names a document field it does not read, so a renamed contract is visible', async () => {
    const user = userEvent.setup();
    api.on('GET', `/projects/${PROJECT_A}/available-agents`, {
      body: dataBody({
        projectId: PROJECT_A,
        team: null,
        agents: [makeAgent()],
        refusedAgents: [makeRefusal()],
      }),
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    expect(await screen.findByTestId('agent-availability-unrecognised')).toHaveTextContent(
      'refusedAgents',
    );
    expect(screen.getByTestId('agent-refusals-unstated')).toBeInTheDocument();
  });
});

describe('the consequence of the choice, not only its name', () => {
  it('names the tools the agent removes from this session', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, { agents: [makeAgent()] });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), AGENT_ID);

    const consequence = screen.getByTestId('agent-consequence');
    expect(consequence).toHaveTextContent('This session will run as Architect');
    expect(consequence).toHaveTextContent('appended to Claude Code’s own system prompt');
    expect(
      within(consequence)
        .getAllByTestId('agent-removed-tool')
        .map((n) => n.textContent),
    ).toEqual(['Bash', 'Edit', 'Write']);
  });

  it('says nothing is removed rather than staying silent for an unrestricted agent', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, { agents: [makeAgent({ disallowedTools: [] })] });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), AGENT_ID);

    expect(screen.getByTestId('agent-consequence')).toHaveTextContent('It removes no tools');
  });

  it('never implies a restriction a Backend without disallowedTools did not state', async () => {
    const user = userEvent.setup();
    const { disallowedTools: _dropped, ...withoutTools } = makeAgent();
    seedAvailability(PROJECT_A, { agents: [withoutTools] });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), AGENT_ID);

    expect(screen.getByTestId('agent-consequence-unknown')).toHaveTextContent(
      'does not say which tools this agent removes',
    );
  });
});

describe('a choice the new project would reject is withdrawn, out loud', () => {
  it('clears a project-scoped agent when the project changes, using the server’s reason', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, {
      agents: [
        makeAgent({ id: 'a-mine', name: 'ERP Architect', scope: 'project', projectId: PROJECT_A }),
      ],
    });
    seedAvailability(PROJECT_B, {
      refused: [makeRefusal({ agentId: 'a-mine', name: 'ERP Architect', projectId: PROJECT_A })],
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), 'a-mine');
    expect(screen.getByTestId('agent-consequence')).toHaveTextContent('ERP Architect');

    await user.selectOptions(screen.getByLabelText('Project'), PROJECT_B);

    await waitFor(() => expect(screen.getByLabelText('Agent')).toHaveValue(''));
    expect(screen.getByTestId('agent-withdrawn')).toHaveTextContent('ERP Architect was cleared');
    expect(screen.getByTestId('agent-withdrawn')).toHaveTextContent(
      'scoped to a different project',
    );
  });

  it('withdraws honestly when the new project’s document does not explain the absence', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, {
      agents: [
        makeAgent({ id: 'a-mine', name: 'ERP Architect', scope: 'project', projectId: PROJECT_A }),
      ],
    });
    seedAvailability(PROJECT_B, { omitRefused: true });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), 'a-mine');
    await user.selectOptions(screen.getByLabelText('Project'), PROJECT_B);

    await waitFor(() => expect(screen.getByLabelText('Agent')).toHaveValue(''));
    // Named from the selection, not invented; and the reason is admitted rather than composed.
    expect(screen.getByTestId('agent-withdrawn')).toHaveTextContent('ERP Architect was cleared');
    expect(screen.getByTestId('agent-withdrawn')).toHaveTextContent('did not say why');
  });

  it('does not withdraw a choice while the new project’s read is still failing', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, { agents: [makeAgent({ id: 'a-global', name: 'Architect' })] });
    api.on('GET', `/projects/${PROJECT_B}/available-agents`, {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'req-3' } },
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), 'a-global');
    await user.selectOptions(screen.getByLabelText('Project'), PROJECT_B);

    // A read that failed is not a refusal. Clearing here would discard a deliberate choice on the
    // strength of a question nobody answered.
    expect(await screen.findByTestId('agent-field-error')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-withdrawn')).toBeNull();
  });

  it('sends the chosen agent on create', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, { agents: [makeAgent()] });
    api.on('POST', '/api/v1/sessions', {
      status: 201,
      body: dataBody(makeSession({ state: 'created' })),
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.type(screen.getByLabelText('Working directory'), 'D:\\Repos\\MCS');
    await user.selectOptions(await screen.findByLabelText('Agent'), AGENT_ID);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
      projectId: PROJECT_A,
      workingDirectory: 'D:\\Repos\\MCS',
      agentId: AGENT_ID,
    });
  });
});

describe('the project’s team leads the picker (PRD §5.7)', () => {
  it('groups the team’s agents first, under the team’s name', async () => {
    const user = userEvent.setup();
    seedAvailability(PROJECT_A, {
      agents: [
        makeAgent({ id: 'a-one', name: 'Architect', onTeam: true }),
        makeAgent({ id: 'a-two', name: 'Security', onTeam: false }),
      ],
      team: {
        id: 't1',
        name: 'Feature squad',
        description: null,
        scope: 'global',
        projectId: null,
        memberCount: 2,
        archivedMemberCount: 1,
        assignedAt: '2026-08-01T00:00:00.000Z',
      },
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    const picker = await screen.findByLabelText('Agent');
    await waitFor(() =>
      expect(picker.querySelector('optgroup')?.getAttribute('label')).toBe(
        'Feature squad (this project’s team)',
      ),
    );
    // The seat that cannot be offered is stated rather than leaving the group quietly short.
    expect(screen.getByTestId('agent-team-archived')).toHaveTextContent(
      '1 of Feature squad’s seats',
    );
  });
});
