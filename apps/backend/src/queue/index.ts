/**
 * `queue/` — the QueuePort producers and consumers owned by the Backend (TDS 02 §2).
 *
 * SCAFFOLD STATE: directory placeholder. Nothing here is implemented.
 *
 * What lands here (owner: WS1):
 *   - construction of the pg-boss driver behind `QueuePort` / `QueueConsumerPort` from
 *     `@mc/shared` (F3.1). Startup order is fixed: drizzle-kit migrations first, then
 *     `boss.start()` (pg-boss migrates its own vendored `pgboss` schema), then the service
 *     accepts work (TDS 03 §7.1). The Backend is the SOLE app-migration runner
 *   - the `session.launch` consumer that dequeues queued launches as concurrency slots
 *     free, in FIFO order (TDS 02 §4.3)
 *   - notification and sync job producers for the Phase 2 workers
 *   - per-queue retry policy and dead-letter configuration; dead-letter depth is surfaced
 *     in the Services health view (TDS 03 §7.3 failure mode 6)
 */
export {};
