import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { DirtyFormProvider } from '../../components/UnsavedChangesGuard.js';
import type { ApiTokenSummary, ServiceHealth } from '../../lib/api/index.js';
import { SettingsPage } from './SettingsPage.js';
import type {
  GeneralSettings,
  IntegrationsSettings,
  NotificationsSettings,
  SecuritySettings,
} from './types.js';

/**
 * Fixtures and render harnesses for the Settings suites.
 *
 * Not a `*.test.ts` file, so Vitest never collects it. **No database and no network** — the
 * fetch mock in `src/test/api-mock.ts` answers everything, so `pnpm test` still runs on a bare
 * checkout (TDS 07 §4).
 *
 * `renderSettingsPage` builds a **data router** (`createMemoryRouter`), not a `MemoryRouter`,
 * and that is load-bearing rather than incidental: `useBlocker` — the mechanism behind the
 * unsaved-changes guard — requires a data router, which is exactly what `app/router.tsx`
 * creates in production. A harness using the non-data router would silently leave the
 * highest-consequence behaviour on this screen untestable.
 */

export function makeGeneral(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    instanceName: 'Mission Control — Home',
    timezone: 'Europe/Amsterdam',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: '24h',
    theme: 'dark',
    defaultLandingPage: 'dashboard',
    ...overrides,
  };
}

export const GITHUB_TOKEN_SAVED_AT = '2026-08-10T09:14:00.000Z';

export function makeIntegrations(
  overrides: Partial<IntegrationsSettings> = {},
): IntegrationsSettings {
  return {
    github: {
      token: { isSet: true, updatedAt: GITHUB_TOKEN_SAVED_AT },
      account: 'cento007',
      organizations: [],
      discoveryRoots: ['D:\\Repos'],
      syncIntervalMinutes: 5,
      workflowMode: 'manual',
    },
    claudeCode: {
      cliPath: 'C:\\Users\\mvbru\\claude.exe',
      defaultModel: 'claude-sonnet-4-5',
      maxConcurrentSessions: 3,
      costBudget: { dailyUsd: 10, perSessionUsd: null, alertThresholdPercent: 80 },
    },
    telegram: { botToken: { isSet: false, updatedAt: null }, chatId: null, enabled: false },
    obsidian: {
      vaultPath: null,
      syncMode: 'paused',
      syncIntervalMinutes: 0,
      conflictPolicy: 'newer_wins',
    },
    qdrant: {
      host: '127.0.0.1',
      port: 6333,
      apiKey: { isSet: false, updatedAt: null },
      embeddingModel: 'nomic-embed-text',
    },
    ollama: { host: '127.0.0.1', port: 11434 },
    ...overrides,
  };
}

export function makeNotifications(
  overrides: Partial<NotificationsSettings> = {},
): NotificationsSettings {
  return {
    events: {
      sessionComplete: true,
      sessionFailed: true,
      syncFailed: true,
      repositoryProblem: true,
      costBudgetAlert: true,
    },
    dailyReport: { enabled: false, time: '18:00' },
    quietHours: { enabled: false, start: '23:00', end: '07:30' },
    ...overrides,
  };
}

/**
 * `GET /settings/memory` (PRD §4.4 item 4) — the Backend's own shape, as a plain record.
 *
 * `retentionDays` with **`0` meaning never expire**, which is what `MEMORY_KEYS` in the shared
 * settings registry defines and what its JSON Schema (`integer, minimum: 0`) will accept; the
 * three producible tiers only, because `agent` has no producer. Sources are one boolean per
 * `MEMORY_SOURCE_TYPES` entry, keyed by `memorySourceField`.
 *
 * Not typed as an interface on purpose: the panel reads this document defensively because the
 * `memory` keys landed after the screen was specified, and a fixture typed to the contract would
 * let a test assert a shape the panel is required *not* to assume. The suites pass `{}` (the
 * Backend that shipped before those keys), half a document, and this — all through one helper.
 */
export function makeMemorySettings(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    indexedSources: {
      session: true,
      commit: true,
      adr: true,
      obsidianNote: true,
      pullRequest: true,
      document: true,
    },
    retentionDays: { session: 90, project: 0, global: 0 },
    ...overrides,
  };
}

export function makeSecurity(overrides: Partial<SecuritySettings> = {}): SecuritySettings {
  return {
    sessionTimeoutMinutes: 10_080,
    auditLogRetentionDays: 180,
    allowedOrigins: [],
    ...overrides,
  };
}

export function makeToken(overrides: Partial<ApiTokenSummary> = {}): ApiTokenSummary {
  return {
    id: '0198a2f3-9c41-7bd2-a10e-00000000000a',
    name: 'cli-laptop',
    prefix: 'mct_a1b2',
    scopes: ['full'],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * All five `ServiceStatus` values in one payload, plus the queue's mandated label.
 *
 * `disabled` appears three times because that is what a correct Phase 1 install reports:
 * Qdrant and Ollama are Phase 3, and the two workers are Phase 2. A Services panel that
 * rendered those as failures would show four permanent alarms on a healthy machine.
 */
export function makeHealth(): ServiceHealth {
  const checkedAt = '2026-08-13T11:00:00.000Z';
  return {
    services: [
      {
        name: 'backend',
        label: 'Backend',
        status: 'healthy',
        detail: null,
        checkedAt,
        meta: {
          version: '0.1.0',
          uptimeSeconds: 273_600,
          activeSessions: 1,
          maxConcurrentSessions: 3,
        },
      },
      {
        name: 'postgresql',
        label: 'PostgreSQL',
        status: 'healthy',
        detail: '4 ms',
        checkedAt,
        meta: { latencyMs: 4, serverVersion: '16.3' },
      },
      {
        name: 'queue',
        label: 'Queue (PostgreSQL)',
        status: 'degraded',
        detail: 'depth 2 · 1 failed job retained',
        checkedAt,
        meta: { depth: 2, failed: 1 },
      },
      {
        name: 'telegram-worker',
        label: 'Telegram Worker',
        status: 'disabled',
        detail:
          'Has never reported. Start it with `pnpm dev:workers`; it also needs a bot token in Settings → Integrations.',
        checkedAt,
        meta: { lastHeartbeatAt: null, heartbeatStatus: 'never_reported' },
      },
      {
        name: 'sync-worker',
        label: 'Sync Worker',
        status: 'down',
        detail: 'Last heartbeat 12 m ago',
        checkedAt,
        meta: { heartbeatStatus: 'down' },
      },
      {
        name: 'qdrant',
        label: 'Qdrant',
        status: 'disabled',
        // `disabled` here means "no embedding model is set", which is what actually decides
        // whether memory is configured — not a phase gate. Qdrant is live as of Phase 3.
        detail: 'No embedding model is set, so nothing is indexed',
        checkedAt,
        meta: null,
      },
      {
        name: 'ollama',
        label: 'Ollama',
        status: 'unknown',
        detail: 'Probe did not answer',
        checkedAt,
        meta: null,
      },
    ],
  };
}

// --------------------------------------------------------------------------------- render

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

export interface PanelHarness extends RenderResult {
  readonly queryClient: QueryClient;
}

/** One panel in isolation: providers only, plain router (no `useBlocker` in a card). */
export function renderPanel(ui: ReactElement): PanelHarness {
  const queryClient = makeQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DirtyFormProvider>{ui}</DirtyFormProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

export interface PageHarness extends RenderResult {
  readonly queryClient: QueryClient;
  /** The live data router, so a test can drive a real navigation past the guard. */
  readonly router: ReturnType<typeof createMemoryRouter>;
}

/** The whole screen on a data router, so the navigation guard is exercised for real. */
export function renderSettingsPage(initialPath = '/settings/general'): PageHarness {
  const queryClient = makeQueryClient();
  const router = createMemoryRouter(
    [
      { path: '/settings/:category', element: <SettingsPage /> },
      // A destination outside Settings, so "route change while dirty" is a real navigation
      // rather than a same-screen category swap.
      { path: '/sessions', element: <div>Sessions screen</div> },
    ],
    { initialEntries: [initialPath] },
  );

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { ...result, queryClient, router };
}
