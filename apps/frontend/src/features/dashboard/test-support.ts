import type {
  Notification,
  Project,
  ScheduleEntry,
  ServiceHealthRow,
  Session,
  Spend,
  SpendDayStatus,
} from '../../lib/api/index.js';
import { type ApiMock, listBody } from '../../test/api-mock.js';

/**
 * Dashboard fixtures.
 *
 * The `fetch` stub comes from `src/test/api-mock.ts`, the shared home for it. The **render
 * harness** (`renderWithProviders`) and the Session fixture still come from the Sessions
 * slice: duplicating a provider tree produces two subtly different definitions of "rendered
 * like the app does", and a second `makeSession` would drift from the resource shape the
 * Sessions suites assert against. The rule this bends — no cross-feature imports (TDS 05
 * §2.1) — governs the shipped bundle, and no `test-support` module is in it.
 *
 * No database and no network anywhere: `pnpm test` has to run on a bare checkout (TDS 07 §4).
 */
export { type ApiMock, dataBody, listBody, mockApi } from '../../test/api-mock.js';
export {
  makeSession,
  renderWithProviders,
  setSocketLive,
  setSocketOffline,
} from '../sessions/test-support.js';

export const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';

export interface DashboardStub {
  readonly sessions?: readonly Session[];
  readonly services?: readonly ServiceHealthRow[];
  readonly spend?: Spend;
  readonly schedule?: readonly ScheduleEntry[];
  readonly notifications?: readonly Notification[];
  readonly projects?: readonly Project[];
}

/**
 * Answer every endpoint the Dashboard touches.
 *
 * Sessions are filtered by the `?state=` in the request rather than returned wholesale,
 * because the widgets are built on that filter (`running`/`paused` for Active Sessions,
 * `failed` for Needs Attention) and a stub that ignored it would make every widget look
 * correct while hiding a wrong query.
 */
export function stubDashboard(api: ApiMock, stub: DashboardStub = {}): void {
  const sessions = stub.sessions ?? [];

  api.on('GET', '/sessions', (call) => {
    const state = new URL(call.url, 'http://localhost').searchParams.get('state');
    const matching = state === null ? sessions : sessions.filter((row) => row.state === state);
    return { body: listBody(matching) };
  });
  api.on('GET', '/services/health', { body: { data: { services: stub.services ?? [] } } });
  api.on('GET', '/spend', { body: { data: stub.spend ?? makeSpend() } });
  api.on('GET', '/schedule', { body: { data: stub.schedule ?? [] } });
  api.on('GET', '/notifications', { body: listBody(stub.notifications ?? []) });
  api.on('GET', '/projects', { body: listBody(stub.projects ?? [makeProject()]) });
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    workspaceId: '0198a2f3-9c41-7bd2-a10e-0000000000ff',
    name: 'mission-control',
    description: null,
    workflowMode: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

export function makeServiceRow(overrides: Partial<ServiceHealthRow> = {}): ServiceHealthRow {
  return {
    name: 'postgresql',
    label: 'PostgreSQL',
    status: 'healthy',
    detail: '4 ms',
    checkedAt: '2026-08-13T12:00:00.000Z',
    meta: null,
    ...overrides,
  };
}

/**
 * A `Spend` resource. `dayStatus` is passed in rather than derived, because the client must
 * never derive it — that is the whole point of TDS 04 §7.8, and a fixture that computed it
 * would let a component quietly start deriving it too without a test noticing.
 */
export function makeSpend(
  options: {
    dayTotal?: number;
    monthTotal?: number;
    dailyUsd?: number | null;
    alertThresholdPercent?: number;
    alertsEnabled?: boolean;
    dayStatus?: SpendDayStatus;
    sessionCount?: number;
  } = {},
): Spend {
  const {
    dayTotal = 3.42,
    monthTotal = 71.08,
    dailyUsd = 10,
    alertThresholdPercent = 80,
    alertsEnabled = true,
    dayStatus = 'ok',
    sessionCount = 4,
  } = options;

  return {
    timezone: 'Europe/Amsterdam',
    generatedAt: '2026-08-13T12:00:00.000Z',
    day: {
      periodStart: '2026-08-12T22:00:00.000Z',
      periodEnd: '2026-08-13T22:00:00.000Z',
      totalCostUsd: dayTotal,
      sessionCount,
    },
    month: {
      periodStart: '2026-07-31T22:00:00.000Z',
      periodEnd: '2026-08-31T22:00:00.000Z',
      totalCostUsd: monthTotal,
      sessionCount: 37,
    },
    budget: { dailyUsd, perSessionUsd: null, alertThresholdPercent, alertsEnabled },
    dayStatus,
  };
}

export function makeScheduleEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    kind: 'github_poll',
    label: 'GitHub repository poll',
    enabled: true,
    nextRunAt: '2026-08-13T12:15:00.000Z',
    lastRunAt: '2026-08-13T11:15:00.000Z',
    ...overrides,
  };
}

export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '0198a2f3-9c41-7bd2-a10e-00000000ab01',
    type: 'session_completed',
    severity: 'info',
    title: 'Session "Import inventory CSV mapping" completed',
    body: '',
    payload: null,
    correlationId: null,
    readAt: null,
    createdAt: '2026-08-13T11:58:00.000Z',
    telegram: { status: 'skipped', sentAt: null, error: null },
    ...overrides,
  };
}
