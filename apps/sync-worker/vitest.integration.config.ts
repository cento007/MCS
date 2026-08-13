import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The Sync Worker's integration tier (TDS 07 §2, §3) — a SEPARATE config from
 * `vitest.config.ts` on purpose: `pnpm test` (the unit tier) must keep passing with no
 * PostgreSQL installed.
 *
 *   pnpm test:int                          (repo root — every package that has one)
 *   pnpm --filter @mc/sync-worker test:int (this package only)
 *
 * The template-database plumbing is imported from the Backend's harness rather than copied:
 * `test/integration/database.ts` there is deliberately dependency-light and self-contained
 * (it runs inside `globalSetup`, before any application module loads), and a second copy of
 * "how the test template is built" is a second thing to keep in step with the migration set.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@mc/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'sync-worker-integration',
    environment: 'node',
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['../backend/test/integration/global-setup.ts'],
    setupFiles: ['test/integration/setup.ts'],
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
