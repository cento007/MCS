/**
 * `adrs/` — the cross-process half of the Adr contract (TDS 04 §9, storage TDS 03 §4.1).
 *
 * Only the write both producers share lives here; see `store.ts` for why numbering in
 * particular cannot be implemented twice.
 */

export * from './store.js';
