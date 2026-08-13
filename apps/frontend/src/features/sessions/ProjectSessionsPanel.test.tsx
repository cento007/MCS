import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectSessionsPanel } from './ProjectSessionsPanel.js';
import {
  type ApiMock,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
} from './test-support.js';

/**
 * The Project detail's Sessions tab (TDS 06 §5.3.2) — the §5.4 table, pre-filtered.
 *
 * The point of these tests is that it is the *same* table: the identity rule, the state
 * vocabulary and the row menu are inherited from `SessionsTable`, not re-implemented, so this
 * suite checks the filtering and the empty states and trusts the shared component for the rest.
 */

let api: ApiMock;

const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';

const RUNNING = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1',
  projectId: PROJECT_ID,
  title: 'Refactor queue port to batch enqueue',
  state: 'running',
});

const ARCHIVED = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b4fa1c7',
  projectId: PROJECT_ID,
  title: 'Spike pg-boss retry policy',
  state: 'archived',
});

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/api/v1/sessions', { body: listBody([RUNNING, ARCHIVED]) });
});

afterEach(() => {
  api.restore();
});

it('asks the API for this project’s sessions only', async () => {
  renderWithProviders(<ProjectSessionsPanel projectId={PROJECT_ID} />);

  await screen.findByText('Refactor queue port to batch enqueue');
  expect(api.calls.some((call) => call.url.includes(`projectId=${PROJECT_ID}`))).toBe(true);
});

it('renders the shared Sessions table, identity rule included', async () => {
  renderWithProviders(<ProjectSessionsPanel projectId={PROJECT_ID} />);

  await screen.findByText('Refactor queue port to batch enqueue');
  // Same demoted-id column as §5.4 — the last six hex characters, never a UUIDv7 prefix.
  expect(screen.getByText('…1c4fa1')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'State' })).toBeInTheDocument();
});

it('excludes archived sessions until asked, and says so in the empty state', async () => {
  const user = userEvent.setup();
  renderWithProviders(<ProjectSessionsPanel projectId={PROJECT_ID} />);

  await screen.findByText('Refactor queue port to batch enqueue');
  expect(screen.queryByText('Spike pg-boss retry policy')).toBeNull();

  await user.click(screen.getByRole('checkbox', { name: /Show archived/ }));
  expect(screen.getByText('Spike pg-boss retry policy')).toBeInTheDocument();
});

it('distinguishes "nothing active" from "nothing at all"', async () => {
  const user = userEvent.setup();
  api.on('GET', '/api/v1/sessions', { body: listBody([ARCHIVED]) });

  renderWithProviders(<ProjectSessionsPanel projectId={PROJECT_ID} />);

  expect(await screen.findByText('No active sessions in this project.')).toBeInTheDocument();
  expect(screen.getByText(/tick .Show archived. to include them/)).toBeInTheDocument();

  await user.click(screen.getByRole('checkbox', { name: /Show archived/ }));
  expect(screen.getByText('Spike pg-boss retry policy')).toBeInTheDocument();
});

it('paginates by cursor, never by page number', async () => {
  const user = userEvent.setup();
  api.on('GET', '/api/v1/sessions', (call) =>
    call.url.includes('cursor=')
      ? {
          body: listBody([makeSession({ id: 'a', projectId: PROJECT_ID, title: 'Older session' })]),
        }
      : { body: listBody([RUNNING], 'opaque-cursor') },
  );

  renderWithProviders(<ProjectSessionsPanel projectId={PROJECT_ID} />);
  await screen.findByText('Refactor queue port to batch enqueue');

  await user.click(screen.getByRole('button', { name: 'Load more' }));

  await screen.findByText('Older session');
  expect(api.calls.some((call) => call.url.includes('cursor=opaque-cursor'))).toBe(true);
});

it('offers a launch entry point scoped to this project', async () => {
  renderWithProviders(<ProjectSessionsPanel projectId={PROJECT_ID} />);
  await screen.findByText('Refactor queue port to batch enqueue');

  // The Launch modal belongs to the Sessions list screen (TDS 05 §2.1). `?projectId=` is how
  // "pre-scoped to this Project" (§5.3.2) survives the hand-off without a second modal; the
  // seeding half of that contract is asserted in `SessionsListPage.test.tsx`.
  expect(screen.getByRole('button', { name: '+ New Session' })).toBeInTheDocument();
});
