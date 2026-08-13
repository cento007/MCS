import { type Db, schema } from '@mc/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/**
 * The Telegram Worker's PostgreSQL pool and Drizzle client.
 *
 * Its own, not the Backend's: the two are separate OS processes (F2.2) and `packages/shared`
 * deliberately exports only the *types* of the data layer, because a pool belongs to a process
 * startup path. The pool is small on purpose — this worker runs one job at a time and its
 * queries are single-row reads and single-row writes.
 *
 * **The worker never runs migrations.** The Backend is the sole migration runner (TDS 03 §7.1,
 * TDS 02 §9.2); a worker that migrated on start would race the Backend during an upgrade.
 */

export interface DatabaseHandle {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 4,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });

  // An idle client that dies (server restart, network blip) must not take the process with it:
  // `pg` emits `error` on the pool, and an unhandled 'error' event is fatal in Node.
  pool.on('error', () => {
    /* the pool discards the client itself; the next checkout reconnects */
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
