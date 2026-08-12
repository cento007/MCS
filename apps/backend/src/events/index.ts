/**
 * `events/` — the in-process typed event bus plus the transactional outbox helper
 * (F3.2, F6.3, TDS 02 §2).
 *
 * SCAFFOLD STATE: directory placeholder. Nothing here is implemented.
 *
 * Two responsibilities that must not be conflated:
 *
 *  1. **In-process fan-out** — a typed EventEmitter the WS hub and other Backend modules
 *     subscribe to. Best-effort, in-memory, no durability claim.
 *
 *  2. **The outbox helper** — persists the domain change and enqueues the F6 event in the
 *     SAME PostgreSQL transaction (F6.3). The mechanism is pinned in TDS 03 §7.2: pg-boss
 *     `send()` is given a `db` adapter whose `executeSql` runs on the caller's Drizzle
 *     transaction client, so the job INSERT commits or rolls back atomically with the
 *     domain write. Because `SKIP LOCKED` fetchers only see committed rows, a job can
 *     never be observed before its domain change is visible.
 *
 * The `QueuePort.enqueue` signature in `@mc/shared` already forces the transaction handle,
 * so an implementation that forgets the outbox does not typecheck.
 */
export {};
