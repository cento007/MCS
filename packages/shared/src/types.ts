/**
 * Browser-safe entry point: `@mc/shared/types`.
 *
 * Contains ONLY the cross-process vocabulary — F4.1 entity names, the F7 state machine,
 * the F6 event envelope and type registry — with no dependency on any Node built-in.
 * The frontend consumes this entry (types only, per TDS 05 §2.1); the three Node apps
 * consume the full `@mc/shared` entry, which re-exports everything here.
 */

export * from './entities/index.js';
export * from './events/index.js';
