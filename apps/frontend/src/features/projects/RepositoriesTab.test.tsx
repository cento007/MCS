import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepositoriesTab } from './RepositoriesTab.js';
import {
  type ApiMock,
  conflictBody,
  dataBody,
  listBody,
  makeRepository,
  makeStatus,
  mockApi,
  PROJECT_ID,
  REPOSITORY_ID,
  renderWithProviders,
  validationBody,
} from './test-support.js';

/**
 * The Repositories tab (TDS 06 §5.3.2) — registration, sync status, working-tree honesty and
 * removal.
 */

let api: ApiMock;

function renderTab(): void {
  renderWithProviders(
    <RepositoriesTab projectId={PROJECT_ID} projectName="mission-control" active />,
    { initialEntries: [`/projects/${PROJECT_ID}`] },
  );
}

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/api/v1/repositories', { body: listBody([]) });
});

afterEach(() => {
  api.restore();
});

describe('empty state', () => {
  it('explains how a repository gets here instead of showing an empty table', async () => {
    renderTab();

    expect(await screen.findByText('No repositories registered yet.')).toBeInTheDocument();
    expect(screen.getByText(/Register one by its absolute path/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register repository' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('sync (POST /repositories/{id}/sync)', () => {
  beforeEach(() => {
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });
  });

  it('queues a sync and says the answer is "queued", not "synced"', async () => {
    const user = userEvent.setup();
    api.on('POST', `/api/v1/repositories/${REPOSITORY_ID}/sync`, {
      status: 202,
      body: dataBody({ jobId: 'job-1' }),
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Sync MCS' }));

    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.method === 'POST' && call.url.includes(`/${REPOSITORY_ID}/sync`),
        ),
      ).toBe(true),
    );
    // `202` means accepted; the outcome arrives on the `repositories` channel. There is no
    // `GET /jobs/{id}` in the contract, so nothing here pretends to await a result.
    expect(await screen.findByText('Sync queued for MCS')).toBeInTheDocument();
  });

  it('surfaces INTEGRATION_NOT_CONFIGURED as the fixable thing it is', async () => {
    const user = userEvent.setup();
    api.on('POST', `/api/v1/repositories/${REPOSITORY_ID}/sync`, {
      status: 409,
      body: {
        error: {
          code: 'INTEGRATION_NOT_CONFIGURED',
          message: 'No GitHub token is saved',
          requestId: 'test-req',
        },
      },
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Sync MCS' }));

    expect(
      await screen.findByText(/Configure this integration in Settings first/),
    ).toBeInTheDocument();
  });
});

describe('discovery (POST /repositories/discover)', () => {
  it('scans, reports what it skipped and why, and offers the results for attachment', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/repositories', {
      body: listBody([makeRepository({ id: 'r-loose', projectId: null, name: 'MCS-infra' })]),
    });
    api.on('POST', '/api/v1/repositories/discover', {
      body: dataBody({
        scannedAt: '2026-08-13T08:00:00.000Z',
        truncated: false,
        registered: [],
        skipped: [
          {
            localPath: 'D:\\Repos\\scratch',
            reason: 'no_remote',
            detail: 'the working tree has no origin remote',
            repositoryId: null,
          },
        ],
        counts: { workingTreesFound: 4, registered: 1, skipped: 3 },
      }),
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Attach existing…' }));
    await user.click(await screen.findByRole('button', { name: 'Scan discovery roots' }));

    const report = await screen.findByTestId('discovery-report');
    expect(report).toHaveTextContent('4 working trees found · 1 registered · 3 skipped');
    // The skip reasons are the whole reason this route answers with a report rather than a job
    // id — nothing persists them, so a screen that dropped them would lose them for good.
    expect(report).toHaveTextContent('the working tree has no origin remote');
  });

  it('says a truncated scan is not the whole picture', async () => {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/repositories/discover', {
      body: dataBody({
        scannedAt: '2026-08-13T08:00:00.000Z',
        truncated: true,
        registered: [],
        skipped: [],
        counts: { workingTreesFound: 200, registered: 0, skipped: 200 },
      }),
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Attach existing…' }));
    await user.click(await screen.findByRole('button', { name: 'Scan discovery roots' }));

    expect(await screen.findByText(/hit its bounds and stopped early/)).toBeInTheDocument();
  });

  it('points at Settings when no discovery roots are configured', async () => {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/repositories/discover', {
      status: 409,
      body: {
        error: {
          code: 'INTEGRATION_NOT_CONFIGURED',
          message: 'No discovery roots are configured',
          requestId: 'test-req',
        },
      },
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Attach existing…' }));
    await user.click(await screen.findByRole('button', { name: 'Scan discovery roots' }));

    expect(await screen.findByText(/There are no discovery roots to scan/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Settings → Integrations → GitHub/ }),
    ).toBeInTheDocument();
  });

  it('attaches an unassigned repository to this project', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/repositories', (call) =>
      call.url.includes(`projectId=${PROJECT_ID}`)
        ? { body: listBody([]) }
        : {
            body: listBody([makeRepository({ id: 'r-loose', projectId: null, name: 'MCS-infra' })]),
          },
    );
    api.on('PATCH', '/api/v1/repositories/r-loose', {
      body: dataBody(makeRepository({ id: 'r-loose', projectId: PROJECT_ID, name: 'MCS-infra' })),
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Attach existing…' }));
    await user.click(
      await screen.findByRole('button', { name: 'Attach MCS-infra to mission-control' }),
    );

    await waitFor(() => {
      const patch = api.calls.find((call) => call.method === 'PATCH');
      // Discovery registers with `projectId: null` ("discovered, unassigned"); this PATCH is
      // the documented way a Repository joins a Project (§5.1).
      expect(patch?.body).toEqual({ projectId: PROJECT_ID });
    });
  });
});

describe('registering by local path', () => {
  it('POSTs the path against this project and closes on success', async () => {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/repositories', {
      status: 201,
      body: dataBody(makeRepository()),
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: '+ Register repository' }));
    await user.type(await screen.findByLabelText('Local path'), 'D:\\Repos\\MCS');
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => {
      const post = api.calls.find((call) => call.method === 'POST');
      expect(post?.body).toEqual({ localPath: 'D:\\Repos\\MCS', projectId: PROJECT_ID });
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Register repository' })).toBeNull(),
    );
  });

  it('omits an empty name and branch so the server derives them', async () => {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/repositories', { status: 201, body: dataBody(makeRepository()) });

    renderTab();
    await user.click(await screen.findByRole('button', { name: '+ Register repository' }));
    await user.type(await screen.findByLabelText('Local path'), '  D:\\Repos\\MCS  ');
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => {
      const post = api.calls.find((call) => call.method === 'POST');
      expect(Object.keys(post?.body as object).sort()).toEqual(['localPath', 'projectId']);
    });
  });

  it('says the path is resolved on the server, not in the browser', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: '+ Register repository' }));
    expect(
      await screen.findByText(/An absolute path on the machine running Mission Control/),
    ).toBeInTheDocument();
  });
});

describe('registration failures stay distinguishable', () => {
  async function submitAndRead(status: number, body: unknown): Promise<HTMLElement> {
    const user = userEvent.setup();
    api.on('POST', '/api/v1/repositories', { status, body });

    renderTab();
    await user.click(await screen.findByRole('button', { name: '+ Register repository' }));
    await user.type(await screen.findByLabelText('Local path'), 'D:\\nope');
    await user.click(screen.getByRole('button', { name: 'Register' }));

    return screen.findByTestId('registration-problem');
  }

  it('path missing', async () => {
    const panel = await submitAndRead(
      400,
      validationBody('localPath does not exist on this machine', {
        field: 'localPath',
        reason: 'path_missing',
      }),
    );

    expect(panel).toHaveTextContent('That path does not exist on the Mission Control host.');
    expect(panel).toHaveTextContent(/resolved on the server/);
  });

  it('not a directory', async () => {
    const panel = await submitAndRead(
      400,
      validationBody('localPath is not a directory', {
        field: 'localPath',
        reason: 'not_a_directory',
      }),
    );

    expect(panel).toHaveTextContent('That path is a file, not a directory.');
  });

  it('not a git working tree', async () => {
    const panel = await submitAndRead(
      400,
      validationBody('localPath is not a git working tree', {
        field: 'localPath',
        reason: 'not_a_git_repository',
      }),
    );

    expect(panel).toHaveTextContent('That directory is not a git working tree.');
    expect(panel).toHaveTextContent(/git init/);
  });

  it('git unavailable', async () => {
    const panel = await submitAndRead(
      400,
      validationBody('git could not be run', { field: 'localPath', reason: 'git_unavailable' }),
    );

    expect(panel).toHaveTextContent(/git could not be run to check it/);
    expect(panel).toHaveTextContent(/Install git/);
  });

  it('already registered', async () => {
    const panel = await submitAndRead(
      409,
      conflictBody('That local path is already registered as a repository', {
        field: 'localPath',
        localPath: 'D:\\Repos\\MCS',
        repositoryId: REPOSITORY_ID,
      }),
    );

    expect(panel).toHaveTextContent('That local path is already registered as a repository.');
  });

  it('keeps the dialog open with the typed path, and quotes the requestId', async () => {
    const panel = await submitAndRead(
      400,
      validationBody('nope', { field: 'localPath', reason: 'path_missing' }),
    );

    expect(panel).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Register repository' })).toBeInTheDocument();
    expect(screen.getByLabelText('Local path')).toHaveValue('D:\\nope');
    expect(screen.getByRole('button', { name: 'test-req' })).toBeInTheDocument();
  });
});

describe('sync status', () => {
  it('reads "never synced" for a locally registered repository', async () => {
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });

    renderTab();

    expect(await screen.findByText('never synced')).toBeInTheDocument();
  });

  it('explains a failed badge inline, without sending the operator to the audit log', async () => {
    api.on('GET', '/api/v1/repositories', {
      body: listBody([
        makeRepository({
          syncStatus: 'failed',
          lastSyncError: 'GitHub returned 401: Bad credentials',
          lastSyncedAt: '2026-08-12T09:00:00.000Z',
        }),
      ]),
    });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });

    renderTab();

    expect(await screen.findByText('failed')).toBeInTheDocument();
    // `repositories.last_sync_error` exists precisely so this sentence can be rendered here.
    expect(screen.getByText('GitHub returned 401: Bad credentials')).toBeInTheDocument();
  });

  it('admits when a failure carries no recorded reason', async () => {
    api.on('GET', '/api/v1/repositories', {
      body: listBody([makeRepository({ syncStatus: 'failed', lastSyncError: null })]),
    });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });

    renderTab();

    expect(await screen.findByText('No reason was recorded for the failure.')).toBeInTheDocument();
  });
});

describe('working-tree status', () => {
  it('renders the current branch and dirty count from the read model', async () => {
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, {
      body: dataBody(
        makeStatus({ currentBranch: 'DEV', uncommittedFiles: 3, ahead: 2, behind: 1 }),
      ),
    });

    renderTab();

    expect(await screen.findByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('3 uncommitted files')).toBeInTheDocument();
    expect(screen.getByText('↑2 ↓1')).toBeInTheDocument();
  });

  it.each([
    ['path_missing', /no longer exists on the Mission Control host/],
    ['not_a_directory', /is not a directory/],
    ['not_a_git_repository', /no longer a git working tree/],
    ['git_unavailable', /git could not be run/],
    ['timed_out', /did not answer in time/],
    ['git_failed', /git could not read the working tree/],
  ] as const)('renders %s as "cannot verify" and says why', async (reason, sentence) => {
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, {
      body: dataBody(
        makeStatus({
          isGitWorkingTree: false,
          currentBranch: null,
          headSha: null,
          uncommittedFiles: null,
          ahead: null,
          behind: null,
          unavailableReason: reason,
        }),
      ),
    });

    renderTab();

    expect(await screen.findByText('cannot verify')).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
    // The screen never states a clean tree it did not read.
    expect(screen.queryByText('clean')).toBeNull();
  });

  it('renders a failed status request as unverifiable too, not as clean', async () => {
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom', requestId: 'test-req' } },
    });

    renderTab();

    expect(await screen.findByText(/cannot verify/)).toBeInTheDocument();
    expect(screen.getByText(/could not be read \(INTERNAL\)/)).toBeInTheDocument();
    expect(screen.queryByText('clean')).toBeNull();
  });

  it('rechecks every working tree on demand', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });

    renderTab();
    await screen.findByText('clean');
    const before = api.callsTo(`/repositories/${REPOSITORY_ID}/status`).length;

    await user.click(screen.getByRole('button', { name: 'Recheck working trees' }));

    await waitFor(() =>
      expect(api.callsTo(`/repositories/${REPOSITORY_ID}/status`).length).toBeGreaterThan(before),
    );
  });
});

describe('removing a repository', () => {
  it('confirms, states that nothing on disk is touched, and DELETEs', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });
    api.on('DELETE', `/api/v1/repositories/${REPOSITORY_ID}`, { status: 204 });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Remove MCS' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Remove MCS from Mission Control?',
    });
    expect(dialog).toHaveTextContent(/Nothing on disk is touched/);
    expect(dialog).toHaveTextContent('D:\\Repos\\MCS');

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'DELETE')).toBe(true));
  });

  it('surfaces the sessions-still-reference-it conflict with its count', async () => {
    const user = userEvent.setup();
    api.on('GET', '/api/v1/repositories', { body: listBody([makeRepository()]) });
    api.on('GET', `/api/v1/repositories/${REPOSITORY_ID}/status`, { body: dataBody(makeStatus()) });
    api.on('DELETE', `/api/v1/repositories/${REPOSITORY_ID}`, {
      status: 409,
      body: conflictBody('Repository is referenced by sessions', { sessions: 2 }),
    });

    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Remove MCS' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(
      await screen.findByText(/2 sessions still reference this repository/),
    ).toBeInTheDocument();
  });
});
