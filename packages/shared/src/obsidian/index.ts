/**
 * `obsidian/` — the two-way vault sync engine (PRD §7.1, TDS 03 §4.3/§4.5, TDS 04 §10).
 *
 * ## Why this lives in `@mc/shared` and not in `apps/sync-worker`
 *
 * Same reason as `notifications/` next door: **two processes need it**.
 *
 *  - The **Sync Worker** runs syncs. It is the only process that writes to the vault.
 *  - The **Backend** serves the dry run (`GET /api/v1/sync-runs/preview`), which has to answer
 *    "what would a sync do to my vault" *synchronously, in a request*, and must therefore be
 *    able to plan without the worker. A worker may not be called over HTTP (F2.2) and a
 *    preview cannot be a queued job with an answer minutes later.
 *
 * Sharing the engine is what makes the preview trustworthy: it is not a second implementation
 * that approximates the sync, it is `planSync` with `dryRun: true`. The Backend half reads the
 * vault and never writes to it; the write path exists only in the worker.
 *
 * ## The layout
 *
 * | Module | Responsibility |
 * |---|---|
 * | `layout.ts` | PRD §7.1 folders, file naming, the never-rename rule |
 * | `front-matter.ts` | YAML front matter that round-trips an operator's own properties |
 * | `note.ts` | note parse/render, the `mcId` identity, the two hashes |
 * | `render.ts` | the deterministic projections (ADR §7.3 template, Session Note) |
 * | `fs.ts` | atomic write, conflict copy, vault inspection, path confinement |
 * | `scan.ts` | the bounded vault read |
 * | `plan.ts` | the pure conflict matrix and the policy |
 * | `apply.ts` | one intention → the filesystem |
 * | `desired.ts` | database rows → desired notes; the ADR import parser |
 * | `ledger.ts` | `obsidian_sync_states` |
 * | `runs.ts` | `sync_runs` lifecycle and the single-active-run guarantee |
 * | `settings.ts` | `integrations.obsidian.*` |
 * | `engine.ts` | the orchestrator |
 */

export * from './apply.js';
export * from './audit.js';
export * from './desired.js';
export * from './engine.js';
export * from './front-matter.js';
export * from './fs.js';
export * from './layout.js';
export * from './ledger.js';
export * from './note.js';
export * from './plan.js';
export * from './render.js';
export * from './runs.js';
export * from './scan.js';
export * from './settings.js';
