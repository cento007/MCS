import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * F8.2 — the bootstrap variable set. LOCKED: this is the complete list.
 * Anything else is a `settings` row edited through the Settings page (TDS 02 §8.1).
 */
export const BOOTSTRAP_VARIABLES = [
  'DATABASE_URL',
  'MC_HOST',
  'MC_PORT',
  'MC_ENCRYPTION_KEY',
  'MC_DATA_DIR',
  'NODE_ENV',
  'LOG_LEVEL',
] as const;

export type BootstrapVariable = (typeof BOOTSTRAP_VARIABLES)[number];

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnvName = (typeof NODE_ENVS)[number];

/** Required key length for AES-256-GCM (TDS 03 §3.13). */
export const ENCRYPTION_KEY_BYTES = 32;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodesTo32Bytes(value: string): boolean {
  if (!BASE64.test(value)) return false;
  return Buffer.from(value, 'base64').byteLength === ENCRYPTION_KEY_BYTES;
}

/**
 * Zod schema over the raw environment. Every message names the variable it is about, so
 * the fail-fast output (TDS 02 §8.3) is actionable without reading the stack.
 */
export const bootstrapEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required — PostgreSQL connection string' })
    .min(1, 'DATABASE_URL must not be empty')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),

  MC_HOST: z.string().min(1, 'MC_HOST must not be empty').default('127.0.0.1'),

  MC_PORT: z.coerce
    .number({ error: 'MC_PORT must be a number' })
    .int('MC_PORT must be an integer')
    .min(1, 'MC_PORT must be between 1 and 65535')
    .max(65535, 'MC_PORT must be between 1 and 65535')
    .default(8710),

  MC_ENCRYPTION_KEY: z
    .string({ error: 'MC_ENCRYPTION_KEY is required — 32 random bytes, base64-encoded' })
    .min(1, 'MC_ENCRYPTION_KEY must not be empty')
    .refine(
      decodesTo32Bytes,
      `MC_ENCRYPTION_KEY must be base64 that decodes to exactly ${ENCRYPTION_KEY_BYTES} bytes — generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
    ),

  MC_DATA_DIR: z
    .string()
    .min(1, 'MC_DATA_DIR must not be empty when set')
    .refine(isAbsolute, 'MC_DATA_DIR must be an absolute native path')
    .optional(),

  NODE_ENV: z
    .enum(NODE_ENVS, { error: `NODE_ENV must be one of: ${NODE_ENVS.join(', ')}` })
    .default('development'),

  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
    .default('info'),
});

export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>;

/** The frozen, typed config every process reads. `dataDir` is always resolved. */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  /** Base64 as supplied. Decode with `decodeEncryptionKey` at the point of use. */
  readonly encryptionKey: string;
  readonly dataDir: string;
  readonly nodeEnv: NodeEnvName;
  readonly logLevel: LogLevel;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
}
