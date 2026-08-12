/**
 * `lib/api` — the whole REST surface of the SPA (TDS 05 §4).
 *
 *   errors.ts      the F5.4 envelope as a typed `ApiError`, plus code -> copy mapping
 *   client.ts      the fetch wrapper: envelopes, credentials, the single 401 interceptor
 *   endpoints.ts   every path in one place, so a WS2 rename touches one file
 *   query-keys.ts  typed keys mirroring REST paths (TDS 05 §3)
 *   pagination.ts  opaque-cursor helpers for `useInfiniteQuery`
 *   types.ts       Phase 1 resource shapes (to be replaced by generated OpenAPI types)
 */
export * from './client.js';
export * from './endpoints.js';
export * from './errors.js';
export * from './pagination.js';
export * from './query-keys.js';
export * from './types.js';
