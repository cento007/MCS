/**
 * `settings/` — the settings key registry (TDS 04 §7.6) and the category document types
 * (§7.1–§7.2) it reproduces.
 *
 * Browser-safe: no Node built-ins, so it is re-exported from `@mc/shared/types` and the
 * Frontend can import the same document shapes the Backend validates against.
 */

export * from './coerce.js';
export * from './registry.js';
export * from './types.js';
