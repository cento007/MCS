import process from 'node:process';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration (F1.4, workflow pinned by TDS 03 §8).
 *
 * Schema lives in `src/db/schema/` (one file per table group, WS3-owned); generated SQL
 * migrations land in `drizzle/` and are COMMITTED and code-reviewed — the SQL in those
 * files is what runs.
 *
 * Scoped to the `public` schema on purpose: pg-boss owns and migrates its own `pgboss`
 * schema, which is treated as a vendored dependency and must never appear in a generated
 * migration (TDS 03 §7.1).
 *
 * `DATABASE_URL` is read straight from the environment rather than through the shared
 * config loader: drizzle-kit is tooling, not an app process, and must not create the
 * `MC_DATA_DIR` subtree as a side effect of running a migration. `scripts/db.mjs` is the
 * entry point that checks connectivity first and fails with a readable message.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  schemaFilter: ['public'],
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
