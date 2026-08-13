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
    /**
     * **Fork count is bounded by PostgreSQL, not by CPU count.**
     *
     * Each test file holds its own connections: a `pg` pool (up to 6) plus pg-boss's own pool
     * (up to 4). Vitest's default is one fork per core, so on a 16-core machine the tier can
     * ask for ~150 connections against a stock `max_connections = 100` — and what comes back
     * is `53300 sorry, too many clients already`, raised inside whichever query happened to be
     * next. That surfaces as a scatter of unrelated failures across files that have nothing
     * wrong with them, which is the most expensive kind of flake to diagnose.
     *
     * Eight workers caps the tier at roughly 80 connections, inside the default limit with room
     * for the admin client `globalSetup` uses and for a psql session left open by a developer.
     *
     * (Vitest 4 removed `poolOptions`; `maxWorkers` is the top-level replacement.)
     */
    maxWorkers: 8,
    // Argon2id is deliberately expensive (19 MiB, t=2) and every login test pays for it.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
