import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsListPage } from '../../features/sessions/SessionsListPage.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
} from '../../features/sessions/test-support.js';
import { CommandPalette } from './CommandPalette.js';

/**
 * `Ctrl+K` session actions (TDS 05 §9.4).
 *
 * The palette must derive its lifecycle candidates "from the cached Session's F7 state using
 * the same predicate as §6.6". These tests pin both halves of that: the *same* predicate, and
 * the *same* non-optimistic execution path.
 */

let api: ApiMock;

const RUNNING = makeSession({ id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1', state: 'running' });
const FAILED = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b4fa1c7',
  title: 'Rewrite frontmatter parser',
  state: 'failed',
});

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/sessions', { body: listBody([RUNNING, FAILED]) });
});

afterEach(() => {
  api.restore();
});

describe('session actions in the palette', () => {
  it('merges the background session fetch in when it lands', async () => {
    renderWithProviders(<CommandPalette open onClose={() => {}} />);

    // Opening triggers no blocking fetch — the palette renders immediately with its static
    // commands — but the session results must appear without a second open.
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: /Refactor queue port/ }).length).toBeGreaterThan(
        0,
      ),
    );
  });

  it('offers only state-legal actions, per F7', async () => {
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    await screen.findAllByRole('option', { name: /Refactor queue port/ });

    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');

    // `running` → Pause / End. `failed` → Resume as new / Clone / Archive.
    expect(options.some((text) => text.includes('Pause — Refactor queue port'))).toBe(true);
    expect(options.some((text) => text.includes('Archive — Rewrite frontmatter parser'))).toBe(
      true,
    );
    // Never a transition F7 has no edge for.
    expect(options.some((text) => text.includes('Archive — Refactor queue port'))).toBe(false);
    expect(
      options.some((text) => text.includes('Resume as new session — Refactor queue port')),
    ).toBe(false);
    // `[Stop]` is a turn control and the palette cannot know whether a turn is in flight.
    expect(options.some((text) => text.startsWith('Stop'))).toBe(false);
  });

  it('confirms a destructive action and then runs it through the shared path', async () => {
    const user = userEvent.setup();
    api.on('POST', '/archive', { body: dataBody(makeSession({ state: 'archived' })) });

    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    await screen.findAllByRole('option', { name: /Refactor queue port/ });

    await user.type(screen.getByRole('combobox'), 'Archive');
    await user.click(await screen.findByRole('option', { name: /Archive — Rewrite/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Archive this session?' });
    expect(dialog).toBeInTheDocument();
    expect(api.callsTo('/archive')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.callsTo('/archive')).toHaveLength(1));
    expect(api.callsTo('/archive')[0]?.url).toContain(FAILED.id);
  });

  it('does not share a cache slot with the Sessions list screen', async () => {
    // Regression: both surfaces read `['sessions']` with the same filters, but the list stores
    // `InfiniteData` and the palette a flat array. Sharing the slot crashed the whole shell on
    // `Ctrl+K` — caught by running the app, not by a unit test, which is why one exists now.
    renderWithProviders(
      <>
        <SessionsListPage />
        <CommandPalette open onClose={() => {}} />
      </>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: /Refactor queue port/ }).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
  });
});
