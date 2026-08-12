import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { ZodError } from 'zod';
import { parseEnvFile } from './dotenv.js';
import { DATA_DIR_SUBTREE, defaultDataDir, findEnvFile } from './paths.js';
import { type AppConfig, bootstrapEnvSchema } from './schema.js';

/**
 * Raised when bootstrap config is missing or invalid. `loadConfigOrExit` turns this into a
 * one-line message plus a nonzero exit — fail-fast before touching the DB, identical under
 * a dev console and under systemd (TDS 02 §8.3, F8.1).
 */
export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID' as const;
  /** Bootstrap variable names that failed, in declaration order. */
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

export interface LoadConfigOptions {
  /** Real process env. Always wins over `.env` file values (12-factor, TDS 02 §8.2). */
  readonly env?: NodeJS.ProcessEnv;
  /** Where to start the workspace-root walk-up. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Skip `.env` discovery entirely (tests, and systemd-provided environments). */
  readonly skipEnvFile?: boolean;
  /** Create the `MC_DATA_DIR` subtree if missing (TDS 02 §8.3). Default: true. */
  readonly ensureDataDir?: boolean;
}

function formatZodError(error: ZodError): { message: string; variables: string[] } {
  const variables: string[] = [];
  const lines: string[] = [];

  for (const issue of error.issues) {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
    if (!variables.includes(variable)) variables.push(variable);
    lines.push(`  - ${variable}: ${issue.message}`);
  }

  const message = [
    `Invalid bootstrap configuration (${variables.length} variable(s) rejected):`,
    ...lines,
    '',
    'Bootstrap config comes from the single root .env file (or the real process',
    'environment, which wins). Copy .env.example to .env and fill it in.',
  ].join('\n');

  return { message, variables };
}

/**
 * Read + validate bootstrap config. Pure with respect to the environment it is handed:
 * pass `env` and `skipEnvFile: true` to test without touching the developer's `.env`
 * (TDS 07 §3 — tests never write or modify `.env` files).
 *
 * @throws {ConfigError} with a readable message naming every offending variable.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const realEnv = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  let fileEnv: Record<string, string> = {};
  if (options.skipEnvFile !== true) {
    const envFile = findEnvFile(realEnv, cwd);
    if (envFile !== null) {
      try {
        fileEnv = parseEnvFile(readFileSync(envFile, 'utf8'));
      } catch (error) {
        throw new ConfigError(
          `Could not read env file at ${envFile}: ${(error as Error).message}`,
          [],
        );
      }
    }
  }

  // Real env wins over file values.
  const merged: Record<string, string | undefined> = { ...fileEnv };
  for (const key of Object.keys(fileEnv)) {
    const fromProcess = realEnv[key];
    if (fromProcess !== undefined && fromProcess !== '') merged[key] = fromProcess;
  }
  for (const [key, value] of Object.entries(realEnv)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }

  const parsed = bootstrapEnvSchema.safeParse(merged);
  if (!parsed.success) {
    const { message, variables } = formatZodError(parsed.error);
    throw new ConfigError(message, variables);
  }

  const env = parsed.data;
  const dataDir = env.MC_DATA_DIR ?? defaultDataDir(process.platform, realEnv);

  if (options.ensureDataDir !== false) {
    mkdirSync(dataDir, { recursive: true });
    for (const sub of DATA_DIR_SUBTREE) mkdirSync(join(dataDir, sub), { recursive: true });
  }

  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    host: env.MC_HOST,
    port: env.MC_PORT,
    encryptionKey: env.MC_ENCRYPTION_KEY,
    dataDir,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
  });
}

/**
 * Process-entry convenience: load, or print the named failure to stderr and exit nonzero.
 * Every app's `main.ts` calls this before anything else (TDS 02 §8.3).
 */
export function loadConfigOrExit(options: LoadConfigOptions = {}): AppConfig {
  try {
    return loadConfig(options);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n[mission-control] ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }
}
