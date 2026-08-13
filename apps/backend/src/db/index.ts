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

/**
 * Constraint-violation predicates (`isUniqueViolation`, `isCheckViolation`) and the errors they
 * translate into live in `violations.ts` and are re-exported here, so every existing
 * `from '../db/index.js'` import keeps working. They are their own module because all of them
 * depend on one non-obvious fact about where Drizzle puts the `pg` error, and that fact is worth
 * learning exactly once.
 */
export * from './violations.js';

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
