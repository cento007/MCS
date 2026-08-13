import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsListPage } from './ProjectsListPage.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeProject,
  makeRepository,
  mockApi,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  renderWithProviders,
} from './test-support.js';

/**
 * `/projects` — the Projects list (TDS 06 §5.3.1).
 */

let api: ApiMock;

const MISSION_CONTROL = makeProject({ id: PROJECT_ID, name: 'mission-control' });
const ERP_CORE = makeProject({
  id: OTHER_PROJECT_ID,
  name: 'erp-core',
  description: null,
});

function seedDefaults(mock: ApiMock): void {
  mock.on('GET', '/api/v1/projects', { body: listBody([MISSION_CONTROL, ERP_CORE]) });
  mock.on('GET', '/api/v1/repositories', { body: listBody([]) });
  mock.on('GET', '/api/v1/sessions', { body: listBody([]) });
  mock.on('GET', '/api/v1/settings/integrations', {
    body: dataBody({ github: { workflowMode: 'manual' } }),
  });
}

beforeEach(() => {
  api = mockApi();
  seedDefaults(api);
});

afterEach(() => {
  api.restore();
});

describe('identity and columns', () => {
  it('leads with the project name and never renders a UUID', async () => {
    renderWithProviders(<ProjectsListPage />);

    await screen.findByText('mission-control');
    expect(screen.getByText('erp-core')).toBeInTheDocument();
    // Same rule as Sessions (§9.3): a UUIDv7 prefix encodes the millisecond of creation and
    // discriminates nothing. A Project always has a name, so no id appears at all.
    expect(screen.queryByText(/0198a2f3/)).toBeNull();
  });

  it('counts repositories per project from one bounded read', async () => {
    api.on('GET', '/api/v1/repositories', {
      body: listBody([
        makeRepository({ id: 'r1', projectId: PROJECT_ID }),
        makeRepository({ id: 'r2', projectId: PROJECT_ID }),
        makeRepository({ id: 'r3', projectId: OTHER_PROJECT_ID }),
        // Unassigned repositories belong to no project and must not inflate any count.
        makeRepository({ id: 'r4', projectId: null }),
      ]),
    });

    renderWithProviders(<ProjectsListPage />);

    const row = (await screen.findByText('mission-control')).closest('tr') as HTMLElement;
    expect(within(row).getByText('2')).toBeInTheDocument();
  });
});

describe('the SESSIONS cell', () => {
  it('uses verbatim F7 state names and never the word "active"', async () => {
    api.on('GET', '/api/v1/sessions', (call) => {
      if (call.url.includes('state=running')) {
        return {
          body: listBody([
            { ...sessionStub('s1'), projectId: PROJECT_ID, state: 'running' },
            { ...sessionStub('s2'), projectId: PROJECT_ID, state: 'running' },
          ]),
        };
      }
      if (call.url.includes('state=paused')) {
        return {
          body: listBody([{ ...sessionStub('s3'), projectId: PROJECT_ID, state: 'paused' }]),
        };
      }
      return { body: listBody([]) };
    });

    renderWithProviders(<ProjectsListPage />);

    const row = (await screen.findByText('mission-control')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByText(/2 running/)).toBeInTheDocument());
    expect(within(row).getByText(/1 paused/)).toBeInTheDocument();
    expect(within(row).queryByText(/active/i)).toBeNull();
  });

  it('shows an em dash rather than "0 running" for a project with nothing in flight', async () => {
    renderWithProviders(<ProjectsListPage />);

    const row = (await screen.findByText('erp-core')).closest('tr') as HTMLElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText(/0 running/)).toBeNull();
  });

  it('says "unknown" instead of zero when the session counts could not be read', async () => {
    api.on('GET', '/api/v1/sessions', {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom', requestId: 'test-req' } },
    });

    renderWithProviders(<ProjectsListPage />);

    const row = (await screen.findByText('mission-control')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByText('unknown')).toBeInTheDocument());
  });
});

describe('the archived filter', () => {
  it('asks for the non-archived list by default (?archived=false)', async () => {
    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');

    const projectCalls = api.callsTo('/api/v1/projects');
    expect(projectCalls.length).toBeGreaterThan(0);
    expect(projectCalls.every((call) => call.url.includes('archived=false'))).toBe(true);
  });

  it('switches the list to archived projects, exclusively', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/projects', (call) =>
      call.url.includes('archived=true')
        ? {
            body: listBody([
              makeProject({
                id: 'p-old',
                name: 'notes-pipeline',
                archivedAt: '2026-07-01T00:00:00.000Z',
              }),
            ]),
          }
        : { body: listBody([MISSION_CONTROL, ERP_CORE]) },
    );

    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');

    await user.click(screen.getByRole('button', { name: 'Archived' }));

    // The API's filter is exclusive, so this is a different list and not an addition to it.
    await screen.findByText('notes-pipeline');
    expect(screen.queryByText('mission-control')).toBeNull();
  });

  it('explains an empty archived list rather than showing a bare table', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/projects', (call) =>
      call.url.includes('archived=true')
        ? { body: listBody([]) }
        : { body: listBody([MISSION_CONTROL]) },
    );

    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');
    await user.click(screen.getByRole('button', { name: 'Archived' }));

    expect(await screen.findByText('No archived projects.')).toBeInTheDocument();
  });
});

describe('empty and filtered states', () => {
  it('explains what a project is for when there are none, and offers the action', async () => {
    api.on('GET', '/api/v1/projects', { body: listBody([]) });

    renderWithProviders(<ProjectsListPage />);

    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
    expect(
      screen.getByText(/Projects group repositories, sessions and knowledge/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeInTheDocument();
  });

  it('distinguishes "no projects" from "no matches"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');

    await user.type(screen.getByLabelText('Filter projects by name'), 'zzzz');

    expect(screen.getByText('No projects match that name.')).toBeInTheDocument();
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });
});

describe('cursor pagination (F5.3)', () => {
  it('offers Load more while a cursor remains, and never page numbers', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/projects', (call) =>
      call.url.includes('cursor=')
        ? { body: listBody([makeProject({ id: 'p-3', name: 'homelab-infra' })]) }
        : { body: listBody([MISSION_CONTROL], 'opaque-cursor') },
    );

    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('homelab-infra');
    expect(api.calls.some((call) => call.url.includes('cursor=opaque-cursor'))).toBe(true);
    expect(screen.queryByRole('button', { name: '2' })).toBeNull();
  });
});

describe('creating a project', () => {
  it('creates with a name and inherits the global workflow mode by default', async () => {
    const user = userEvent.setup();
    const created = makeProject({ id: 'p-new', name: 'notes-pipeline' });
    api.on('POST', '/api/v1/projects', { status: 201, body: dataBody(created) });

    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');

    await user.click(screen.getByRole('button', { name: '+ Add Project' }));
    await user.type(await screen.findByLabelText('Name'), 'notes-pipeline');

    // The inherit option is selected out of the box: pinning a new Project to `manual` would
    // silently opt it out of a global setting the operator may not have configured yet.
    expect(screen.getByRole('radio', { name: /Follow global default/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const post = api.calls.find(
        (call) => call.method === 'POST' && call.url.includes('/api/v1/projects'),
      );
      expect(post?.body).toMatchObject({ name: 'notes-pipeline', workflowMode: null });
    });
  });

  it('names the global default beside the inherit option', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/settings/integrations', {
      body: dataBody({ github: { workflowMode: 'assisted' } }),
    });

    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');
    await user.click(screen.getByRole('button', { name: '+ Add Project' }));

    expect(
      await screen.findByRole('radio', { name: /Follow global default \(Assisted\)/ }),
    ).toBeInTheDocument();
  });

  it('surfaces a rejected create inline instead of closing the dialog', async () => {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/projects', {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'A project with that name already exists',
          requestId: 'test-req',
        },
      },
    });

    renderWithProviders(<ProjectsListPage />);
    await screen.findByText('mission-control');

    await user.click(screen.getByRole('button', { name: '+ Add Project' }));
    await user.type(await screen.findByLabelText('Name'), 'mission-control');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('A project with that name already exists')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Project' })).toBeInTheDocument();
  });
});

/** A minimal Session shape — this suite only ever reads `projectId` and `state`. */
function sessionStub(id: string): Record<string, unknown> {
  return {
    id,
    projectId: PROJECT_ID,
    repositoryId: null,
    sessionType: 'managed',
    state: 'running',
    title: 'Session',
    failureReason: null,
    notes: null,
    branch: 'DEV',
    workingDirectory: 'D:\\Repos\\MCS',
    runtime: {
      kind: 'claude_code',
      runtimeSessionId: null,
      claudeVersion: null,
      model: null,
      machine: null,
      environment: null,
    },
    observation: null,
    costUsd: null,
    tokenUsage: null,
    durationSeconds: null,
    resumedFromSessionId: null,
    clonedFromSessionId: null,
    createdAt: '2026-08-12T12:00:00.000Z',
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}
