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
 * The Agent picker in the Launch dialog (PRD §5.1, slice 2).
 *
 * Slice 1 made an agent's instructions the runtime's system prompt and its permissions the
 * runtime's `disallowedTools`. **None of it was reachable from a browser**: `agentId` appeared
 * nowhere in this feature and the hand-written `Session` type had no field for it, so an operator
 * could build an agent and never run one. This suite covers the four things that closing that loop
 * has to get right:
 *
 *  1. **None is the default**, and costs nothing — most sessions will not use an agent.
 *  2. **Only bindable agents are offered**, and every exclusion is stated with its rule. A dropdown
 *     that silently drops an agent generates "where did it go" and answers nothing.
 *  3. **The consequence is shown**, not just the name: binding an agent *removes tools*.
 *  4. **A choice invalidated by changing the project is withdrawn out loud**, not left to become a
 *     `400` on `[Create]`.
 */

const PROJECT_A = '0198a2f3-9c41-7bd2-a10e-000000000001';
const PROJECT_B = '0198a2f3-9c41-7bd2-a10e-000000000002';

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
    id: '0198a2f3-9c41-7bd2-a10e-00000000a001',
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
    ...overrides,
  };
}

let api: ApiMock;

function seed(agents: readonly unknown[]): void {
  api.on('GET', '/api/v1/agents', { body: listBody(agents) });
}

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/api/v1/projects?', { body: listBody(PROJECTS) });
  api.on('GET', '/api/v1/repositories', { body: listBody([]) });
  seed([]);
});

afterEach(() => {
  api.restore();
});

describe('the agent picker defaults to none', () => {
  it('opens on “None” and creates a session with no agentId at all', async () => {
    const user = userEvent.setup();
    seed([makeAgent()]);
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
    seed([makeAgent()]);
    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);

    const picker = await screen.findByLabelText('Agent');
    expect(picker).toBeDisabled();
    expect(screen.getByTestId('agent-field-disabled')).toHaveTextContent('Choose a project first');
  });
});

describe('only bindable agents are offered, and the rest are accounted for', () => {
  it('offers global and own-project agents; excludes the other three with their reasons', async () => {
    const user = userEvent.setup();
    seed([
      makeAgent({ id: 'a-global', name: 'Architect' }),
      makeAgent({ id: 'a-mine', name: 'ERP Architect', scope: 'project', projectId: PROJECT_A }),
      makeAgent({
        id: 'a-theirs',
        name: 'Other Architect',
        scope: 'project',
        projectId: PROJECT_B,
      }),
      makeAgent({ id: 'a-retired', name: 'Retired One', archivedAt: '2026-08-10T00:00:00.000Z' }),
      makeAgent({
        id: 'a-session',
        name: 'Release Manager',
        scope: 'session',
        sessionId: '0198a2f3-9c41-7bd2-a10e-0000000000s1',
      }),
    ]);

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    const picker = await screen.findByLabelText('Agent');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    expect(within(picker).getByRole('option', { name: /Architect · Global/ })).toBeInTheDocument();
    expect(
      within(picker).getByRole('option', { name: /ERP Architect · Project/ }),
    ).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Other Architect/ })).toBeNull();

    // The three that are missing are named, each with the rule that excluded it.
    const exclusions = screen.getByTestId('agent-exclusions');
    expect(exclusions).toHaveTextContent('3 agents are not offered here.');
    expect(screen.getByTestId('agent-excluded-other_project')).toHaveTextContent(
      'Scoped to a different project',
    );
    expect(screen.getByTestId('agent-excluded-archived')).toHaveTextContent('Un-archive it');
    expect(screen.getByTestId('agent-excluded-session_not_yet')).toHaveTextContent(
      'does not exist yet',
    );
  });

  it('names the missing route rather than showing an empty picker', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/agents', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'req-1' } },
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);

    expect(await screen.findByTestId('agent-route-missing')).toHaveTextContent('/api/v1/agents');
    // The session is still creatable — an agent was never required.
    expect(screen.getByLabelText('Agent')).toBeDisabled();
  });
});

describe('the consequence of the choice, not only its name', () => {
  it('names the tools the agent removes from this session', async () => {
    const user = userEvent.setup();
    seed([makeAgent()]);

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(
      await screen.findByLabelText('Agent'),
      '0198a2f3-9c41-7bd2-a10e-00000000a001',
    );

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
    seed([makeAgent({ disallowedTools: [] })]);

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(
      await screen.findByLabelText('Agent'),
      '0198a2f3-9c41-7bd2-a10e-00000000a001',
    );

    expect(screen.getByTestId('agent-consequence')).toHaveTextContent('It removes no tools');
  });

  it('never implies a restriction a Backend without disallowedTools did not state', async () => {
    const user = userEvent.setup();
    const { disallowedTools: _dropped, ...withoutTools } = makeAgent();
    seed([withoutTools]);

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(
      await screen.findByLabelText('Agent'),
      '0198a2f3-9c41-7bd2-a10e-00000000a001',
    );

    expect(screen.getByTestId('agent-consequence-unknown')).toHaveTextContent(
      'does not say which tools this agent removes',
    );
  });
});

describe('a choice the new project would reject is withdrawn, out loud', () => {
  it('clears a project-scoped agent when the project changes, and names the rule', async () => {
    const user = userEvent.setup();
    seed([
      makeAgent({ id: 'a-mine', name: 'ERP Architect', scope: 'project', projectId: PROJECT_A }),
    ]);

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.selectOptions(await screen.findByLabelText('Agent'), 'a-mine');
    expect(screen.getByTestId('agent-consequence')).toHaveTextContent('ERP Architect');

    await user.selectOptions(screen.getByLabelText('Project'), PROJECT_B);

    await waitFor(() => expect(screen.getByLabelText('Agent')).toHaveValue(''));
    expect(screen.getByTestId('agent-withdrawn')).toHaveTextContent('ERP Architect was cleared');
    expect(screen.getByTestId('agent-withdrawn')).toHaveTextContent(
      'Scoped to a different project',
    );
  });

  it('sends the chosen agent on create', async () => {
    const user = userEvent.setup();
    seed([makeAgent()]);
    api.on('POST', '/api/v1/sessions', {
      status: 201,
      body: dataBody(makeSession({ state: 'created' })),
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT_A);
    await user.type(screen.getByLabelText('Working directory'), 'D:\\Repos\\MCS');
    await user.selectOptions(
      await screen.findByLabelText('Agent'),
      '0198a2f3-9c41-7bd2-a10e-00000000a001',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
      projectId: PROJECT_A,
      workingDirectory: 'D:\\Repos\\MCS',
      agentId: '0198a2f3-9c41-7bd2-a10e-00000000a001',
    });
  });
});

describe('the project’s team leads the picker (PRD §5.7)', () => {
  it('groups the team’s agents first, under the team’s name', async () => {
    const user = userEvent.setup();
    seed([
      makeAgent({ id: 'a-one', name: 'Architect' }),
      makeAgent({ id: 'a-two', name: 'Security' }),
    ]);
    api.on('GET', '/available-agents', {
      body: dataBody({
        projectId: PROJECT_A,
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
        agents: [
          { ...makeAgent({ id: 'a-one' }), onTeam: true },
          { ...makeAgent({ id: 'a-two' }), onTeam: false },
        ],
      }),
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
