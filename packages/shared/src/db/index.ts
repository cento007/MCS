import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

/**
 * Data-layer types (F1.4). The connection pool and the Drizzle client factory belong to
 * each process's own startup path (TDS 02 §2) and are not scaffolded here — what IS fixed
 * is the transaction handle type, because `QueuePort.enqueue` requires it (TDS 03 §7.2).
 */
export type Db = NodePgDatabase<typeof schema>;

/**
 * A Drizzle transaction client. `QueuePort.enqueue` takes one so that the domain write
 * and the job insert commit atomically — the transactional outbox by construction (F6.3,
 * mechanism pinned in TDS 03 §7.2).
 */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export * as schema from './schema/index.js';
