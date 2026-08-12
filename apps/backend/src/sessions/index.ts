/**
 * `sessions/` — the Session domain and the F7 state machine owner (TDS 02 §2, §4–§6).
 *
 * SCAFFOLD STATE: directory placeholder. Nothing here is implemented.
 *
 * The module rule that outranks everything else in this directory:
 *
 *   **`sessions/state-machine.ts` is the ONLY code path that mutates `sessions.state`.**
 *
 * Managed controllers, observed ingest, restart recovery and API handlers all call it. It
 * validates against `SESSION_STATE_TRANSITIONS` from `@mc/shared` (F7), records timestamp
 * plus trigger (`user` | `system`) on the session timeline, and emits
 * `session.state_changed` together with the specific lifecycle event through the
 * transactional outbox helper in `events/` (F6.3). Six writers, one state machine.
 *
 * Planned layout (TDS 02 §2):
 *   state-machine.ts   F7 enforcement + event emission
 *   manager.ts         ManagedSessionRegistry: concurrency slots, `session.launch`
 *                      consumer, FIFO launch queue when saturated (TDS 02 §4.3)
 *   managed/           Agent SDK controller per running Session (TDS 02 §4.1);
 *                      ALL `@anthropic-ai/claude-agent-sdk` calls sit behind one
 *                      `AgentRuntimePort` so no other module imports the SDK (TDS 07 §5.1)
 *   observed/          hook ingest handler + version-tolerant transcript tailer adapter
 *                      (F1.5, TDS 02 §6) — parse failures degrade to hook-only, never crash
 *   export.ts          session export / context package generation into MC_DATA_DIR/exports
 */
export {};
