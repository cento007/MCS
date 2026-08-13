import process from 'node:process';
import { afterAll, beforeAll, inject } from 'vitest';
import { closeTestResources, setTestDatabaseUrl } from './harness.js';

/**
 * Per-file wiring. `globalSetup` created and migrated the single run database; every file
 * points at it and releases its own pool and queue when it finishes.
 *
 * Bootstrap config is injected through the real loader with `skipEnvFile: true` in the
 * harness, so a developer's root `.env` is irrelevant to a test run (TDS 07 §3).
 */
beforeAll(() => {
  const url = inject('mcTelegramTestDatabaseUrl');
  setTestDatabaseUrl(url);
  // Injected purely through process env, never through a file.
  process.env['DATABASE_URL'] = url;
}, 120_000);

afterAll(async () => {
  await closeTestResources();
}, 120_000);
