import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { schema } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../../test/integration/database.js';
import {
  createTestApp,
  testDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../../test/integration/harness.js';
import { BootstrapError, bootstrapLocalUser } from './bootstrap.js';
import { verifyPassword } from './passwords.js';

/**
 * First-run bootstrap of the single local account.
 *
 * The property under test is the one the TDS never specified and this implementation has to
 * guarantee (see the GAP note in `bootstrap.ts`): **an existing account is never silently
 * overwritten**, and the only path that replaces a password is explicit about it.
 */

const PASSWORD = 'a sufficiently long passphrase';

let app: FastifyInstance;

beforeEach(async () => {
  await truncateAll();
  ({ app } = createTestApp({ cookieSecure: false }));
});

async function users(): Promise<{ id: string; username: string; passwordHash: string }[]> {
  return testDatabase()
    .db.select({
      id: schema.users.id,
      username: schema.users.username,
      passwordHash: schema.users.passwordHash,
    })
    .from(schema.users);
}

describe('bootstrapLocalUser', () => {
  it('creates the account on an empty database and it can log in', async () => {
    const result = await bootstrapLocalUser(testDatabase().db, {
      username: 'operator',
      password: PASSWORD,
    });

    expect(result.status).toBe('created');
    expect(await users()).toHaveLength(1);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'operator', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });

  it('stores an argon2id hash, never the password', async () => {
    await bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD });

    const [row] = await users();
    expect(row?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row?.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(String(row?.passwordHash), PASSWORD)).toBe(true);
  });

  it('NEVER silently overwrites an existing account', async () => {
    await bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD });
    const [before] = await users();

    const second = await bootstrapLocalUser(testDatabase().db, {
      username: 'operator',
      password: 'a completely different passphrase',
    });

    expect(second.status).toBe('already_exists');
    expect((await users())[0]?.passwordHash).toBe(before?.passwordHash);
    expect(await users()).toHaveLength(1);

    // The original password still works; the second one never took effect.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'operator', password: 'a completely different passphrase' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('replaces the password only with the explicit flag', async () => {
    await bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD });

    const reset = await bootstrapLocalUser(testDatabase().db, {
      username: 'operator',
      password: 'the replacement passphrase',
      allowPasswordReset: true,
    });

    expect(reset.status).toBe('password_reset');
    expect(await users()).toHaveLength(1);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'operator', password: 'the replacement passphrase' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses to reset the password of a different username — that would be a rename', async () => {
    await bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD });

    await expect(
      bootstrapLocalUser(testDatabase().db, {
        username: 'someone-else',
        password: 'the replacement passphrase',
        allowPasswordReset: true,
      }),
    ).rejects.toBeInstanceOf(BootstrapError);

    expect((await users())[0]?.username).toBe('operator');
  });

  it('enforces the password policy before writing anything', async () => {
    await expect(
      bootstrapLocalUser(testDatabase().db, { username: 'operator', password: 'short' }),
    ).rejects.toThrow();

    expect(await users()).toHaveLength(0);
  });

  it('creates exactly one account under concurrent invocations (advisory lock)', async () => {
    const attempts = await Promise.allSettled([
      bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD }),
      bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD }),
      bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD }),
    ]);

    expect(attempts.every((attempt) => attempt.status === 'fulfilled')).toBe(true);
    expect(await users()).toHaveLength(1);

    const statuses = attempts
      .flatMap((attempt) => (attempt.status === 'fulfilled' ? [attempt.value.status] : []))
      .sort();
    expect(statuses).toEqual(['already_exists', 'already_exists', 'created']);
  });

  it('writes a system-actor audit row for the CLI action', async () => {
    await bootstrapLocalUser(testDatabase().db, { username: 'operator', password: PASSWORD });

    const rows = await testDatabase().db.select().from(schema.auditLogEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe('system');
    expect(rows[0]?.action).toBe('user.created');
    expect(rows[0]?.entityType).toBe('users');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});

describe('pnpm auth:create-user (the documented command)', () => {
  const tsx = join(repoRoot(), 'apps', 'backend', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = join(repoRoot(), 'apps', 'backend', 'src', 'cli', 'create-user.ts');

  interface CliResult {
    stdout: string;
    stderr: string;
    code: number;
  }

  /**
   * Spawned with an explicit executable path and no shell (F8.1), with stdin closed unless a
   * password is piped — the same shape a systemd one-shot or a provisioning script produces.
   */
  function createUser(
    args: readonly string[],
    password: { via: 'env' | 'stdin'; value: string },
  ): Promise<CliResult> {
    const child = spawn(process.execPath, [tsx, entry, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        MC_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        ...(password.via === 'env' ? { MC_BOOTSTRAP_PASSWORD: password.value } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (password.via === 'stdin') child.stdin.end(`${password.value}\n`);
    else child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    return new Promise<CliResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  }

  it.runIf(existsSync(tsx))(
    'creates the account from a piped password, then refuses to overwrite it and exits nonzero',
    async () => {
      const first = await createUser(['--username', 'operator'], {
        via: 'stdin',
        value: PASSWORD,
      });
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toContain('Created local account');
      expect(await users()).toHaveLength(1);

      const second = await createUser(['--username', 'operator'], {
        via: 'env',
        value: 'another long passphrase',
      });
      expect(second.code).toBe(1);
      expect(second.stderr).toContain('already exists');

      // Nothing changed: the original password still authenticates.
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    },
    120_000,
  );

  it.runIf(existsSync(tsx))(
    'never accepts the password as a command-line argument',
    async () => {
      const result = await createUser(['--username', 'operator', '--password', PASSWORD], {
        via: 'env',
        value: PASSWORD,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not supported');
      expect(await users()).toHaveLength(0);
    },
    120_000,
  );

  it.runIf(existsSync(tsx))(
    'exits nonzero with an actionable message when no password is available at all',
    async () => {
      const result = await createUser(['--username', 'operator'], { via: 'stdin', value: '' });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No password supplied');
      expect(await users()).toHaveLength(0);
    },
    120_000,
  );
});
