import { defineConfig } from 'vitest/config';

/**
 * Root aggregation config (TDS 07 §4): one Vitest project per workspace package.
 * `pnpm test` runs every unit project; `pnpm --filter <pkg> test` runs one.
 *
 * Integration (`*.int.test.ts`) and E2E (Playwright, `e2e/`) are deliberately NOT
 * aggregated here — they require a live PostgreSQL instance (TDS 07 §3) and a browser
 * download respectively, neither of which is a precondition for `pnpm test`.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
