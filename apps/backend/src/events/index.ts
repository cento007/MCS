/**
 * `events/` — the in-process typed event bus plus the transactional outbox helper
 * (F3.2, F6.3, TDS 02 §2).
 *
 * Two responsibilities that must not be conflated:
 *
 *  1. **In-process fan-out** (`bus.ts`) — a typed bus the WS hub and other Backend modules
 *     subscribe to. Best-effort, in-memory, no durability claim.
 *
 *  2. **The outbox helper** (`outbox.ts`) — persists the domain change and enqueues the F6
 *     event in the SAME PostgreSQL transaction (F6.3). The mechanism is pinned in
 *     TDS 03 §7.2: pg-boss's job INSERT is routed through the caller's Drizzle transaction,
 *     so it commits or rolls back atomically with the domain write. Because `SKIP LOCKED`
 *     fetchers only see committed rows, a job can never be observed before its domain change
 *     is visible.
 *
 *  3. **The worker relay** (`relay.ts`) — the `LISTEN/NOTIFY` listener that injects
 *     worker-produced F6 envelopes into the same in-process bus (TDS 04 §15.1). It is the
 *     mirror image of (1): the outbox publishes events this process produced, the relay
 *     publishes events another process produced, and every subscriber — the WebSocket hub
 *     included — sees one stream with no notion of provenance.
 *
 * The `QueuePort.enqueue` signature in `@mc/shared` already forces the transaction handle,
 * so an implementation that forgets the outbox does not typecheck.
 */

export * from './bus.js';
export * from './outbox.js';
export * from './relay.js';
