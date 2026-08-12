/**
 * `@mc/shared` — the contract layer consumed by the Backend and both workers, and
 * (types only) by the Frontend. Contents follow TDS 02 §2.1.
 *
 * Present in this scaffold:
 *   config   bootstrap env loader/validator (F8.2, TDS 02 §8.3)
 *   crypto   AES-256-GCM sealing for `secret_items` (TDS 03 §3.13)
 *   entities F4.1 vocabulary + the F7 session state machine
 *   events   F6 envelope, event-type registry
 *   queue    F3 `QueuePort` interface + queue names (pg-boss driver pending WS1)
 *   logger   pino factory, JSON to stdout (TDS 02 §9.4)
 *   runtime  graceful shutdown + worker heartbeat (TDS 02 §7.2)
 *   db       Drizzle client/transaction types; schema is WS3's (deliberately empty)
 *
 * Still owed by later workstreams: `schema` (WS3 DDL), full `entities` DTOs and
 * `settings-client` (WS2/WS1).
 */

export * from './config/index.js';
export * from './crypto/index.js';
export * from './db/index.js';
export * from './logger/index.js';
export * from './queue/index.js';
export * from './runtime/index.js';
export * from './types.js';
