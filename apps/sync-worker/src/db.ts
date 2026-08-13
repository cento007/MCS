import { type Db, schema } from '@mc/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/**
 * The Sync Worker's PostgreSQL pool and Drizzle client.
 *
 * Its own, not the Backend's: the two are separate OS processes (F2.2) and `packages/shared`
 * deliberately exports only the *types* of the data layer, because a pool belongs to a process
 * startup path.
 *
 * Slightly larger than the Telegram Worker's, and for a concrete reason: a sync run opens one
 * transaction per file (`@mc/shared/obsidian/engine.ts`) while the heartbeat writes on its own
 * 30-second tick, so two concurrent checkouts is the steady state and a pool of two would make
 * a heartbeat wait behind a file write.
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
