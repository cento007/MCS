import { defineConfig } from 'vitest/config';

/**
 * `@mc/shared`'s integration tier — a SEPARATE config from `vitest.config.ts`, for the same
 * reason the Backend's is: `pnpm test` (the unit tier) must keep passing on a clean checkout
 * with **nothing installed**, and these tests talk to locally installed services.
 *
 * Unlike the Backend's tier this one needs no PostgreSQL. What it needs is Ollama and/or
 * Qdrant, and it needs neither *mandatorily*: `live.int.test.ts` probes for each first and
 * skips with a warning rather than failing when one is absent. Nothing in this repository may
 * depend on either being installed.
 *
 *   pnpm test:int                     (repo root — every package that has an integration tier)
 *   pnpm --filter @mc/shared test:int (this package only)
 */
export default defineConfig({
  test: {
    name: 'shared-integration',
    environment: 'node',
    include: ['src/**/*.int.test.ts'],
    // A cold `ollama pull`-ed model has to be read off disk before the first embedding; the
    // adapter bounds each call at 60 s, so the test bound has to sit above that to be able to
    // observe the adapter's own timeout rather than pre-empt it.
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
