import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The integration tier (TDS 07 §2, §3) — a SEPARATE config from `vitest.config.ts` on purpose.
 *
 * `pnpm test` (the unit tier) must keep passing with no PostgreSQL installed; that property is
 * what makes `pnpm install && pnpm test` a valid first five minutes in this repository. These
 * tests need a live instance and an admin role, so they run on demand:
 *
 *   pnpm test:int                              (repo root — every package with an integration tier)
 *   pnpm --filter @mc/telegram-worker test:int (this package only)
 */
export default defineConfig({
  resolve: {
    alias: {
      '@mc/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'telegram-worker-integration',
    environment: 'node',
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    setupFiles: ['test/integration/setup.ts'],
    pool: 'forks',
    /**
     * One database for the whole run (see `global-setup.ts`), so files must not run beside each
     * other: isolation here is truncation between cases, and two files truncating concurrently
     * would delete each other's fixtures. This tier is small enough that serial costs seconds,
     * and it keeps the connection footprint to a single pool plus pg-boss's.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
