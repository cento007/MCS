import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchDisclosure, LaunchSessionModal } from './LaunchSessionModal.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
} from './test-support.js';

/**
 * The Launch modal's working-tree disclosure and branch-change acknowledgement (WS5 §5.4.1,
 * UX finding WC11).
 *
 * This is the most consequential dialog in the product: it hands an agentic runtime write
 * access to a directory. The gate is therefore asserted from both directions — it must appear
 * when a checkout would happen, and it must be *absent* when nothing would move, because
 * ceremony on the safe path trains operators to click through it on the unsafe one.
 */

const PROJECT = {
  id: '0198a2f3-9c41-7bd2-a10e-000000000001',
  workspaceId: '0198a2f3-9c41-7bd2-a10e-000000000000',
  name: 'mission-control',
  description: null,
  workflowMode: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  archivedAt: null,
};

const REPOSITORY = {
  id: '0198a2f3-9c41-7bd2-a10e-000000000002',
  projectId: PROJECT.id,
  name: 'MCS',
  localPath: 'D:\\Repos\\MCS',
  remoteUrl: null,
  visibility: 'private' as const,
  defaultBranch: 'main',
  lastSyncedAt: null,
  syncStatus: 'never' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/projects', { body: listBody([PROJECT]) });
  api.on('GET', '/repositories', { body: listBody([REPOSITORY]) });
});

afterEach(() => {
  api.restore();
});

describe('branchDisclosure — when the acknowledgement is mandatory', () => {
  it('is silent when no branch is requested', () => {
    expect(
      branchDisclosure({
        repositoryName: 'MCS',
        workingDirectory: 'D:\\Repos\\MCS',
        branch: '',
        status: null,
      }),
    ).toEqual({ kind: 'none', requiresAcknowledgement: false, message: null });
  });

  it('is silent when the requested branch is already checked out', () => {
    const result = branchDisclosure({
      repositoryName: 'MCS',
      workingDirectory: 'D:\\Repos\\MCS',
      branch: 'DEV',
      status: { currentBranch: 'DEV', uncommittedFiles: 3 },
    });
    expect(result.requiresAcknowledgement).toBe(false);
  });

  it('states exactly what will happen on a branch change and blocks until acknowledged', () => {
    const result = branchDisclosure({
      repositoryName: 'MCS',
      workingDirectory: 'D:\\Repos\\MCS',
      branch: 'DEV',
      status: { currentBranch: 'main', uncommittedFiles: 3 },
    });
    expect(result.kind).toBe('change');
    expect(result.requiresAcknowledgement).toBe(true);
    expect(result.message).toBe(
      'MCS will be checked out to ‹DEV› — 3 uncommitted files in ‹D:\\Repos\\MCS›.',
    );
  });

  it('treats "cannot verify" as a risk to disclose, not as safety to assume', () => {
    const result = branchDisclosure({
      repositoryName: 'MCS',
      workingDirectory: 'D:\\Repos\\MCS',
      branch: 'DEV',
      status: null,
    });
    expect(result.kind).toBe('unknown');
    expect(result.requiresAcknowledgement).toBe(true);
    expect(result.message).toContain('cannot read');
  });
});

describe('<LaunchSessionModal>', () => {
  it('shows the resolved absolute path, not a repository nickname', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);

    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT.id);
    await screen.findByRole('option', { name: 'MCS' });
    await user.selectOptions(screen.getByLabelText('Repository'), REPOSITORY.id);

    await waitFor(() =>
      expect(screen.getByLabelText('Working directory')).toHaveValue('D:\\Repos\\MCS'),
    );
  });

  it('blocks [Create] until the branch change is acknowledged', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LaunchSessionModal
        open
        onClose={() => {}}
        workingTree={{ currentBranch: 'main', uncommittedFiles: 3 }}
      />,
    );

    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT.id);
    await screen.findByRole('option', { name: 'MCS' });
    await user.selectOptions(screen.getByLabelText('Repository'), REPOSITORY.id);
    await waitFor(() => expect(screen.getByLabelText('Branch')).toHaveValue('main'));

    await user.clear(screen.getByLabelText('Branch'));
    await user.type(screen.getByLabelText('Branch'), 'DEV');

    const disclosure = screen.getByTestId('branch-disclosure');
    expect(disclosure).toHaveTextContent(
      'MCS will be checked out to ‹DEV› — 3 uncommitted files in ‹D:\\Repos\\MCS›.',
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'I understand' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('shows no disclosure at all when nothing would move', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LaunchSessionModal
        open
        onClose={() => {}}
        workingTree={{ currentBranch: 'DEV', uncommittedFiles: 3 }}
      />,
    );

    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT.id);
    await user.type(screen.getByLabelText('Working directory'), 'D:\\Repos\\MCS');
    await user.type(screen.getByLabelText('Branch'), 'DEV');

    expect(screen.queryByTestId('branch-disclosure')).toBeNull();
    // The dirty count is still shown as context, per §5.4.1.
    expect(screen.getByText(/3 uncommitted files/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('creates the Session in `created` and carries no initial-prompt field', async () => {
    const user = userEvent.setup();
    api.on('POST', '/sessions', { status: 201, body: dataBody(makeSession({ state: 'created' })) });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Project'), PROJECT.id);
    await user.type(screen.getByLabelText('Working directory'), 'D:\\Repos\\MCS');

    // §5.4.1: the composer IS the prompt field, one screen later.
    expect(screen.queryByLabelText(/prompt/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const created = api.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({
      projectId: PROJECT.id,
      workingDirectory: 'D:\\Repos\\MCS',
    });
  });

  it('reports the envelope instead of an empty picker when Projects is unavailable', async () => {
    api.on('GET', '/projects', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'req-1' } },
    });

    renderWithProviders(<LaunchSessionModal open onClose={() => {}} />);

    expect(
      await screen.findByText('Projects are unavailable, so a session cannot be composed'),
    ).toBeInTheDocument();
    expect(screen.getByText('NOT_FOUND')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
