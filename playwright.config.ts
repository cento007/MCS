import { defineConfig, devices } from '@playwright/test';

/**
 * E2E harness (TDS 07 §9). Chromium is the gate; WebKit/Firefox are scheduled tiers.
 *
 * SCAFFOLD STATE: no `webServer` block yet. The production E2E topology (TDS 07 §9)
 * is the built SPA served by the Backend against a real PostgreSQL database with
 * `MockAgentRuntime` injected; wiring that up belongs to WS1/WS6 implementation, not
 * to this skeleton. Today `pnpm test:e2e` runs a single trivial spec.
 *
 * Browsers are NOT installed by `pnpm install`. Run `pnpm exec playwright install chromium`
 * before the first `pnpm test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8710',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
