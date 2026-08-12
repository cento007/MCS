import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsListPage } from './SessionsListPage.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
} from './test-support.js';

/**
 * The Sessions list (TDS 06 §5.4) — identity rendering, filters and cursor pagination.
 */

let api: ApiMock;

const RUNNING = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1',
  title: 'Refactor queue port to batch enqueue',
  state: 'running',
});
const ARCHIVED = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b4fa1c7',
  title: 'Spike pg-boss retry policy',
  state: 'archived',
});

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/sessions', { body: listBody([RUNNING, ARCHIVED]) });
});

afterEach(() => {
  api.restore();
});

describe('identity rendering (§9.3 / §5.4)', () => {
  it('leads with the title and demotes the id to its last six characters', async () => {
    renderWithProviders(<SessionsListPage />);

    await screen.findByText('Refactor queue port to batch enqueue');
    // A UUIDv7 prefix is the millisecond the Session started — the least discriminating
    // substring available. The tail is random, and therefore actually distinguishing.
    expect(screen.getByText('…1c4fa1')).toBeInTheDocument();
    expect(screen.queryByText(/^0198a2f3/)).toBeNull();
  });

  it('shows the full id in the title attribute for copy-on-click', async () => {
    renderWithProviders(<SessionsListPage />);
    const idCell = await screen.findByTitle('0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1');
    expect(idCell).toHaveTextContent('…1c4fa1');
  });
});

describe('filters', () => {
  it('excludes archived Sessions until the operator asks for them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsListPage />);

    await screen.findByText('Refactor queue port to batch enqueue');
    expect(screen.queryByText('Spike pg-boss retry policy')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: /Show archived/ }));
    expect(screen.getByText('Spike pg-boss retry policy')).toBeInTheDocument();
  });

  it('sends the F7 state filter verbatim to the API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsListPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    await user.click(screen.getByRole('button', { name: 'paused' }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('state=paused'))).toBe(true),
    );
  });

  it('sends `sessionType`, the one API spelling (N1)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsListPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    await user.selectOptions(screen.getByLabelText('Filter by type'), 'observed');

    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('sessionType=observed'))).toBe(true),
    );
  });

  it('omits the project filter entirely when the Projects API does not answer', async () => {
    renderWithProviders(<SessionsListPage />);
    await screen.findByText('Refactor queue port to batch enqueue');
    // An empty dropdown would read as "no projects exist" — a claim this client cannot make.
    await waitFor(() => expect(screen.queryByLabelText('Filter by project')).toBeNull());
  });

  it('distinguishes "no sessions" from "no matches"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsListPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    await user.type(screen.getByLabelText('Search sessions'), 'zzzz');
    expect(screen.getByText('No sessions match these filters.')).toBeInTheDocument();
  });
});

describe('cursor pagination (F5.3)', () => {
  it('offers Load more while a cursor remains, and never page numbers', async () => {
    const user = userEvent.setup();
    api.on('GET', '/sessions', (call) =>
      call.url.includes('cursor=')
        ? {
            body: listBody([
              makeSession({ id: 'aaaaaaaa-0000-7000-8000-00000000beef', title: 'Older session' }),
            ]),
          }
        : { body: listBody([RUNNING], 'opaque-cursor') },
    );

    renderWithProviders(<SessionsListPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('Older session');
    expect(api.calls.some((call) => call.url.includes('cursor=opaque-cursor'))).toBe(true);
  });
});

describe('row actions', () => {
  it('offers only state-legal actions and confirms the destructive ones', async () => {
    const user = userEvent.setup();
    api.on('GET', '/sessions', { body: listBody([RUNNING]) });
    api.on('POST', '/end', { body: dataBody(makeSession({ state: 'completed' })) });

    renderWithProviders(<SessionsListPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    await user.click(screen.getByRole('button', { name: /Actions for Refactor queue port/ }));

    expect(screen.getByRole('menuitem', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'End' })).toBeInTheDocument();
    // `running` has no legal edge to `archived` in F7, so it is never offered.
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    // A list row has no live buffer, so the turn-level control is not one of its options.
    expect(screen.queryByRole('menuitem', { name: 'Stop' })).toBeNull();

    await user.click(screen.getByRole('menuitem', { name: 'End' }));
    expect(await screen.findByRole('dialog', { name: 'End this session?' })).toBeInTheDocument();
  });
});
