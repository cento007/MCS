import { expect, test } from '@playwright/test';

/**
 * SCAFFOLD SMOKE SPEC.
 *
 * Deliberately trivial: it proves the Playwright harness is configured and can execute,
 * nothing more. It runs no browser navigation, so it passes without a downloaded browser
 * binary and without a running Backend.
 *
 * The real Phase 1 flow set (TDS 07 §9) — login/logout, dashboard widgets, create -> start
 * -> stream -> complete a managed Session, observed Session from a scripted hook POST,
 * Settings with masked secrets and Test Connection — needs the production topology under
 * test (built SPA served by the Backend, real PostgreSQL, `MockAgentRuntime` injected) and
 * belongs to WS6 alongside the features it exercises. Flows tagged `@smoke` form the
 * Windows CI subset.
 */
test('playwright harness is configured', () => {
  expect(test.info().project.name).toBe('chromium');
});
