import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Toaster } from '../../../components/Toaster.js';
import { SocketProvider } from '../../../lib/ws/context.js';
import { SocketClient, type SocketLike } from '../../../lib/ws/socket-client.js';
import { useSocketStore } from '../../../stores/socket-store.js';
import { useToastStore } from '../../../stores/toast-store.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeAgent,
  makeProject,
  mockApi,
} from '../test-support.js';
import { AgentTeamPage } from './AgentTeamPage.js';
import { AgentTeamsPage } from './AgentTeamsPage.js';

/**
 * `/agents/teams` — PRD §5.7 agent teams.
 *
 * The suite is organised around the states this screen is actually in. On a fresh install it is
 * empty; on a Backend that predates the team slice it has no route at all — and those two look
 * identical if the screen is careless, while sending the reader somewhere completely different.
 *
 * The other thing worth a test of its own is the **archived member**, because it is the one rule an
 * operator cannot discover: `PATCH { agentIds }` replaces the whole roster and the Backend refuses
 * a roster containing an archived agent, so a team that has had a member retired cannot have *any*
 * roster change saved until that seat is dealt with. A screen that let the save go out would fail
 * on a seat the operator never touched.
 */

const TEAM_ID = '0198a2f3-9c41-7bd2-a10e-00000000t001';
const ARCHIVED_AGENT_ID = '0198a2f3-9c41-7bd2-a10e-00000000a009';

function makeTeam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEAM_ID,
    name: 'Feature squad',
    description: 'Product Owner, Architect, Developer, QA, Security.',
    scope: 'global',
    projectId: null,
    members: [],
    projectIds: [],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    ...overrides,
  };
}

function makeMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: '0198a2f3-9c41-7bd2-a10e-00000000a001',
    name: 'Architect',
    scope: 'global',
    projectId: null,
    runtime: 'claude_code',
    archivedAt: null,
    addedAt: '2026-08-02T09:00:00.000Z',
    ...overrides,
  };
}

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/api/v1/projects', { body: listBody([makeProject()]) });
  api.on('GET', '/api/v1/agents', { body: listBody([makeAgent()]) });
  api.on('GET', '/api/v1/agent-teams', { body: listBody([]) });
});

afterEach(() => {
  api.restore();
});

function renderTeams(initialPath = '/agents/teams') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  useToastStore.getState().clear();

  const client = new SocketClient({ socketFactory: () => inertSocket() });
  const router = createMemoryRouter(
    [
      { path: '/agents', element: <div>Agents screen</div> },
      { path: '/agents/teams', element: <AgentTeamsPage /> },
      { path: '/agents/teams/:teamId', element: <AgentTeamPage /> },
    ],
    { initialEntries: [initialPath] },
  );

  const result = render(
    <QueryClientProvider client={queryClient}>
      <SocketProvider client={client}>
        <RouterProvider router={router} />
      </SocketProvider>
      <Toaster />
    </QueryClientProvider>,
  );

  useSocketStore.getState().applySnapshot({
    state: 'open',
    attempt: 0,
    connectionId: 'test-connection',
    lastConnectedAt: Date.now(),
    lastFrameAt: Date.now(),
    nextAttemptAt: null,
    authFailed: false,
    channels: [],
  });

  return { ...result, router, queryClient };
}

function inertSocket(): SocketLike {
  return {
    readyState: 0,
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

describe('the empty state', () => {
  it('says there are no teams, and explains what one is for', async () => {
    renderTeams();

    expect(await screen.findByText('No teams yet.')).toBeInTheDocument();
    // The hint has to do the work PRD §5.7 does in two sentences: a team groups agents that
    // already exist, so the reader is not left thinking a team replaces them.
    expect(screen.getByText(/a team groups them, it does not replace them/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New team' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the agents' })).toBeInTheDocument();
  });

  it('names the missing route instead of showing an empty list', async () => {
    api.on('GET', '/api/v1/agent-teams', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'req-1' } },
    });
    renderTeams();

    expect(await screen.findByTestId('teams-route-missing')).toHaveTextContent(
      '/api/v1/agent-teams',
    );
    // No invitation to create something that would 404.
    expect(screen.queryByRole('button', { name: '+ New team' })).toBeNull();
    expect(screen.queryByText('No teams yet.')).toBeNull();
  });
});

describe('the list', () => {
  it('reports members, archived seats and assignment separately', async () => {
    api.on('GET', '/api/v1/agent-teams', {
      body: listBody([
        makeTeam({
          members: [
            makeMember(),
            makeMember({
              agentId: ARCHIVED_AGENT_ID,
              name: 'Retired One',
              archivedAt: '2026-08-11T00:00:00.000Z',
            }),
          ],
          projectIds: ['0198a2f3-9c41-7bd2-a10e-000000000001'],
        }),
      ]),
    });
    renderTeams();

    const row = (await screen.findByRole('link', { name: /Feature squad/ })).closest('tr');
    expect(row).not.toBeNull();
    // "2 members" alone would be a number that quietly stopped being true: one seat cannot be
    // filled, so the team offers one agent, not two.
    expect(within(row as HTMLElement).getByText(/2 members/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/1 archived/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('1 project')).toBeInTheDocument();
  });

  it('distinguishes "no projectIds served" from "assigned to nothing"', async () => {
    const { projectIds: _dropped, ...withoutAssignments } = makeTeam();
    api.on('GET', '/api/v1/agent-teams', { body: listBody([withoutAssignments]) });
    renderTeams();

    expect(await screen.findByText('not listed here')).toBeInTheDocument();
  });
});

describe('creating a team', () => {
  it('sends scope, roster and an empty assignment set', async () => {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/agent-teams', { status: 201, body: dataBody(makeTeam()) });
    api.on('GET', `/api/v1/agent-teams/${TEAM_ID}`, { body: dataBody(makeTeam()) });
    renderTeams();

    await user.click(await screen.findByRole('button', { name: '+ New team' }));
    // `/^Name/` rather than `'Name'`: the label carries the required marker, so its accessible
    // name is `Name *`.
    await user.type(screen.getByLabelText(/^Name/), 'Feature squad');
    await user.click(await screen.findByLabelText('Architect'));
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() =>
      expect(api.callsTo('/agent-teams').some((c) => c.method === 'POST')).toBe(true),
    );
    expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Feature squad',
      description: null,
      scope: 'global',
      projectId: null,
      agentIds: ['0198a2f3-9c41-7bd2-a10e-00000000a001'],
      projectIds: [],
    });
  });

  it('refuses a nameless team and says why the name matters', async () => {
    const user = userEvent.setup();
    renderTeams();

    await user.click(await screen.findByRole('button', { name: '+ New team' }));
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    expect(screen.getByTestId('team-issue-name')).toHaveTextContent('A team needs a name.');
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('the team detail', () => {
  it('shows scope as a fact, not a disabled control', async () => {
    api.on('GET', `/api/v1/agent-teams/${TEAM_ID}`, { body: dataBody(makeTeam()) });
    renderTeams(`/agents/teams/${TEAM_ID}`);

    const fact = await screen.findByTestId('team-scope-fact');
    expect(fact).toHaveTextContent('Global');
    expect(fact).toHaveTextContent('Scope is fixed once a team exists.');
    expect(within(fact).queryByRole('combobox')).toBeNull();
  });

  it('blocks a roster save while an archived member is still seated, and offers both exits', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/agents', {
      body: listBody([
        makeAgent(),
        makeAgent({
          id: ARCHIVED_AGENT_ID,
          name: 'Retired One',
          archivedAt: '2026-08-11T00:00:00.000Z',
        }),
      ]),
    });
    api.on('GET', `/api/v1/agent-teams/${TEAM_ID}`, {
      body: dataBody(
        makeTeam({
          members: [
            makeMember(),
            makeMember({
              agentId: ARCHIVED_AGENT_ID,
              name: 'Retired One',
              archivedAt: '2026-08-11T00:00:00.000Z',
            }),
          ],
        }),
      ),
    });
    renderTeams(`/agents/teams/${TEAM_ID}`);

    // The seat is shown rather than hidden — an operator cannot fix a gap they cannot see.
    const seats = await screen.findByTestId('roster-archived-members');
    expect(seats).toHaveTextContent('Retired One');
    expect(seats).toHaveTextContent('un-archived on the Agents screen');

    // Any roster change now surfaces the blocking issue, naming the seat the operator did not
    // touch — because the save would fail on it.
    await user.click(screen.getByLabelText('Architect'));
    expect(await screen.findByTestId('team-issue-agentIds')).toHaveTextContent(
      'Retired One is archived and still on this roster',
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    // Removing the seat is one of the two exits, and it unblocks the save.
    await user.click(within(seats).getByRole('button', { name: 'Remove from team' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  });

  it('PATCHes only the arrays that moved', async () => {
    const user = userEvent.setup();
    api.on('GET', `/api/v1/agent-teams/${TEAM_ID}`, {
      body: dataBody(makeTeam({ members: [makeMember()] })),
    });
    api.on('PATCH', `/api/v1/agent-teams/${TEAM_ID}`, { body: dataBody(makeTeam()) });
    renderTeams(`/agents/teams/${TEAM_ID}`);

    await user.click(await screen.findByLabelText('Architect'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true));
    // `name`, `description` and `projectIds` did not move, so they are not sent — a PATCH leaves
    // an omitted field alone, and sending the whole document would overwrite what was not shown.
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ agentIds: [] });
  });

  it('warns before a delete that the API will refuse', async () => {
    const user = userEvent.setup();
    api.on('GET', `/api/v1/agent-teams/${TEAM_ID}`, {
      body: dataBody(makeTeam({ projectIds: ['0198a2f3-9c41-7bd2-a10e-000000000001'] })),
    });
    renderTeams(`/agents/teams/${TEAM_ID}`);

    await user.click(await screen.findByTestId('team-delete'));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'The API refuses to delete an assigned team',
    );
  });
});
