/**
 * `relay` — the cross-process event relay contract (F3.2, TDS 02 §7.2, TDS 04 §15.1).
 *
 * Events produced inside the Backend reach the browser through the in-process bus. Events
 * produced in a worker have no such path: workers expose no ports and never call the Backend
 * over HTTP (F2.2), so PostgreSQL is the only channel available. This module is the worker half
 * of that channel; `apps/backend/src/events/relay.ts` is the Backend half.
 *
 *   codec.ts   the `NOTIFY` wire format — encode, validate, decode, and both PostgreSQL limits
 *   notify.ts  `notifyEvent` / `emitWorkerEvent` — the producer, on the caller's transaction
 *
 * It is deliberately NOT re-exported from `@mc/shared/types`: that entry is browser-safe and
 * this one depends on `node:buffer` and on Drizzle.
 */

export * from './codec.js';
export * from './notify.js';
