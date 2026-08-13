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
 *   db       Drizzle client/transaction types + the WS3 schema
 *   settings the settings key registry (TDS 04 §7.6) and its category document types
 *   notifications  the cross-process Notification production contract (TDS 04 §8) — policy,
 *                  the atomic row+job write, and the quiet-hours window, shared because the
 *                  Backend and the Telegram Worker both produce Notifications
 *   obsidian the two-way vault sync engine (PRD §7.1) — shared because the Sync Worker runs
 *                  syncs and the Backend serves the dry-run preview from the same planner
 *   relay    the worker -> Backend `LISTEN/NOTIFY` event relay (TDS 04 §15.1): the `NOTIFY`
 *                  wire codec and the producer that publishes on the caller's transaction
 *   memory   the Phase 3 memory foundation (PRD §6): `EmbeddingPort` and `VectorStorePort`,
 *                  their Ollama/Qdrant adapters and their install-free fakes, and the embedding
 *                  stamp that keeps stored vectors comparable. Shared because indexing is Sync
 *                  Worker work and retrieval is Backend work
 *
 * Still owed by later workstreams: full `entities` DTOs.
 */

export * from './adrs/index.js';
export * from './config/index.js';
export * from './crypto/index.js';
export * from './db/index.js';
export * from './logger/index.js';
export * from './memory/index.js';
export * from './notifications/index.js';
export * from './obsidian/index.js';
export * from './queue/index.js';
export * from './relay/index.js';
export * from './runtime/index.js';
export * from './types.js';
