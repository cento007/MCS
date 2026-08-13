import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { afterAll, beforeAll, inject } from 'vitest';
import {
  createDatabaseFromTemplate,
  dropDatabase,
  withAdminClient,
  withDatabaseName,
} from '../../../backend/test/integration/database.js';
import { closeTestResources, setTestDatabaseUrl } from './harness.js';

/**
 * Per-test-file database (TDS 07 §3.1), identical in shape to the Backend's: Vitest runs
 * `setupFiles` once per test file, so each file gets its own `CREATE DATABASE … TEMPLATE`
 * copy — fully migrated, private, and dropped when the file finishes.
 *
 * The template itself is built by the Backend's `globalSetup`, which this package's config
 * points at directly. One template, one migration set, no second copy to keep in step.
 */

/**
 * The values the Backend's `globalSetup` provides. Re-declared here because the module
 * augmentation lives in that file, which is outside this package's `tsconfig` project.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    mcTestAdminUrl: string;
    mcTestTemplateDatabase: string;
    mcTestRunId: string;
  }
}

let databaseName: string | null = null;
let adminUrl: string | null = null;

beforeAll(async () => {
  adminUrl = inject('mcTestAdminUrl');
  const template = inject('mcTestTemplateDatabase');
  const runId = inject('mcTestRunId');
  const poolId = process.env['VITEST_POOL_ID'] ?? '0';

  databaseName = `mc_test_${runId}_sw${poolId}_${randomBytes(3).toString('hex')}`;

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
