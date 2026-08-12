import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The integration tier (TDS 07 §2, §3) — a SEPARATE config from `vitest.config.ts` on purpose.
 *
 * `pnpm test` (the unit tier) must keep passing with no PostgreSQL installed; that property is
 * what makes `pnpm install && pnpm test` a valid first five minutes in this repository. These
 * tests need a live instance and an admin role, so they run on demand:
 *
 *   pnpm test:int                      (repo root — every package that has an integration tier)
 *   pnpm --filter @mc/backend test:int (this package only)
 *
 * `globalSetup` builds the migrated template database once; `setupFiles` gives every test file
 * its own clone of it.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@mc/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'backend-integration',
    environment: 'node',
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    setupFiles: ['test/integration/setup.ts'],
    // Separate processes: each test file owns a database and a pg pool, and `forks` keeps a
    // crashed native module (argon2) from taking the whole run with it.
    pool: 'forks',
    // Argon2id is deliberately expensive (19 MiB, t=2) and every login test pays for it.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
