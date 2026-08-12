import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { afterAll, beforeAll, inject } from 'vitest';
import {
  createDatabaseFromTemplate,
  dropDatabase,
  withAdminClient,
  withDatabaseName,
} from './database.js';
import { closeTestResources, setTestDatabaseUrl } from './harness.js';

/**
 * Per-test-file database (TDS 07 §3.1). Vitest runs `setupFiles` once for every test file, so
 * each file gets its own `CREATE DATABASE … TEMPLATE` copy: fully migrated, private, and
 * dropped again when the file finishes. Files can therefore run in parallel without sharing
 * a schema, a sequence, or a `LISTEN/NOTIFY` namespace.
 *
 * The name carries the run id and the Vitest pool id so a crashed run leaves droppings that
 * the next `globalSetup` sweep recognises and removes.
 */

let databaseName: string | null = null;
let adminUrl: string | null = null;

beforeAll(async () => {
  adminUrl = inject('mcTestAdminUrl');
  const template = inject('mcTestTemplateDatabase');
  const runId = inject('mcTestRunId');
  const poolId = process.env['VITEST_POOL_ID'] ?? '0';

  databaseName = `mc_test_${runId}_w${poolId}_${randomBytes(3).toString('hex')}`;

  await withAdminClient(adminUrl, async (client) => {
    await createDatabaseFromTemplate(client, databaseName as string, template);
  });

  const url = withDatabaseName(adminUrl, databaseName);
  setTestDatabaseUrl(url);
  // Injected purely through process env, never through a file (TDS 07 §3).
  process.env['DATABASE_URL'] = url;
}, 120_000);

afterAll(async () => {
  await closeTestResources();

  if (adminUrl !== null && databaseName !== null) {
    const name = databaseName;
    await withAdminClient(adminUrl, async (client) => {
      await dropDatabase(client, name);
    });
  }
}, 120_000);
