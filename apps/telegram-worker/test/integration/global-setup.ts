import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { TestProject } from 'vitest/node';
import {
  dropDatabase,
  migrationsFolder,
  quoteIdentifier,
  sweepOrphans,
  TEST_DATABASE_PREFIX,
  testDatabaseAdminUrl,
  withAdminClient,
  withDatabaseName,
} from './database.js';

/**
 * Integration-tier `globalSetup` for the Telegram Worker, run once per `pnpm test:int`:
 *
 *   1. sweep databases left by a crashed run
 *   2. create ONE database for this run, migrate it with the WS3 DDL, install pg-boss's
 *      vendored schema (startup order matches production — TDS 03 §7.1)
 *   3. hand the workers its URL
 *   4. drop it again when the run finishes
 *
 * One database rather than a per-file clone, because this package's tier runs serially (see
 * `vitest.integration.config.ts`). Isolation between cases is truncation, not a fresh database.
 *
 * **The Backend runs the migrations in production** (TDS 03 §7.1); this is a test harness
 * standing in for it, which is why the worker's own code has no migration path.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    mcTelegramTestDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = testDatabaseAdminUrl();
  const name = `${TEST_DATABASE_PREFIX}${randomBytes(4).toString('hex')}`;

  await withAdminClient(adminUrl, async (client) => {
    await sweepOrphans(client);
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  });

  const connectionString = withDatabaseName(adminUrl, name);
  await migrateDatabase(connectionString);
  await installQueueSchema(connectionString);

  project.provide('mcTelegramTestDatabaseUrl', connectionString);

  return async () => {
    await withAdminClient(adminUrl, async (client) => {
      await dropDatabase(client, name);
    });
  };
}

async function migrateDatabase(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
  } finally {
    await pool.end();
  }
}

/** pg-boss owns and migrates its own `pgboss` schema (TDS 03 §7.1); it is vendored. */
async function installQueueSchema(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    useListenNotify: false,
    max: 2,
  });

  boss.on('error', () => {
    /* a failure here surfaces from start(); the listener only stops Node making it fatal */
  });

  try {
    await boss.start();
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}
