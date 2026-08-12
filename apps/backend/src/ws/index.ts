/**
 * `ws/` — the WebSocket hub: one multiplexed connection at `/api/v1/ws` (F5.6).
 *
 * SCAFFOLD STATE: directory placeholder. Nothing here is implemented.
 * `@fastify/websocket` (F1.1) is intentionally not yet a dependency — it is added by the
 * workstream that implements this module, so the lockfile does not carry an unused
 * transport plugin through the rest of the foundation work.
 *
 * What lands here (owner: WS1, contract: TDS 04 §14):
 *   - cookie-authenticated upgrade with a strict single-origin `Origin` allowlist check
 *     (403 `ORIGIN_NOT_ALLOWED`) — SameSite=Lax does not cover WS upgrades (WS0 sign-off
 *     finding #3, TDS 04 §14.2)
 *   - channel registry: `sessions`, `session:{id}`, `repositories`, `settings`, `audit`,
 *     `notifications` (P2), `sync` (P2), `adrs` (P2); 64 subscriptions per connection
 *   - subscribe/unsubscribe/prompt/ping client frames; hello/ack/event/pong/error server
 *     frames, all domain traffic carrying the F6.2 envelope verbatim
 *   - relay only: `ws/` subscribes to the in-process bus and filters per channel. It holds
 *     no business logic, does no replay (F6.3 — clients refetch on reconnect), and drops
 *     deltas to a slow socket rather than stalling the pump (TDS 02 §4.2 backpressure)
 */
export {};
