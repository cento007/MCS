import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeProject,
  makeReadOnlyAgent,
  makeShellAgent,
  makeWorkflow,
  mockApi,
  renderWorkflows,
  WORKFLOW_ID,
} from './test-support.js';

/**
 * The Workflows list and the workflow page — and above all their **empty states**.
 *
 * Four different nothings, and they have four different fixes: this Backend has no workflow API;
 * this instance has no workflows; this workflow has never run; this run has no steps yet. The
 * Memory screen exists because collapsing those into one "No results" is how a screen stops being
 * usable, and the same doctrine applies here.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/api/v1/projects', { body: listBody([makeProject()]) });
  api.on('GET', '/api/v1/agents', { body: listBody([makeShellAgent(), makeReadOnlyAgent()]) });
  api.on('GET', '/api/v1/repositories', { body: listBody([]) });
});

afterEach(() => {
  api.restore();
});

describe('the workflows list', () => {
  it('says the route is missing rather than showing an empty list', async () => {
    api.on('GET', '/api/v1/agent-workflows', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'test-req' } },
    });
    renderWorkflows();

    const note = await screen.findByTestId('workflows-route-missing');
    expect(note.textContent).toContain('does not serve');
    expect(note.textContent).toContain('different facts with different fixes');
    // And it does not invite the operator to create one against a route that is not there.
    expect(screen.queryByRole('button', { name: /New workflow/ })).toBeNull();
  });

  it('says there are no workflows yet, and points at the agents they would chain', async () => {
    api.on('GET', '/api/v1/agent-workflows', { body: listBody([]) });
    renderWorkflows();

    expect(await screen.findByText('No workflows yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See the agents' })).toBeTruthy();
  });

  it('renders the error envelope with its requestId when the list fails', async () => {
    api.on('GET', '/api/v1/agent-workflows', {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'req-42' } },
    });
    renderWorkflows();

    expect(await screen.findByText('The workflows list could not be read')).toBeTruthy();
    // The `X-Request-Id` header wins over the envelope's copy — F5.4 guarantees they are the same
    // value, and the header is the one the Backend log is keyed on.
    expect(screen.getByText('test-req')).toBeTruthy();
    expect(screen.getByText('INTERNAL_ERROR')).toBeTruthy();
  });

  it('shows the chain itself rather than a step count, and counts unreadable rows', async () => {
    api.on('GET', '/api/v1/agent-workflows', {
      body: listBody([makeWorkflow(), { name: 'no id' }]),
    });
    renderWorkflows();

    expect(await screen.findByText('Developer → QA')).toBeTruthy();
    expect((await screen.findByTestId('workflows-unreadable')).textContent).toContain('1 row was');
  });

  it('warns on the row when a chain names an archived agent', async () => {
    api.on('GET', '/api/v1/agent-workflows', {
      body: listBody([
        makeWorkflow({
          steps: [
            {
              ordinal: 0,
              agentId: 'x',
              agentName: 'Developer',
              agentScope: 'global',
              agentProjectId: null,
              agentArchivedAt: '2026-08-01T00:00:00.000Z',
              instructions: null,
            },
          ],
        }),
      ]),
    });
    renderWorkflows();

    expect(await screen.findByText(/1 archived agent — a run refuses to start/)).toBeTruthy();
  });
});

describe('a workflow that has never run', () => {
  beforeEach(() => {
    api.on('GET', '/api/v1/agent-workflows?', { body: listBody([makeWorkflow()]) });
    api.on('GET', `/api/v1/agent-workflows/${WORKFLOW_ID}`, { body: dataBody(makeWorkflow()) });
    api.on('GET', '/cost-estimate', { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  });

  it('says so, and says what has therefore not happened', async () => {
    api.on('GET', '/agent-workflow-runs', { body: listBody([]) });
    renderWorkflows(`/agents/workflows/${WORKFLOW_ID}`);

    expect(await screen.findByText('This workflow has never been run.')).toBeTruthy();
    expect(screen.getByText(/Nothing has been spent on it/)).toBeTruthy();
  });

  it('distinguishes “no runs” from “no runs API”', async () => {
    api.on('GET', '/agent-workflow-runs', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'test-req' } },
    });
    renderWorkflows(`/agents/workflows/${WORKFLOW_ID}`);

    const note = await screen.findByTestId('runs-route-missing');
    expect(note.textContent).toContain('history cannot be shown');
    expect(screen.queryByText('This workflow has never been run.')).toBeNull();
  });

  it('offers Run workflow…, and withholds it while the chain has unsaved edits', async () => {
    api.on('GET', '/agent-workflow-runs', { body: listBody([]) });
    renderWorkflows(`/agents/workflows/${WORKFLOW_ID}`);

    const run = await screen.findByTestId('open-prerun');
    expect(run).toBeEnabled();

    const nameField = screen.getByRole('textbox', { name: /^Name/ });
    await userEvent.type(nameField, '!');

    expect(screen.getByTestId('open-prerun')).toBeDisabled();
    expect((await screen.findByTestId('run-blocked-by-edits')).textContent).toContain(
      'a run executes the',
    );
  });

  it('states scope as a fact, because the API will not accept a change to it', async () => {
    api.on('GET', '/agent-workflow-runs', { body: listBody([]) });
    renderWorkflows(`/agents/workflows/${WORKFLOW_ID}`);

    const fact = await screen.findByTestId('workflow-scope-fact');
    expect(fact.textContent).toContain('Global');
    expect(fact.textContent).toContain('Scope is fixed once a workflow exists.');
    expect(within(fact).queryByRole('combobox')).toBeNull();
  });

  it('archives rather than deletes, and says which side is history', async () => {
    api.on('GET', '/agent-workflow-runs', { body: listBody([]) });
    renderWorkflows(`/agents/workflows/${WORKFLOW_ID}`);

    const archive = await screen.findByTestId('workflow-archive');
    expect(archive.textContent).toBe('Archive workflow');
    expect(screen.getByText(/There is no delete route at all/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});
