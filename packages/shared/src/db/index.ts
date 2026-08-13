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

/**
 * Row-shaped types that are part of the *contract* rather than of the table definition, and are
 * therefore importable without reaching through the `schema` namespace.
 *
 * `CommitFile` is one element of `commits.files` (TDS 03 §3.7). Both the GitHub producer that
 * writes it and the Session Files read model that consumes it (§6.10.2) need the same shape;
 * a second, hand-copied declaration on either side is a drift waiting to happen.
 */
export type { CommitFile } from './schema/git.js';
export * as schema from './schema/index.js';
/**
 * `notifications.payload` (TDS 03 §4.2) — entity IDs for deep links plus `eventType`. Both the
 * Backend producer and the Telegram Worker's daily report build one, so it is contract rather
 * than a detail of the table definition.
 */
export type { NotificationPayload } from './schema/notifications.js';
