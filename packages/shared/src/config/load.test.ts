import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseEnvFile } from './dotenv.js';
import { ConfigError, loadConfig } from './load.js';
import { WORKSPACE_ROOT_MARKER } from './paths.js';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

/** Per-test temp dirs under the OS temp root, never repo-relative (TDS 07 §4 / F8.1). */
const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-config-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const validEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://mc:pw@127.0.0.1:5432/mission_control',
  MC_ENCRYPTION_KEY: KEY_A,
  ...overrides,
});

describe('bootstrap config loader (F8.2 / TDS 02 §8.3)', () => {
  it('accepts a minimal valid environment and applies the documented defaults', () => {
    const dataDir = makeTempDir();
    const config = loadConfig({
      env: validEnv({ MC_DATA_DIR: dataDir }),
      skipEnvFile: true,
      ensureDataDir: false,
    });

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8710);
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.dataDir).toBe(dataDir);
    expect(config.isDevelopment).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('fails fast and names DATABASE_URL when it is missing', () => {
    expect(() =>
      loadConfig({
        env: { MC_ENCRYPTION_KEY: KEY_A },
        skipEnvFile: true,
        ensureDataDir: false,
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({ env: { MC_ENCRYPTION_KEY: KEY_A }, skipEnvFile: true, ensureDataDir: false });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const typed = error as ConfigError;
      expect(typed.variables).toContain('DATABASE_URL');
      expect(typed.message).toContain('DATABASE_URL');
      // The message must be readable, not a stack dump.
      expect(typed.message).toContain('.env.example');
    }
  });

  it('rejects an MC_ENCRYPTION_KEY that does not decode to 32 bytes, and says so', () => {
    try {
      loadConfig({
        env: validEnv({ MC_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64') }),
        skipEnvFile: true,
        ensureDataDir: false,
      });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const typed = error as ConfigError;
      expect(typed.variables).toEqual(['MC_ENCRYPTION_KEY']);
      expect(typed.message).toContain('32 bytes');
    }
  });

  it('rejects a relative MC_DATA_DIR', () => {
    try {
      loadConfig({
        env: validEnv({ MC_DATA_DIR: './data' }),
        skipEnvFile: true,
        ensureDataDir: false,
      });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const typed = error as ConfigError;
      expect(typed.variables).toEqual(['MC_DATA_DIR']);
      expect(typed.message).toContain('absolute');
    }
  });

  it('reports every offending variable at once, not just the first', () => {
    try {
      loadConfig({
        env: { DATABASE_URL: 'mysql://nope', MC_ENCRYPTION_KEY: 'not-base64!!' },
        skipEnvFile: true,
        ensureDataDir: false,
      });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const typed = error as ConfigError;
      expect(typed.variables).toEqual(['DATABASE_URL', 'MC_ENCRYPTION_KEY']);
    }
  });

  it('reads the single root .env discovered by the workspace-root walk-up', () => {
    const root = makeTempDir();
    writeFileSync(join(root, WORKSPACE_ROOT_MARKER), "packages:\n  - 'apps/*'\n");
    writeFileSync(
      join(root, '.env'),
      [
        '# comment line',
        'DATABASE_URL=postgres://from-file@127.0.0.1:5432/mc',
        `MC_ENCRYPTION_KEY=${KEY_A}`,
        'MC_PORT=9999',
        `MC_DATA_DIR=${root}`,
        '',
      ].join('\n'),
    );

    const nested = join(root, 'apps', 'backend');
    const config = loadConfig({ env: {}, cwd: nested, ensureDataDir: false });

    expect(config.databaseUrl).toBe('postgres://from-file@127.0.0.1:5432/mc');
    expect(config.port).toBe(9999);
  });

  it('lets the real process environment win over .env file values', () => {
    const root = makeTempDir();
    writeFileSync(join(root, WORKSPACE_ROOT_MARKER), 'packages: []\n');
    writeFileSync(
      join(root, '.env'),
      [
        'DATABASE_URL=postgres://from-file@127.0.0.1:5432/mc',
        `MC_ENCRYPTION_KEY=${KEY_A}`,
        `MC_DATA_DIR=${root}`,
        '',
      ].join('\n'),
    );

    const config = loadConfig({
      env: {
        DATABASE_URL: 'postgres://from-process@127.0.0.1:5432/mc',
        MC_ENCRYPTION_KEY: KEY_B,
      },
      cwd: root,
      ensureDataDir: false,
    });

    expect(config.databaseUrl).toBe('postgres://from-process@127.0.0.1:5432/mc');
    expect(config.encryptionKey).toBe(KEY_B);
  });

  it('honours MC_ENV_FILE as an explicit override of discovery', () => {
    const dir = makeTempDir();
    const envFile = join(dir, 'custom.env');
    writeFileSync(
      envFile,
      [
        'DATABASE_URL=postgresql://override@127.0.0.1:5432/mc',
        `MC_ENCRYPTION_KEY=${KEY_A}`,
        `MC_DATA_DIR=${dir}`,
        '',
      ].join('\n'),
    );

    const config = loadConfig({ env: { MC_ENV_FILE: envFile }, ensureDataDir: false });
    expect(config.databaseUrl).toBe('postgresql://override@127.0.0.1:5432/mc');
  });

  it('creates the MC_DATA_DIR subtree when asked', () => {
    const dir = join(makeTempDir(), 'nested', 'data');
    const config = loadConfig({
      env: validEnv({ MC_DATA_DIR: dir }),
      skipEnvFile: true,
      ensureDataDir: true,
    });
    expect(config.dataDir).toBe(dir);
    // exports/ hooks/ tmp/ per TDS 02 §1.2
    expect(() => rmSync(join(dir, 'exports'), { recursive: true })).not.toThrow();
    expect(() => rmSync(join(dir, 'hooks'), { recursive: true })).not.toThrow();
    expect(() => rmSync(join(dir, 'tmp'), { recursive: true })).not.toThrow();
  });
});

describe('.env parsing', () => {
  it('handles comments, quotes, export prefixes and blank lines', () => {
    const parsed = parseEnvFile(
      [
        '',
        '# a comment',
        'PLAIN=value',
        'QUOTED="quoted value"',
        "SINGLE='single value'",
        'export EXPORTED=exported',
        'WITH_COMMENT=value # trailing',
        'EMPTY=',
        'not a valid line',
        '',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      PLAIN: 'value',
      QUOTED: 'quoted value',
      SINGLE: 'single value',
      EXPORTED: 'exported',
      WITH_COMMENT: 'value',
      EMPTY: '',
    });
  });
});
