import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DashboardPage } from './DashboardPage.js';
import {
  type ApiMock,
  makeNotification,
  makeProject,
  makeScheduleEntry,
  makeServiceRow,
  makeSession,
  makeSpend,
  mockApi,
  PROJECT_ID,
  renderWithProviders,
  setSocketOffline,
  stubDashboard,
} from './test-support.js';

/**
 * The Dashboard as a page (TDS 06 §5.2) — the widget order, which is the specification, and
 * the cross-widget behaviours: identity rendering, deep links and the §3.3 degraded treatment.
 */

let api: ApiMock;

const RUNNING = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1',
  title: 'Refactor queue port to batch enqueue',
  state: 'running',
  branch: 'DEV',
  projectId: PROJECT_ID,
});

const PAUSED = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b4fa1c7',
  title: 'Fix nginx TLS renewal',
  state: 'paused',
  branch: 'main',
  projectId: PROJECT_ID,
});

beforeEach(() => {
  api = mockApi();
  stubDashboard(api, {
    sessions: [RUNNING, PAUSED],
    services: [
      makeServiceRow({ name: 'postgresql', label: 'PostgreSQL', status: 'healthy' }),
      makeServiceRow({ name: 'qdrant', label: 'Qdrant', status: 'disabled' }),
    ],
    spend: makeSpend({ dayStatus: 'ok' }),
    schedule: [makeScheduleEntry()],
    notifications: [makeNotification()],
    projects: [makeProject({ name: 'mission-control' })],
  });
});

afterEach(() => {
  api.restore();
});

describe('widget order (§5.2)', () => {
  it('puts Needs Attention first and follows the specified sequence', async () => {
    // Re-stubbed with a failure so Needs Attention renders its card form; the "all clear"
    // form is a rule with no heading, which the empty-state suite covers instead.
    stubDashboard(api, {
      sessions: [RUNNING, PAUSED, makeSession({ id: 'f-1', state: 'failed', title: 'Broke' })],
      spend: makeSpend({ dayStatus: 'ok' }),
    });

    renderWithProviders(<DashboardPage />);

    await screen.findByText(/Session failed/);

    // The DOM order is the grid order is the mobile stack order is the screen-reader order.
    // An operator opening this page asks "what is broken?" before anything else.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual([
      expect.stringContaining('Needs attention'),
      expect.stringContaining('Active sessions'),
      expect.stringContaining('Spend (today)'),
      expect.stringContaining('Active projects'),
      expect.stringContaining('Services'),
      expect.stringContaining('Recent ADRs'),
      expect.stringContaining('Upcoming tasks'),
      expect.stringContaining('Notifications'),
    ]);
  });

  it('links each widget to the screen that owns its data', async () => {
    renderWithProviders(<DashboardPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    expect(screen.getByRole('link', { name: 'View all sessions' })).toHaveAttribute(
      'href',
      '/sessions',
    );
    expect(screen.getByRole('link', { name: 'View all projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.getByRole('link', { name: 'View service health' })).toHaveAttribute(
      'href',
      '/settings/services',
    );
    expect(screen.getByRole('link', { name: 'Open integration settings' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });
});

describe('Active Sessions', () => {
  it('shows only running and paused, title-first, with no id anywhere', async () => {
    renderWithProviders(<DashboardPage />);

    const widget = await screen.findByRole('region', { name: /Active sessions/i });
    expect(
      await within(widget).findByText('Refactor queue port to batch enqueue'),
    ).toBeInTheDocument();
    expect(within(widget).getByText('Fix nginx TLS renewal')).toBeInTheDocument();
    // §9.3: no UUIDv7 prefix, no id column, in this widget at all.
    expect(widget.textContent).not.toMatch(/0198a2f3/);
    // The secondary line is `project · branch`.
    expect(within(widget).getByText('mission-control · DEV')).toBeInTheDocument();
  });

  it('freezes durations with a `~` when the socket is not live', async () => {
    renderWithProviders(<DashboardPage />);
    const widget = await screen.findByRole('region', { name: /Active sessions/i });
    expect(within(widget).queryByText(/~\d+:\d{2}:\d{2}/)).toBeNull();

    act(() => setSocketOffline());

    // A counter that keeps incrementing on a dead socket claims the Session is confirmed
    // alive when the truth is unknown. The `~` marks it last-known.
    expect(within(widget).getAllByText(/~\d+:\d{2}:\d{2}/).length).toBeGreaterThan(0);
  });
});

describe('Services strip', () => {
  it('renders `disabled` as its own status, never as a failure', async () => {
    renderWithProviders(<DashboardPage />);

    const widget = await screen.findByRole('region', { name: /^Services/i });
    expect(await within(widget).findByLabelText('Qdrant: disabled')).toBeInTheDocument();
    expect(within(widget).getByLabelText('PostgreSQL: healthy')).toBeInTheDocument();
    // …and it is not promoted into Needs Attention.
    const attention = await screen.findByTestId('needs-attention-all-clear');
    expect(attention).toHaveTextContent('All clear');
  });
});

describe('Recent ADRs (Phase 2)', () => {
  it('renders the phase note instead of calling an endpoint that does not exist', async () => {
    renderWithProviders(<DashboardPage />);
    await screen.findByText('Refactor queue port to batch enqueue');

    const widget = screen.getByRole('region', { name: /Recent ADRs/i });
    expect(widget).toHaveTextContent('Phase 2');
    expect(api.callsTo('/adrs')).toHaveLength(0);
  });
});
