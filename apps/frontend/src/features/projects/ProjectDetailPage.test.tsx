import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDetailPage } from './ProjectDetailPage.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeProject,
  mockApi,
  PROJECT_ID,
  renderWithProviders,
} from './test-support.js';

/**
 * `/projects/:projectId` — header, workflow-mode override and the phase-gated tabs
 * (TDS 06 §5.3.2, PRD §4.3, UX register WC9/WC13).
 */

let api: ApiMock;
/**
 * The server's copy of the Project, held so the mock behaves like one: a PATCH changes it and
 * the following GET reflects the change. Without that, every non-optimistic mutation would
 * "fail" in the suite — the invalidation refetch would restore the pre-edit row and the test
 * would be asserting against a server that forgot the write it just accepted.
 */
let current = makeProject();

function seedDefaults(mock: ApiMock, project = makeProject()): void {
  current = project;
  mock.on('GET', `/api/v1/projects/${project.id}`, () => ({ body: dataBody(current) }));
  mock.on('PATCH', `/api/v1/projects/${project.id}`, (call) => {
    current = { ...current, ...(call.body as Record<string, unknown>) };
    return { body: dataBody(current) };
  });
  mock.on('GET', '/api/v1/repositories', { body: listBody([]) });
  mock.on('GET', '/api/v1/sessions', { body: listBody([]) });
  mock.on('GET', '/api/v1/settings/integrations', {
    body: dataBody({ github: { workflowMode: 'manual' } }),
  });
}

function renderDetail(): void {
  renderWithProviders(
    <ProjectDetailPage projectId={PROJECT_ID} sessionsTab={<p>sessions tab body</p>} />,
    { initialEntries: [`/projects/${PROJECT_ID}`] },
  );
}

beforeEach(() => {
  api = mockApi();
  seedDefaults(api);
});

afterEach(() => {
  api.restore();
});

describe('identity', () => {
  it('leads with the project name and shows no id anywhere', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'mission-control' })).toBeInTheDocument();
    expect(screen.queryByText(PROJECT_ID)).toBeNull();
    expect(screen.queryByText(/0198a2f3/)).toBeNull();
  });
});

describe('inline rename', () => {
  it('PATCHes the new name and renders the server’s answer, not the draft', async () => {
    const user = userEvent.setup();

    renderDetail();
    await screen.findByRole('heading', { name: 'mission-control' });

    await user.click(screen.getByRole('button', { name: 'Rename project' }));
    const input = await screen.findByLabelText('Project name');
    await user.clear(input);
    await user.type(input, 'mission-control-2{Enter}');

    await waitFor(() => {
      const patch = api.calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ name: 'mission-control-2' });
    });
    expect(await screen.findByRole('heading', { name: 'mission-control-2' })).toBeInTheDocument();
  });

  it('abandons the edit on Escape without sending anything', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'mission-control' });

    await user.click(screen.getByRole('button', { name: 'Rename project' }));
    const input = await screen.findByLabelText('Project name');
    await user.clear(input);
    await user.type(input, 'oops{Escape}');

    expect(screen.getByRole('heading', { name: 'mission-control' })).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('sends nothing for an unchanged or empty name', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'mission-control' });

    await user.click(screen.getByRole('button', { name: 'Rename project' }));
    const input = await screen.findByLabelText('Project name');
    await user.clear(input);
    // An empty name would be rejected by the API; committing it would be a pointless round trip
    // that also blanks the heading for the duration.
    await user.tab();

    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

describe('the per-project workflow-mode override (PRD §4.3 / WC13)', () => {
  it('starts on "follow global default" when the override is null, and names the default', async () => {
    renderDetail();

    const inherit = await screen.findByRole('radio', { name: /Follow global default \(Manual\)/ });
    expect(inherit).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Manual/ })).not.toBeChecked();
    expect(screen.getByText(/follows the global default, currently Manual/)).toBeInTheDocument();
  });

  it('marks which option the global default currently is', async () => {
    api.on('GET', '/api/v1/settings/integrations', {
      body: dataBody({ github: { workflowMode: 'assisted' } }),
    });

    renderDetail();

    // The `(global)` chip of §5.3.2 rides on the *matching* explicit option, so an operator can
    // see when an override says the same thing the inherited default already said.
    expect(await screen.findByRole('radio', { name: /Assisted.*global/ })).toBeInTheDocument();
  });

  it('admits it cannot name the default when the settings document is unreadable', async () => {
    api.on('GET', '/api/v1/settings/integrations', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no such category', requestId: 'test-req' } },
    });

    renderDetail();

    expect(
      await screen.findByRole('radio', { name: /Follow global default \(not readable\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/the effective mode is unknown/)).toBeInTheDocument();
  });

  it('PATCHes an explicit override', async () => {
    const user = userEvent.setup();

    renderDetail();
    await screen.findByRole('radio', { name: /Follow global default/ });

    await user.click(screen.getByRole('radio', { name: /^Assisted/ }));

    await waitFor(() => {
      const patch = api.calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ workflowMode: 'assisted' });
    });
    expect(
      await screen.findByText(/overrides the global default and uses Assisted/),
    ).toBeInTheDocument();
  });

  it('clears the override by sending an explicit null, not by omitting the field', async () => {
    const user = userEvent.setup();
    seedDefaults(api, makeProject({ workflowMode: 'assisted' }));

    renderDetail();
    const assisted = await screen.findByRole('radio', { name: /^Assisted/ });
    expect(assisted).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /Follow global default/ }));

    await waitFor(() => {
      const patch = api.calls.find((call) => call.method === 'PATCH');
      // `workflowMode: null` is what clears the override (§4). An omitted key would be a no-op
      // and would leave the Project pinned forever.
      expect(patch?.body).toEqual({ workflowMode: null });
      expect(Object.keys(patch?.body as object)).toContain('workflowMode');
    });
  });
});

describe('archiving', () => {
  it('archives through PATCH { archivedAt } and offers Restore afterwards', async () => {
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));

    // §4 spells archival as a field write, not a `/archive` sub-action — there is no second
    // spelling of the same transition anywhere in this client.
    const dialog = await screen.findByRole('dialog', { name: 'Archive this project?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      const patch = api.calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toHaveProperty('archivedAt');
    });
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByText('archived')).toBeInTheDocument();
  });
});

describe('tabs', () => {
  it('renders the four PRD §8.2 sections as a tablist', async () => {
    renderDetail();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Repositories',
      'Sessions',
      'AgentsP4',
      'MemoryP3',
    ]);
  });

  it('shows the injected Sessions tab body when Sessions is selected', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('tab', { name: 'Sessions' }));
    expect(screen.getByText('sessions tab body')).toBeInTheDocument();
  });

  it('reaches the phase-gated tabs by keyboard and never disables them (WC9)', async () => {
    const user = userEvent.setup();
    renderDetail();

    const repositories = await screen.findByRole('tab', { name: 'Repositories' });
    repositories.focus();

    // Roving tabindex: the tablist is one tab stop, arrows move within it — including onto the
    // Phase 3/4 destinations, which are focusable and functional.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    const agents = screen.getByRole('tab', { name: /Agents/ });
    expect(agents).toHaveAttribute('aria-selected', 'true');
    expect(agents).not.toBeDisabled();
    expect(agents).not.toHaveAttribute('aria-disabled');
    expect(await screen.findByText(/This tab ships in Phase 4/)).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    const memory = screen.getByRole('tab', { name: /Memory/ });
    expect(memory).toHaveAttribute('aria-selected', 'true');
    expect(memory).not.toBeDisabled();
    expect(await screen.findByText(/This tab ships in Phase 3/)).toBeInTheDocument();

    // And it wraps back to the beginning rather than trapping focus at the end.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Repositories' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('carries the selected tab in the URL so a panel is linkable', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('tab', { name: /Memory/ }));
    // `?tab=memory` — the same linkable-state mechanism the session right panel uses (§6.7).
    expect(await screen.findByText(/This tab ships in Phase 3/)).toBeInTheDocument();
  });
});

describe('failure', () => {
  it('renders the F5.4 envelope with a retry when the project cannot be read', async () => {
    api.on('GET', `/api/v1/projects/${PROJECT_ID}`, {
      status: 404,
      body: {
        error: { code: 'NOT_FOUND', message: 'No project with that id', requestId: 'test-req' },
      },
    });

    renderDetail();

    expect(await screen.findByText('This project could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('No project with that id')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
