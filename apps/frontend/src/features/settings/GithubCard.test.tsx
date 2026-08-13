import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDateTime } from '../../lib/format/index.js';
import { type ApiMock, dataBody, mockApi } from '../../test/api-mock.js';
import { GithubCard } from './panels/GithubCard.js';
import { GITHUB_TOKEN_SAVED_AT, makeIntegrations, renderPanel } from './test-support.js';

/**
 * Integrations → GitHub: the secret flow and the Test Connection gate (TDS 06 §4.4, §5.7.2/3).
 *
 * These two behaviours are the difference between a trustworthy Settings screen and a
 * dangerous one, so they are asserted through the real card rather than through the primitives
 * in isolation — the hazard is precisely that a correct `SecretField` and a correct
 * `TestConnection` can still be wired together wrongly.
 */

const REPLACED_SAVED_AT = '2026-08-13T11:22:00.000Z';

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/settings/integrations', { body: dataBody(makeIntegrations()) });
  api.on('GET', '/spend', { status: 404, body: notFound() });
});

afterEach(() => {
  api.restore();
});

function notFound(): unknown {
  return { error: { code: 'NOT_FOUND', message: 'not served', requestId: 'test-req' } };
}

/** The masked document the Backend answers with after a successful save (§7.3). */
function savedGithub(overrides: Record<string, unknown> = {}): unknown {
  const base = makeIntegrations().github;
  return dataBody({
    ...base,
    token: { isSet: true, updatedAt: REPLACED_SAVED_AT },
    ...overrides,
  });
}

async function loaded(): Promise<void> {
  await screen.findByText('Personal access token');
}

/** The body of the GitHub `PUT`, so every assertion reads the same request the same way. */
function putBody(mock: ApiMock): Record<string, unknown> {
  const put = mock.callsTo('/settings/integrations/github').find((call) => call.method === 'PUT');
  expect(put, 'expected a PUT to /settings/integrations/github').toBeDefined();
  return (put?.body ?? {}) as Record<string, unknown>;
}

describe('SecretField — one commit path (§4.4)', () => {
  it('shows the masked value with its saved timestamp, never the value', async () => {
    renderPanel(<GithubCard />);
    await loaded();

    expect(screen.getByTestId('secret-mask-token')).toHaveTextContent('••••••••••••');
    expect(screen.getByTestId('secret-saved-token')).toHaveTextContent(
      `(saved ${formatDateTime(GITHUB_TOKEN_SAVED_AT)})`,
    );
  });

  it('offers no save button of its own — [Replace] only unlocks the input', async () => {
    const user = userEvent.setup();
    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Replace' }));

    const field = screen.getByTestId('secret-token');
    // The panel's [Save changes] is the sole commit path. A [Save] here is the failure mode
    // §4.4 calls the worst on the whole Settings surface.
    expect(within(field).queryByRole('button', { name: /^save/i })).toBeNull();
    expect(within(field).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('never pre-fills the replacement input', async () => {
    const user = userEvent.setup();
    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByLabelText('Personal access token')).toHaveValue('');
  });

  it('counts a typed secret as a change and names it in the Save bar', async () => {
    const user = userEvent.setup();
    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    // Unlocking alone is not a change.
    expect(screen.queryByTestId('save-bar')).toBeNull();

    await user.type(screen.getByLabelText('Personal access token'), 'ghp_new');
    expect(
      within(screen.getByTestId('save-bar')).getByText('1 change (incl. 1 secret)'),
    ).toBeInTheDocument();
  });

  it('Replace → Save → masked again with a FRESH saved timestamp', async () => {
    const user = userEvent.setup();
    api.on('PUT', '/settings/integrations/github', { body: savedGithub() });

    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_new');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The changed timestamp is the only honest confirmation a write-only value can have.
    await waitFor(() =>
      expect(screen.getByTestId('secret-saved-token')).toHaveTextContent(
        `(saved ${formatDateTime(REPLACED_SAVED_AT)})`,
      ),
    );
    expect(screen.getByTestId('secret-mask-token')).toBeInTheDocument();
    expect(screen.queryByTestId('save-bar')).toBeNull();

    expect(putBody(api)['token']).toBe('ghp_new');
  });

  it('omits an untouched secret from the save body entirely (§7.1)', async () => {
    const user = userEvent.setup();
    api.on('PUT', '/settings/integrations/github', {
      body: dataBody({ ...makeIntegrations().github, account: 'someone-else' }),
    });

    renderPanel(<GithubCard />);
    await loaded();

    const account = screen.getByLabelText('Account');
    await user.clear(account);
    await user.type(account, 'someone-else');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        api.callsTo('/settings/integrations/github').some((call) => call.method === 'PUT'),
      ).toBe(true),
    );
    const put = api.callsTo('/settings/integrations/github').find((call) => call.method === 'PUT');
    // Omitted keeps; `null` would have cleared the stored PAT as a side effect of renaming an
    // account, which is the exact accident the write shape exists to prevent.
    expect(put?.body).not.toHaveProperty('token');
  });

  it('[Clear] is confirmed separately and commits on its own, not through the Save bar', async () => {
    const user = userEvent.setup();
    api.on('PUT', '/settings/integrations/github', {
      body: dataBody({ ...makeIntegrations().github, token: { isSet: false, updatedAt: null } }),
    });

    renderPanel(<GithubCard />);
    await loaded();

    // An unrelated pending edit must NOT ride along with the destroy.
    const account = screen.getByLabelText('Account');
    await user.clear(account);
    await user.type(account, 'not-committed');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        /Repository discovery, commit and pull-request sync will stop working/,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(putBody(api)['token']).toBeNull());
    // The pending account edit did NOT ride along: `[Clear]` commits the persisted document
    // with one field destroyed, never the operator's other unsaved work.
    expect(putBody(api)['account']).toBe('cento007');
  });

  it('does not clear when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(api.callsTo('/settings/integrations/github').some((c) => c.method === 'PUT')).toBe(
      false,
    );
    expect(screen.getByTestId('secret-mask-token')).toBeInTheDocument();
  });
});

describe('Test Connection — always tests persisted state (§5.7.2)', () => {
  it('is enabled on a clean panel and labels its result as saved settings', async () => {
    const user = userEvent.setup();
    api.on('POST', '/settings/integrations/github/test-connection', {
      body: dataBody({
        ok: true,
        checkedAt: '2026-08-13T12:07:00.000Z',
        latencyMs: 231,
        message: 'Authenticated',
        detail: { account: 'cento007' },
      }),
    });

    renderPanel(<GithubCard />);
    await loaded();

    const button = screen.getByRole('button', { name: 'Test Connection' });
    expect(button).toBeEnabled();
    await user.click(button);

    const result = await screen.findByTestId('test-result-github');
    expect(result).toHaveTextContent('Tested saved settings');
    expect(result).toHaveTextContent('Connected as cento007');
    expect(result).toHaveTextContent('231 ms');
  });

  it('is DISABLED while the panel is dirty, with the "Save changes to test" hint', async () => {
    const user = userEvent.setup();
    renderPanel(<GithubCard />);
    await loaded();

    await user.type(screen.getByLabelText('Account'), 'x');

    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled();
    expect(screen.getByText('Save changes to test')).toBeInTheDocument();
  });

  it('is disabled while a pasted-but-unsaved secret is pending — the core hazard', async () => {
    const user = userEvent.setup();
    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_pasted');

    // Without this, the operator sees ✓ Connected against a token that was never persisted.
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled();
    expect(screen.getByText('Save changes to test')).toBeInTheDocument();
  });

  it('re-enables after the save lands', async () => {
    const user = userEvent.setup();
    api.on('PUT', '/settings/integrations/github', { body: savedGithub() });

    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_new');
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test Connection' })).toBeEnabled(),
    );
  });

  it('discards a stale result the moment the panel goes dirty again', async () => {
    const user = userEvent.setup();
    api.on('POST', '/settings/integrations/github/test-connection', {
      body: dataBody({
        ok: true,
        checkedAt: '2026-08-13T12:07:00.000Z',
        latencyMs: 12,
        message: 'Authenticated',
        detail: null,
      }),
    });

    renderPanel(<GithubCard />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Test Connection' }));
    await screen.findByTestId('test-result-github');

    await user.type(screen.getByLabelText('Account'), 'x');
    // A green tick describing the previous configuration must not linger beside edited fields.
    expect(screen.queryByTestId('test-result-github')).toBeNull();
  });

  it('renders an integration that says no as a result, not as a broken request', async () => {
    const user = userEvent.setup();
    api.on('POST', '/settings/integrations/github/test-connection', {
      body: dataBody({
        ok: false,
        checkedAt: '2026-08-13T12:07:00.000Z',
        latencyMs: null,
        message: 'Token rejected by GitHub (401).',
        detail: null,
      }),
    });

    renderPanel(<GithubCard />);
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));

    const result = await screen.findByTestId('test-result-github');
    expect(result).toHaveTextContent('Tested saved settings · Token rejected by GitHub (401).');
    expect(screen.queryByTestId('test-error-github')).toBeNull();
  });

  it('renders a refused request with its code and requestId', async () => {
    const user = userEvent.setup();
    api.on('POST', '/settings/integrations/github/test-connection', {
      status: 409,
      body: {
        error: {
          code: 'INTEGRATION_NOT_CONFIGURED',
          message: 'No token stored',
          requestId: '0198a2f3-req',
        },
      },
    });

    renderPanel(<GithubCard />);
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));

    const failure = await screen.findByTestId('test-error-github');
    expect(failure).toHaveTextContent('INTEGRATION_NOT_CONFIGURED');
    // `X-Request-Id` wins over the envelope's copy (`lib/api/client.ts`) — the header is what
    // the Backend logged the request under. The mock stamps `test-req` on every response.
    expect(failure).toHaveTextContent('test-req');
  });
});

describe('when the Backend does not serve the route', () => {
  it('disables the fields and names the missing route instead of showing defaults', async () => {
    api.on('GET', '/settings/integrations', { status: 404, body: notFound() });
    renderPanel(<GithubCard />);

    const note = await screen.findByTestId('endpoint-unavailable');
    expect(note).toHaveTextContent('/api/v1/settings/integrations/github');
    expect(screen.getByLabelText('Account')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled();
    // No fabricated interval, no fabricated workflow mode, no fake "Not set" credential state.
    expect(screen.queryByTestId('save-bar')).toBeNull();
  });
});
