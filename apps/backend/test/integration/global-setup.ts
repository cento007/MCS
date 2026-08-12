import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { TestProject } from 'vitest/node';
import {
  databaseExists,
  dropDatabase,
  migrationSetHash,
  migrationsFolder,
  quoteIdentifier,
  TEMPLATE_DATABASE,
  TEST_DATABASE_PREFIX,
  testDatabaseAdminUrl,
  withAdminClient,
  withDatabaseName,
} from './database.js';

/**
 * Integration-tier `globalSetup` (TDS 07 §3.1), run once per `pnpm test:int`:
 *
 *   1. sweep orphaned `mc_test_*` databases left by a crashed run
 *   2. build `mc_test_template` — created once, migrated once with the WS3 DDL
 *   3. hand the workers the admin URL, the template name and this run's id
 *
 * Workers then take file-level `CREATE DATABASE … TEMPLATE` copies (see `setup.ts`), which is
 * a file-level copy inside PostgreSQL — tens of milliseconds for a fully migrated database,
 * with no containers and no second engine. Identical on Windows 11 and Ubuntu because it is
 * pure SQL against a native instance.
 *
 * The template is reused between runs and rebuilt only when the migration set's content hash
 * changes, so the common case pays for migrations zero times.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    mcTestAdminUrl: string;
    mcTestTemplateDatabase: string;
    mcTestRunId: string;
  }
}

const HASH_TABLE = '_mc_template_meta';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = testDatabaseAdminUrl();
  const runId = randomBytes(4).toString('hex');
  const wantedHash = migrationSetHash();

  await withAdminClient(adminUrl, async (client) => {
    await sweepOrphans(client);

    if (await databaseExists(client, TEMPLATE_DATABASE)) {
      if (await templateMatches(adminUrl, wantedHash)) return;
      await dropDatabase(client, TEMPLATE_DATABASE);
    }

    await client.query(`CREATE DATABASE ${quoteIdentifier(TEMPLATE_DATABASE)}`);
    await migrateTemplate(adminUrl, wantedHash);
  });

  project.provide('mcTestAdminUrl', adminUrl);
  project.provide('mcTestTemplateDatabase', TEMPLATE_DATABASE);
  project.provide('mcTestRunId', runId);

  return async () => {
    // Workers drop their own clones; this catches anything a killed worker left behind.
    await withAdminClient(adminUrl, async (client) => {
      await sweepOrphans(client, runId);
    });
  };
}

/**
 * Drop every abandoned `mc_test_*` database except the template. Run IDs in the names plus this
 * sweep are what make a crashed run self-healing (TDS 07 §3.1) — no developer ever has to know
 * that `mc_test_9f3e_w2_a1b2` exists.
 *
 * **Databases with a live connection are left alone.** The startup sweep is deliberately
 * un-scoped (it has to collect the droppings of runs whose ids it never knew), which without
 * this filter makes it hostile to any *concurrent* run: `DROP DATABASE … WITH (FORCE)` would
 * terminate that run's connections mid-test and it would fail with a bewildering
 * "terminating connection due to administrator command". A crashed run leaves no connections
 * behind, so the self-healing property is untouched; a live one is now simply not our business.
 */
async function sweepOrphans(client: pg.Client, onlyRunId?: string): Promise<void> {
  const pattern =
    onlyRunId === undefined
      ? `${TEST_DATABASE_PREFIX}%`
      : `${TEST_DATABASE_PREFIX}${onlyRunId}\\_%`;

  const result = await client.query<{ datname: string }>(
    `SELECT d.datname
     FROM pg_database d
     WHERE d.datname LIKE $1
       AND d.datname <> $2
       AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    [pattern, TEMPLATE_DATABASE],
  );

  for (const row of result.rows) {
    await dropDatabase(client, row.datname);
  }
}

async function templateMatches(adminUrl: string, wantedHash: string): Promise<boolean> {
  const client = new pg.Client({
    connectionString: withDatabaseName(adminUrl, TEMPLATE_DATABASE),
  });
  await client.connect();

  try {
    const result = await client.query<{ hash: string }>(`SELECT hash FROM ${HASH_TABLE} LIMIT 1`);
    return result.rows[0]?.hash === wantedHash;
  } catch {
    // No meta table (or an interrupted build): treat the template as unusable.
    return false;
  } finally {
    // MUST close: `CREATE DATABASE … TEMPLATE` refuses while a session is connected.
    await client.end();
  }
}

async function migrateTemplate(adminUrl: string, hash: string): Promise<void> {
  const connectionString = withDatabaseName(adminUrl, TEMPLATE_DATABASE);
  const pool = new pg.Pool({ connectionString });

  try {
    await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
    await pool.query(`CREATE TABLE IF NOT EXISTS ${HASH_TABLE} (hash text NOT NULL)`);
    await pool.query(`DELETE FROM ${HASH_TABLE}`);
    await pool.query(`INSERT INTO ${HASH_TABLE} (hash) VALUES ($1)`, [hash]);
  } finally {
    await pool.end();
  }

  await installQueueSchema(connectionString);
}

/**
 * Install pg-boss's vendored `pgboss` schema into the template (TDS 07 §3.1).
 *
 * Doing it once here rather than per test file is the whole point: pg-boss's own migration set
 * is by far the most expensive part of provisioning, and a `CREATE DATABASE … TEMPLATE` copy
 * carries it for free. Startup order matches production (TDS 03 §7.1) — app migrations first,
 * then `start()`.
 *
 * Maintenance and cron are off: this instance exists to create a schema and then die.
 */
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
    // MUST close: `CREATE DATABASE … TEMPLATE` refuses while a session is connected.
    await boss.stop({ graceful: false, close: true });
  }
}
