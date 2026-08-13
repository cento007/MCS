import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiMock, dataBody, listBody, mockApi } from '../../test/api-mock.js';
import { ApiTokensSection } from './panels/ApiTokens.js';
import { makeToken, renderPanel } from './test-support.js';

/**
 * API tokens (PRD §4.4.6, TDS 04 §3.2–3.3, TDS 06 §5.7.11).
 *
 * The single guarantee under test is "shown exactly once". It is hashed at rest, so nothing
 * downstream can recover it — which makes the UI the only place the promise can be broken, and
 * these assertions the only thing that notices if it is.
 */

const RAW_TOKEN = 'mct_a1b2c3d4e5f60718293a4b5c6d7e8f90';

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/auth/tokens', { body: listBody([makeToken()]) });
});

afterEach(() => {
  api.restore();
});

describe('token list', () => {
  it('renders the prefix and never a full value', async () => {
    renderPanel(<ApiTokensSection />);
    expect(await screen.findByText('cli-laptop')).toBeInTheDocument();
    expect(screen.getByText('mct_a1b2…')).toBeInTheDocument();
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('offers an empty state rather than a bare table', async () => {
    api.on('GET', '/auth/tokens', { body: listBody([]) });
    renderPanel(<ApiTokensSection />);
    expect(await screen.findByText('No API tokens')).toBeInTheDocument();
  });
});

describe('creation shows the value exactly once', () => {
  it('reveals it with the "you won\'t see this again" warning, then never again', async () => {
    const user = userEvent.setup();
    api.on('POST', '/auth/tokens', {
      status: 201,
      body: dataBody({ ...makeToken({ name: 'obsidian', prefix: 'mct_9f3e' }), token: RAW_TOKEN }),
    });

    renderPanel(<ApiTokensSection />);
    await screen.findByText('cli-laptop');

    await user.click(screen.getByRole('button', { name: '+ Create token' }));
    await user.type(screen.getByLabelText('Name'), 'obsidian');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const revealed = await screen.findByTestId('created-token-value');
    expect(revealed).toHaveTextContent(RAW_TOKEN);
    expect(screen.getByText("You won't see this again.")).toBeInTheDocument();

    // Dismiss: the only copy leaves memory here.
    await user.click(screen.getByRole('button', { name: "I've stored it" }));

    await waitFor(() => expect(screen.queryByTestId('created-token-value')).toBeNull());
    expect(screen.queryByText(RAW_TOKEN)).toBeNull();

    // Re-opening the dialog must not resurrect it.
    await user.click(screen.getByRole('button', { name: '+ Create token' }));
    expect(screen.queryByTestId('created-token-value')).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('keeps the raw value out of the query cache', async () => {
    const user = userEvent.setup();
    api.on('POST', '/auth/tokens', {
      status: 201,
      body: dataBody({ ...makeToken({ name: 'obsidian' }), token: RAW_TOKEN }),
    });

    const { queryClient } = renderPanel(<ApiTokensSection />);
    await screen.findByText('cli-laptop');

    await user.click(screen.getByRole('button', { name: '+ Create token' }));
    await user.type(screen.getByLabelText('Name'), 'obsidian');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByTestId('created-token-value');

    // The cache is long-lived and inspectable, and any persistence layer added later would
    // write it to disk. The credential must not be in it at any point.
    const dumped = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state.data),
    );
    expect(dumped).not.toContain(RAW_TOKEN);
  });

  it('blocks [Create] until the token is named', async () => {
    const user = userEvent.setup();
    renderPanel(<ApiTokensSection />);
    await screen.findByText('cli-laptop');

    await user.click(screen.getByRole('button', { name: '+ Create token' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'x');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });
});

describe('revoke', () => {
  it('requires a confirm that names the token and its consequence', async () => {
    const user = userEvent.setup();
    // Stateful, so the assertion survives the refetch that follows the optimistic removal —
    // a row that comes back because the list was re-read is exactly the bug worth catching.
    let remaining = [makeToken()];
    api.on('GET', '/auth/tokens', () => ({ body: listBody(remaining) }));
    api.on('DELETE', '/auth/tokens/', () => {
      remaining = [];
      return { status: 204 };
    });

    renderPanel(<ApiTokensSection />);
    await screen.findByText('cli-laptop');

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('cli-laptop');
    expect(dialog).toHaveTextContent('it cannot be restored');

    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.queryByText('cli-laptop')).toBeNull());
  });

  it('does nothing when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    renderPanel(<ApiTokensSection />);
    await screen.findByText('cli-laptop');

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(screen.getByText('cli-laptop')).toBeInTheDocument();
  });
});
