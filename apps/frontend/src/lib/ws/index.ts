/**
 * `lib/ws` — the single multiplexed WebSocket (F5.6, TDS 05 §5).
 *
 *   protocol.ts      frame vocabulary + decoder; the ONE file a WS2 frame change touches
 *   socket-client.ts the connection state machine, refcounted channels, liveness, dedupe
 *   invalidation.ts  event -> query keys, channel -> query keys (§5.3)
 *   dispatch.ts      the F6 envelope -> client effects mapping
 *   context.tsx      provider + `useChannel` / `useSessionChannel`
 */
export * from './context.js';
export * from './dispatch.js';
export * from './invalidation.js';
export * from './protocol.js';
export * from './socket-client.js';
