import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ID,
  type ApiMock,
  listBody,
  makeAgent,
  makeAgentWithoutTools,
  makeProject,
  mockApi,
  OTHER_AGENT_ID,
  PROJECT_ID,
  renderAgents,
} from './test-support.js';

/**
 * `/agents` — the Agents list (PRD §8.5).
 *
 * The suite is organised around the states this screen is actually in most of the time. A fresh
 * install has no agents, and an install running a Backend that predates Phase 4 has no route — and
 * those two look identical if the screen is careless, while sending the reader to two completely
 * different places.
 */

let api: ApiMock;

function seed(mock: ApiMock, agents: readonly unknown[] = []): void {
  mock.on('GET', '/api/v1/agents', { body: listBody(agents) });
  mock.on('GET', '/api/v1/projects', { body: listBody([makeProject()]) });
}

beforeEach(() => {
  api = mockApi();
  seed(api);
});

afterEach(() => {
  api.restore();
});

describe('the empty state — which on a fresh install is the first thing anyone sees', () => {
  it('says there are no agents and offers the one action that helps', async () => {
    renderAgents();

    expect(await screen.findByText('No agents yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New agent' })).toHaveAttribute('href', '/agents/new');
  });

  it('does not confuse "no agents" with "no agents API"', async () => {
    // Different fact, different fix. "No agents yet" invites the operator to press New agent,
    // which would fail — so a missing route names the route instead.
    api.on('GET', '/api/v1/agents', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Route GET /api/v1/agents does not exist' } },
    });

    renderAgents();

    expect(await screen.findByTestId('agents-route-missing')).toBeInTheDocument();
    expect(screen.queryByText('No agents yet.')).toBeNull();
    expect(screen.getByText(/does not serve/)).toHaveTextContent('/api/v1/agents');
  });

  it('distinguishes a filtered-empty list from a genuinely empty one', async () => {
    seed(api, [makeAgent()]);
    renderAgents('/agents?scope=project');

    expect(await screen.findByText('No Project agents.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeInTheDocument();
  });

  it('renders a read failure as an error, not as an empty list', async () => {
    api.on('GET', '/api/v1/agents', { status: 500, body: { error: { code: 'INTERNAL' } } });
    renderAgents();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be read/i);
    expect(screen.queryByText('No agents yet.')).toBeNull();
  });
});

describe('the rows', () => {
  it('names the scope, the project and what the permissions actually amount to', async () => {
    seed(api, [
      makeAgent(),
      makeAgent({
        id: OTHER_AGENT_ID,
        name: 'ERP Architect',
        scope: 'project',
        projectId: PROJECT_ID,
        permissions: { repository: { read: true, write: true, shell: true } },
        disallowedTools: [],
      }),
    ]);

    renderAgents();

    expect(await screen.findByText('Architect')).toBeInTheDocument();
    expect(screen.getByText('mission-control')).toBeInTheDocument();
    // Never "full access": PRD §5.5's other nine permissions are not modelled, so a word claiming
    // completeness would claim more than the model has.
    expect(screen.getByText('3 of 3 · read, write, shell')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 · read')).toBeInTheDocument();
    expect(screen.queryByText(/full access/i)).toBeNull();
  });

  it('marks a row whose Backend served no enforcement evidence', async () => {
    seed(api, [makeAgentWithoutTools()]);
    renderAgents();

    expect(await screen.findAllByText('enforcement not stated')).not.toHaveLength(0);
  });

  it('counts rows it could not read rather than quietly shortening the list', async () => {
    seed(api, [makeAgent(), { name: 'no id' }]);
    renderAgents();

    expect(await screen.findByTestId('agents-unreadable')).toHaveTextContent(
      /1 row was served without an id or a name/,
    );
  });
});

describe('archived agents', () => {
  it('asks the Backend for them, because no local filter can produce them', async () => {
    // Archival is the only retirement there is — the API has no DELETE — so an archived agent with
    // no way back on screen is one nobody can un-retire.
    renderAgents();
    await screen.findByText('No agents yet.');

    await userEvent.click(screen.getByRole('button', { name: 'Show archived' }));

    await waitFor(() => {
      expect(
        api.callsTo('includeArchived=true').length,
        'the chip must change the request, not the client-side filter',
      ).toBeGreaterThan(0);
    });
  });

  it('labels an archived row', async () => {
    seed(api, [makeAgent({ archivedAt: '2026-08-12T12:00:00.000Z' })]);
    renderAgents('/agents?archived=1');

    expect(await screen.findByText('archived')).toBeInTheDocument();
  });
});

describe('what this screen deliberately does not offer', () => {
  it('has no Teams tab', async () => {
    // TDS 06 §6.2 reserves `[Global] [Project] [Teams]` in the shell. Teams are not being built
    // this round — `agent_teams` is still a two-column skeleton and no route serves it — and a tab
    // that opened onto "coming later" is a promise nothing can keep.
    renderAgents();
    await screen.findByText('No agents yet.');

    expect(screen.queryByRole('button', { name: /team/i })).toBeNull();
  });

  it('links a row to its builder rather than offering a delete', async () => {
    seed(api, [makeAgent()]);
    renderAgents();

    expect(await screen.findByRole('link', { name: /Architect/ })).toHaveAttribute(
      'href',
      `/agents/${AGENT_ID}`,
    );
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});
