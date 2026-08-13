/**
 * `memory/` — the Phase 3 memory foundation (PRD §6, TDS 03 §6).
 *
 * Two ports and their implementations, the stamp that makes stored vectors trustworthy, and the
 * provisioning that ties them together. **Ingestion, retrieval and the Memory UI are not here** —
 * they are the follow-ups this layer exists to carry.
 *
 * Layout — the foundation:
 *   http.ts               the one bounded outbound edge, shared by both adapters
 *   stamp.ts              model + dimension, and the refusal that keeps vectors comparable
 *   embedding-port.ts     `EmbeddingPort` (batch-shaped), cosine, normalization
 *   fake-embedder.ts      the deterministic fake the unit tier runs on — no network, no install
 *   ollama.ts             the Ollama adapter, written against a measured Ollama 0.32.9
 *   vector-store-port.ts  `VectorStorePort`, the closed filter shape, the shared predicate
 *   memory-store.ts       the in-memory fake with real cosine ranking
 *   qdrant.ts             the Qdrant adapter, written against a measured Qdrant 1.19.0
 *   provision.ts          identify the model, stamp the collection, verify it — never throws
 *
 * …and ingestion, which is what the foundation was for:
 *   chunk.ts              the byte bound that stops Ollama silently truncating. Start here
 *   projection.ts         what text represents each PRD §6.3 source. Pure, per source type
 *   store.ts              `memory_items` reads and writes, and the derived point id
 *   indexer.ts            one source in, two consistent stores out; the content-hash diff
 *   backfill.ts           the bounded, resumable sweep over everything that predates the index
 *   runs.ts               the run record and its single-active guard (`sync_runs`)
 *
 * It lives in `@mc/shared` rather than in the Backend because F2.2 forbids a worker importing
 * Backend modules and both the Backend and the Sync Worker's ADR/Obsidian work touch the same
 * vocabulary: they must agree byte-for-byte on what a stored point means. **Indexing itself is
 * consumed by the Backend** (arbitration A16 — see `QUEUE_NAMES.MEMORY_INDEX`); nothing here
 * assumes which process runs it.
 */

export * from './backfill.js';
export * from './chunk.js';
export * from './embedding-port.js';
export * from './fake-embedder.js';
export * from './http.js';
export * from './indexer.js';
export * from './memory-store.js';
export * from './ollama.js';
export * from './projection.js';
export * from './provision.js';
export * from './qdrant.js';
export * from './runs.js';
export * from './stamp.js';
export * from './store.js';
export * from './vector-store-port.js';
