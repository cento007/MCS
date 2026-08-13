import { type Db, schema } from '@mc/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/**
 * The Backend's PostgreSQL pool and Drizzle client (TDS 02 §2 — the pool belongs to the
 * process startup path, which is why `packages/shared` deliberately exports only the
 * *types*).
 *
 * `createDatabase` takes a connection string rather than an `AppConfig` so the integration
 * harness can point it at a per-worker template clone (TDS 07 §3.1) without faking config.
 */

export interface DatabaseHandle {
  readonly db: Db;
  readonly pool: pg.Pool;
  /** Drains the pool. Registered as a shutdown step by `main.ts`. */
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly connectionString: string;
  /** Single-user system; the default is deliberately small (TDS 03 §9 volume reality check). */
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
}

/** PostgreSQL `unique_violation` (SQLSTATE 23505). */
const UNIQUE_VIOLATION = '23505';

/**
 * Is this error PostgreSQL rejecting a duplicate against a unique index?
 *
 * Needed because a pre-check plus an insert is not atomic: two concurrent registrations of the
 * same `repositories.local_path` both pass the check and one of them has to become a `CONFLICT`
 * rather than an `INTERNAL`. `constraint` narrows it to the index the caller expects, so an
 * unrelated collision is not silently reported as the one the handler was guarding.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  // Drizzle 0.45 wraps every query failure in a `DrizzleQueryError` and puts the `pg` error on
  // `cause`, so the SQLSTATE is one level down — and, inside a transaction, sometimes two. A
  // check that only looked at the top-level object silently answered `false` for every
  // violation, turning a `409 CONFLICT` into a `500 INTERNAL`. Walking the chain (bounded, so a
  // cyclic `cause` cannot spin) is what makes the guard real rather than aspirational.
  for (let candidate = error, depth = 0; depth < 5; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return false;

    const pgError = candidate as {
      readonly code?: unknown;
      readonly constraint?: unknown;
      readonly cause?: unknown;
    };

    if (pgError.code === UNIQUE_VIOLATION) {
      return constraint === undefined || pgError.constraint === constraint;
    }
    if (pgError.cause === undefined) return false;
    candidate = pgError.cause;
  }

  return false;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });

  // An idle client that dies (server restart, network blip) must not take the process with
  // it: `pg` emits `error` on the pool, and an unhandled 'error' event is fatal in Node.
  pool.on('error', () => {
    /* the pool discards the client itself; the next checkout reconnects */
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
