import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiMock,
  makeScheduleEntry,
  mockApi,
  renderWithProviders,
  stubDashboard,
} from './test-support.js';
import { UpcomingTasksWidget } from './UpcomingTasksWidget.js';

/**
 * Upcoming Tasks (TDS 06 §5.2, TDS 04 §7.7, WS7 arbitration A1).
 *
 * The two things this suite guards are the two things the arbitration turned on: the widget
 * says out loud that these are system-scheduled runs (no Task entity exists or is implied),
 * and a disabled row is rendered honestly instead of being hidden.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
});

afterEach(() => {
  api.restore();
});

describe('schedule read model', () => {
  it('names the rows as system-scheduled runs, not user to-dos', async () => {
    stubDashboard(api, { schedule: [makeScheduleEntry()] });

    renderWithProviders(<UpcomingTasksWidget />);

    await screen.findByText('GitHub repository poll');
    expect(
      screen.getByText('System-scheduled runs — set in Settings, not a to-do list'),
    ).toBeInTheDocument();
  });

  it('renders a disabled row honestly, with the route to enabling it', async () => {
    stubDashboard(api, {
      schedule: [
        makeScheduleEntry({
          kind: 'obsidian_sync',
          label: 'Obsidian vault sync',
          enabled: false,
          nextRunAt: null,
          lastRunAt: null,
        }),
        makeScheduleEntry({
          kind: 'github_poll',
          nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      ],
    });

    renderWithProviders(<UpcomingTasksWidget />);

    const disabled = await screen.findByTestId('schedule-obsidian_sync');
    expect(disabled).toHaveTextContent('Obsidian vault sync');
    expect(disabled).toHaveTextContent('Not scheduled');
    expect(disabled).toHaveTextContent('never run');
    expect(within(disabled).getByRole('link', { name: 'enable in Settings' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );

    // The enabled row still counts down; the disabled one sinks below it but stays visible.
    expect(screen.getByTestId('schedule-github_poll')).toHaveTextContent('in 14m');
  });

  it('offers an actionable empty state when the schedule is empty', async () => {
    stubDashboard(api, { schedule: [] });

    renderWithProviders(<UpcomingTasksWidget />);

    expect(await screen.findByText('No scheduled work')).toBeInTheDocument();
    expect(screen.getByText('Set sync intervals in Settings.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('reports an overdue run as due rather than hiding it', async () => {
    stubDashboard(api, {
      schedule: [makeScheduleEntry({ nextRunAt: new Date(Date.now() - 5 * 60_000).toISOString() })],
    });

    renderWithProviders(<UpcomingTasksWidget />);

    expect(await screen.findByText(/due now/)).toBeInTheDocument();
  });
});
