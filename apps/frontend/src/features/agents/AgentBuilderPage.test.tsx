import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ID,
  type ApiMock,
  dataBody,
  listBody,
  makeAgent,
  makeAgentWithoutTools,
  makeProject,
  mockApi,
  PROJECT_ID,
  renderAgents,
} from './test-support.js';

/**
 * `/agents/new` and `/agents/:agentId` — the Agent Builder (PRD §5.8).
 *
 * Four things are worth a suite of their own, and they are the four an operator can be hurt by:
 *
 *  1. the screen never claims a permission is enforced without the Backend's own evidence;
 *  2. an agent the database cannot hold cannot be submitted, and the refusal explains itself;
 *  3. an edit reaches the API as a `PATCH` of the changed fields only, never as a document;
 *  4. leaving with unsaved work is blocked by the same guard Settings uses.
 */

let api: ApiMock;

function seed(mock: ApiMock): void {
  mock.on('GET', '/api/v1/projects', { body: listBody([makeProject()]) });
  mock.on('GET', '/api/v1/settings/agents', {
    body: dataBody({ defaultPermissionTemplate: 'read_only' }),
  });
  mock.on('GET', `/api/v1/agents/${AGENT_ID}`, { body: dataBody(makeAgent()) });
}

/** The one call a test wants to inspect, or `undefined` when the screen never made it. */
function lastBody(fragment: string, method: string): unknown {
  const calls = api.callsTo(fragment).filter((call) => call.method === method);
  return calls.at(-1)?.body;
}

beforeEach(() => {
  api = mockApi();
  seed(api);
});

afterEach(() => {
  api.restore();
});

// ------------------------------------------------------------------ permissions, and honesty

describe('permissions render what the API returns', () => {
  it('shows the three the Backend models and names the nine it does not', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    expect(await screen.findByTestId('permission-repository.read')).toBeInTheDocument();
    expect(screen.getByTestId('permission-repository.write')).toBeInTheDocument();
    expect(screen.getByTestId('permission-repository.shell')).toBeInTheDocument();

    // No switch for Merge, Create PR, Commit, Delete, or anything under Memory/Documentation —
    // a switch that gates nothing is a safety claim, and PRD §5.5's other nine gate nothing here.
    expect(screen.queryByLabelText('Merge')).toBeNull();
    expect(screen.queryByLabelText('Create PR')).toBeNull();

    // Their absence is stated rather than left to be noticed.
    expect(screen.getByTestId('permissions-not-modelled')).toHaveTextContent(
      /PRD §5.5 lists nine more permissions/,
    );
  });

  it('renders the Backend’s own disallowedTools as the evidence of enforcement', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    const tools = await screen.findByTestId('disallowed-tools');
    // The literal `--disallowedTools` list a session running as this agent receives. It is the
    // difference between "write: false" (what was asked for) and what will actually happen.
    expect(within(tools).getByText('Bash')).toBeInTheDocument();
    expect(within(tools).getByText('Write')).toBeInTheDocument();
    expect(screen.queryByTestId('disallowed-tools-missing')).toBeNull();
  });

  it('says "enforcement not stated" when the Backend served no tool list', async () => {
    api.on(`GET`, `/api/v1/agents/${AGENT_ID}`, { body: dataBody(makeAgentWithoutTools()) });
    renderAgents(`/agents/${AGENT_ID}`);

    expect(await screen.findByTestId('disallowed-tools-missing')).toHaveTextContent(
      /does not say what these switches remove/,
    );
    expect(screen.getByTestId('enforcement-unknown-repository.read')).toBeInTheDocument();
  });

  it('does not re-derive the tool list from the draft, and says the shown one is stale', async () => {
    renderAgents(`/agents/${AGENT_ID}`);
    await screen.findByTestId('disallowed-tools');

    await userEvent.click(
      within(screen.getByTestId('permission-repository.write')).getByRole('checkbox'),
    );

    // Recomputing here would be a second copy of `disallowedToolsFor`, free to drift on exactly
    // the question of which tools a denial removes.
    expect(await screen.findByTestId('disallowed-tools-stale')).toBeInTheDocument();
  });

  it('states that permissions are subtractive, not authorisations being handed out', async () => {
    renderAgents(`/agents/${AGENT_ID}`);
    expect(await screen.findByText(/subtractive/)).toBeInTheDocument();
  });
});

// --------------------------------------------------------------------- the scope invariant

describe('a form nobody has touched does not shout', () => {
  it('opens with the button disabled and no accusations', async () => {
    // `/agents/new` starts with an empty name, so validation is failing before the operator has
    // done anything. Rendering that as a red error accuses someone of a mistake they have not made
    // — and teaches them that the red text on this page is decoration, on the one screen where two
    // of those messages explain constraints they cannot otherwise discover.
    renderAgents('/agents/new');

    await screen.findByLabelText(/^Name/);
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeDisabled();
    expect(screen.queryByTestId('blocking-issues')).toBeNull();
    expect(screen.queryByTestId('issue-name')).toBeNull();
    expect(screen.getByTestId('save-bar')).toHaveTextContent('Nothing entered yet');
  });

  it('explains itself as soon as the operator starts, and after a refused submit', async () => {
    renderAgents('/agents/new');

    // Editing anything opts them into the running commentary.
    await userEvent.type(await screen.findByLabelText(/^Description/), 'x');
    expect(screen.getByTestId('issue-name')).toHaveTextContent('An agent needs a name.');
  });
});

describe('the scope/project invariant', () => {
  it('refuses to submit a project agent with no project, and explains why', async () => {
    renderAgents('/agents/new');

    await userEvent.type(await screen.findByLabelText(/^Name/), 'ERP Architect');
    await userEvent.selectOptions(screen.getByLabelText(/^Scope/), 'project');

    const submit = screen.getByRole('button', { name: 'Create agent' });
    expect(submit).toBeDisabled();

    // Beside the disabled button, not only next to a field three sections up the page.
    expect(screen.getByTestId('blocking-issues')).toHaveTextContent(
      'A project agent needs a project.',
    );
    expect(screen.getByTestId('blocking-issues')).toHaveTextContent(/its scope is Global/);

    await userEvent.selectOptions(screen.getByLabelText(/^Project/), PROJECT_ID);
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled();
  });

  it('hides the project picker again when the scope goes back to global', async () => {
    renderAgents('/agents/new');

    await userEvent.type(await screen.findByLabelText(/^Name/), 'X');
    await userEvent.selectOptions(screen.getByLabelText(/^Scope/), 'project');
    await userEvent.selectOptions(screen.getByLabelText(/^Project/), PROJECT_ID);
    await userEvent.selectOptions(screen.getByLabelText(/^Scope/), 'global');

    expect(screen.queryByLabelText(/^Project/)).toBeNull();
    // …and the project is gone from the body, which the Backend would otherwise reject outright.
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(lastBody('/api/v1/agents', 'POST')).toBeDefined());
    expect((lastBody('/api/v1/agents', 'POST') as Record<string, unknown>)['projectId']).toBeNull();
  });

  it('shows scope as a fact in edit mode, because the API will not change it', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    const fact = await screen.findByTestId('scope-fact');
    expect(fact).toHaveTextContent('Global');
    expect(fact).toHaveTextContent(/Scope is fixed once an agent exists/);
    // A greyed-out select would invite the operator to look for the thing that ungreys it.
    expect(screen.queryByLabelText(/^Scope/)).toBeNull();
  });
});

// ------------------------------------------------------------ the shell/read/write invariant

describe('the shell-subsumes-read-and-write invariant', () => {
  it('grants read and write with shell rather than making the operator tick two more boxes', async () => {
    renderAgents('/agents/new');

    await userEvent.type(await screen.findByLabelText(/^Name/), 'Full');
    await userEvent.click(
      within(screen.getByTestId('permission-repository.shell')).getByRole('checkbox'),
    );

    expect(
      within(screen.getByTestId('permission-repository.read')).getByRole('checkbox'),
    ).toBeChecked();
    expect(
      within(screen.getByTestId('permission-repository.write')).getByRole('checkbox'),
    ).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled();
  });

  it('blocks the combination the Backend refuses, and explains that the denial would not hold', async () => {
    renderAgents('/agents/new');

    await userEvent.type(await screen.findByLabelText(/^Name/), 'Impossible');
    await userEvent.click(
      within(screen.getByTestId('permission-repository.shell')).getByRole('checkbox'),
    );
    await userEvent.click(
      within(screen.getByTestId('permission-repository.read')).getByRole('checkbox'),
    );

    expect(screen.getByRole('button', { name: 'Create agent' })).toBeDisabled();
    expect(screen.getByTestId('blocking-issues')).toHaveTextContent(/would not hold/);
  });
});

// ------------------------------------------------------------------------ create and edit

describe('creating', () => {
  it('POSTs the whole document and navigates to the new agent', async () => {
    const created = makeAgent({ id: AGENT_ID, name: 'Architect' });
    api.on('POST', '/api/v1/agents', { status: 201, body: dataBody(created) });

    const { router } = renderAgents('/agents/new');

    await userEvent.type(await screen.findByLabelText(/^Name/), 'Architect');
    await userEvent.type(screen.getByLabelText(/^Instructions/), 'You are the Architect.');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}`));

    expect(lastBody('/api/v1/agents', 'POST')).toMatchObject({
      name: 'Architect',
      scope: 'global',
      projectId: null,
      runtime: 'claude_code',
      instructions: 'You are the Architect.',
      // Seeded from `settings.agents.defaultPermissionTemplate`, so what the operator saw before
      // touching anything is what they get by not touching anything.
      permissions: { repository: { read: true, write: false, shell: false } },
    });
  });

  it('does not let the guard block the navigation its own save caused', async () => {
    api.on('POST', '/api/v1/agents', { status: 201, body: dataBody(makeAgent()) });

    const { router } = renderAgents('/agents/new');
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Architect');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}`));
    expect(screen.queryByTestId('unsaved-message')).toBeNull();
  });

  it('keeps the operator’s work when the server rejects the create', async () => {
    api.on('POST', '/api/v1/agents', {
      status: 409,
      body: { error: { code: 'CONFLICT', message: 'An agent named "Architect" already exists' } },
    });

    const { router } = renderAgents('/agents/new');
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Architect');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(screen.getByText(/already exists/)).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/agents/new');
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Architect');
  });
});

describe('editing', () => {
  it('PATCHes only the fields that changed', async () => {
    api.on('PATCH', `/api/v1/agents/${AGENT_ID}`, {
      body: dataBody(makeAgent({ name: 'Architect II' })),
    });

    renderAgents(`/agents/${AGENT_ID}`);

    const name = await screen.findByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Architect II');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(lastBody(`/api/v1/agents/${AGENT_ID}`, 'PATCH')).toBeDefined());
    // Not a document. `scope`, `projectId` and `sessionId` are absent from the Backend's update
    // schema, which is `additionalProperties: false` — sending them is a 400, not a no-op.
    expect(lastBody(`/api/v1/agents/${AGENT_ID}`, 'PATCH')).toEqual({ name: 'Architect II' });
  });

  it('counts the changes it is about to save', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    await userEvent.type(await screen.findByLabelText(/^Name/), '!');
    expect(await screen.findByTestId('save-bar')).toHaveTextContent('1 change');

    await userEvent.click(
      within(screen.getByTestId('permission-repository.write')).getByRole('checkbox'),
    );
    expect(screen.getByTestId('save-bar')).toHaveTextContent('2 changes');
  });

  it('offers archive rather than delete, because the API has no delete', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    expect(await screen.findByLabelText(/^Archived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('disables the form and names the route when the Backend does not serve it', async () => {
    api.on('GET', `/api/v1/agents/${AGENT_ID}`, {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Route does not exist' } },
    });

    renderAgents(`/agents/${AGENT_ID}`);

    expect(await screen.findByTestId('agents-route-missing')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  });

  it('refuses to start from a guess when the document is not a readable agent', async () => {
    api.on('GET', `/api/v1/agents/${AGENT_ID}`, { body: dataBody({ name: 'no id' }) });
    renderAgents(`/agents/${AGENT_ID}`);

    expect(await screen.findByTestId('agent-unreadable')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  });
});

// ------------------------------------------------------------------------- the dirty guard

describe('the unsaved-changes guard', () => {
  it('blocks a navigation away from unsaved work and names what is at stake', async () => {
    const { router } = renderAgents(`/agents/${AGENT_ID}`);

    await userEvent.type(await screen.findByLabelText(/^Name/), '!');
    await router.navigate('/sessions');

    expect(await screen.findByTestId('unsaved-message')).toHaveTextContent(
      'You have 1 unsaved change in Agent → Architect.',
    );
    expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}`);
  });

  it('lets the operator discard and leave', async () => {
    const { router } = renderAgents(`/agents/${AGENT_ID}`);

    await userEvent.type(await screen.findByLabelText(/^Name/), '!');
    await router.navigate('/sessions');
    // Scoped to the guard modal: the Save bar carries its own [Discard], and clicking that one
    // would prove nothing about the guard.
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions'));
  });

  it('does not navigate when the guard’s own Save fails', async () => {
    // The whole point of guarding: a failed save must not discard the edits it was protecting,
    // under a button labelled "Save".
    api.on('PATCH', `/api/v1/agents/${AGENT_ID}`, {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'nope' } },
    });

    const { router } = renderAgents(`/agents/${AGENT_ID}`);
    await userEvent.type(await screen.findByLabelText(/^Name/), '!');
    await router.navigate('/sessions');
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}`));
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Architect!');
  });

  it('does not block a navigation from a clean form', async () => {
    const { router } = renderAgents(`/agents/${AGENT_ID}`);
    await screen.findByLabelText(/^Name/);

    await router.navigate('/sessions');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions'));
    expect(screen.queryByTestId('unsaved-message')).toBeNull();
  });
});

// ---------------------------------------------------------------- the honest empty sections

describe('sections that have nothing to configure say so', () => {
  it('states that this Backend stores no knowledge sources, and why', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    expect(await screen.findByTestId('knowledge-not-served')).toHaveTextContent(
      /stores no knowledge sources/,
    );
  });

  it('shows a knowledge field it cannot edit rather than hiding it', async () => {
    api.on('GET', `/api/v1/agents/${AGENT_ID}`, {
      body: dataBody(makeAgent({ knowledge: ['docs/tds'] })),
    });

    renderAgents(`/agents/${AGENT_ID}`);
    expect(await screen.findByTestId('knowledge-served')).toHaveTextContent('knowledge');
  });

  it('states the runtime as a fact, not as a dropdown with one entry', async () => {
    renderAgents(`/agents/${AGENT_ID}`);

    const runtime = await screen.findByTestId('runtime-fact');
    expect(runtime).toHaveTextContent('Claude Code');
    expect(runtime).toHaveTextContent(/nothing can execute an agent on it/);
    expect(screen.queryByLabelText(/^Runtime/)).toBeNull();
  });
});
