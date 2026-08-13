/**
 * F4.1 — Adr vocabulary (TDS 04 §9, storage TDS 03 §4.1) and the SyncRun run states
 * (TDS 04 §10, storage TDS 03 §4.5).
 *
 * **There is no `draft` status.** TDS 04 §9 says so in as many words: the vocabulary is
 * `proposed → accepted | rejected`, with `superseded` set when a later ADR replaces one
 * (arbitration A4). "Draft" as a *verb* — an AI-drafted ADR awaiting review — is exactly what
 * `proposed` means, which is why it is the insert default.
 *
 * `sync_runs.state` is a **run** state and shares nothing with the F7 session state machine
 * (F9.5 vocabulary discipline): a Session is never `queued` and a run is never `paused`.
 */

export const ADR_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded'] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

export function isAdrStatus(value: unknown): value is AdrStatus {
  return typeof value === 'string' && (ADR_STATUSES as readonly string[]).includes(value);
}

/** The initial status of every ADR, however it was created (TDS 04 §9). */
export const INITIAL_ADR_STATUS = 'proposed' satisfies AdrStatus;

export const SYNC_RUN_STATES = ['queued', 'running', 'completed', 'failed'] as const;
export type SyncRunState = (typeof SYNC_RUN_STATES)[number];

/** Non-terminal states — the subset `ux_sync_runs_active` makes exclusive (TDS 03 §4.5). */
export const ACTIVE_SYNC_RUN_STATES = [
  'queued',
  'running',
] as const satisfies readonly SyncRunState[];

export const SYNC_RUN_TRIGGERS = ['user', 'schedule'] as const;
export type SyncRunTrigger = (typeof SYNC_RUN_TRIGGERS)[number];

export const SYNC_RUN_KINDS = ['obsidian'] as const;
export type SyncRunKind = (typeof SYNC_RUN_KINDS)[number];

/** `sync_runs.stats` (TDS 04 §10) — display-only, whole-read. */
export interface SyncRunStatsShape {
  readonly notesExported: number;
  readonly notesImported: number;
  readonly conflicts: number;
}
