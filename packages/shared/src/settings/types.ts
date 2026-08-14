import type { AgentPermissionTemplate } from '../entities/agent.js';
import type { IsoTimestamp } from '../entities/index.js';

/**
 * The Settings category documents — TDS 04 §7.1–§7.2, verbatim.
 *
 * These are the shapes `GET`/`PUT /api/v1/settings/*` speak, and they are the types the
 * registry beside this file is required to reproduce exactly: `registry.test.ts` asserts that
 * every field of every interface here has a registry entry and vice versa, so a field added to
 * one and forgotten in the other does not compile-and-ship.
 *
 * **Bootstrap settings are absent by construction** (F8.2, PRD §4.4): `DATABASE_URL`,
 * `MC_HOST`/`MC_PORT`, `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`, `NODE_ENV`/`LOG_LEVEL` are required
 * before the database is reachable, so they cannot live in it and no route may serve them.
 */

// ------------------------------------------------------------------------------ secret fields

/**
 * §7.1 read shape for a write-only secret.
 *
 * **`updatedAt` is an addition to §7.1's `{ isSet: boolean }`, arbitrated as A15.** WS5 §4.4
 * renders the masked row as `•••••••••••• (saved ‹timestamp›)` and calls the changed timestamp
 * "the only honest confirmation possible for a write-only value" — a value the client is
 * forbidden to read back cannot be confirmed any other way, so without it the operator cannot
 * tell whether the credential they pasted actually landed. `null` when the secret is not set.
 */
export interface SecretFieldRead {
  readonly isSet: boolean;
  readonly updatedAt: IsoTimestamp | null;
}

/**
 * §7.1 write shape, inside a `PUT` body:
 *   `string`  → set/replace the secret
 *   `null`    → clear the secret
 *   omitted   → keep the current value unchanged (the exception to full-category replace, A14)
 */
export type SecretFieldWrite = string | null | undefined;

// ------------------------------------------------------------------------------------ general

export const TIME_FORMATS = ['24h', '12h'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export const SETTINGS_THEMES = ['dark', 'light'] as const;
export type SettingsTheme = (typeof SETTINGS_THEMES)[number];

export const LANDING_PAGES = ['dashboard', 'projects', 'sessions'] as const;
export type LandingPage = (typeof LANDING_PAGES)[number];

/** WS5 §5.7.1 offers a closed list; ISO-first because every timestamp on the wire is ISO. */
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY', 'D MMM YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface GeneralSettings {
  readonly instanceName: string;
  /** IANA name. The calendar boundary for spend (§7.8) and the daily report (§7.7). */
  readonly timezone: string;
  readonly dateFormat: DateFormat;
  readonly timeFormat: TimeFormat;
  readonly theme: SettingsTheme;
  readonly defaultLandingPage: LandingPage;
}

// ------------------------------------------------------------------------------- integrations

export const WORKFLOW_MODES = ['manual', 'assisted'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export interface GithubSettings {
  readonly token: SecretFieldRead;
  readonly account: string | null;
  readonly organizations: readonly string[];
  /** Absolute native paths (F8.1), in scan order. */
  readonly discoveryRoots: readonly string[];
  /** `0` = manual only — §7.7 reads `> 0` as "scheduled". */
  readonly syncIntervalMinutes: number;
  /** PRD §4.3. The global default; a Project may override it (arbitration A10). */
  readonly workflowMode: WorkflowMode;
}

/**
 * `dailyUsd: null` means **no budget**, which §7.2 keeps distinct from "alerts off" — the
 * latter lives in `notifications.events.costBudgetAlert` and the two are never conflated.
 */
export interface CostBudget {
  readonly dailyUsd: number | null;
  readonly perSessionUsd: number | null;
  /** 1–100, default 80 (§7.8). */
  readonly alertThresholdPercent: number;
}

export interface ClaudeCodeSettings {
  /** Absolute native path to `claude`/`claude.exe`; `''` = use the binary the SDK ships with. */
  readonly cliPath: string;
  /** `''` = whatever the runtime's own default is. */
  readonly defaultModel: string;
  readonly maxConcurrentSessions: number;
  readonly costBudget: CostBudget;
}

export interface TelegramSettings {
  readonly botToken: SecretFieldRead;
  readonly chatId: string | null;
  readonly enabled: boolean;
}

export const OBSIDIAN_SYNC_MODES = ['two_way', 'one_way', 'paused'] as const;
export type ObsidianSyncMode = (typeof OBSIDIAN_SYNC_MODES)[number];

export const OBSIDIAN_CONFLICT_POLICIES = [
  'newer_wins',
  'obsidian_wins',
  'mission_control_wins',
  'manual',
] as const;
export type ObsidianConflictPolicy = (typeof OBSIDIAN_CONFLICT_POLICIES)[number];

export interface ObsidianSettings {
  /** Absolute native path to the vault directory (F8.1), or `null` when none is configured. */
  readonly vaultPath: string | null;
  readonly syncMode: ObsidianSyncMode;
  readonly syncIntervalMinutes: number;
  readonly conflictPolicy: ObsidianConflictPolicy;
}

/** Phase 3 — the form exists so configuration can be staged; nothing consumes it yet. */
export interface QdrantSettings {
  readonly host: string;
  readonly port: number;
  readonly apiKey: SecretFieldRead;
  readonly embeddingModel: string;
}

/**
 * Phase 3 — where the embedder lives, and nothing else.
 *
 * `enabled` and `defaultModel` were withdrawn: both described Ollama as an *agent runtime*, which
 * no part of this build can select, so neither was ever read. `OLLAMA_KEYS` carries the full
 * reasoning. Host and port are read on every embedding call.
 */
export interface OllamaSettings {
  readonly host: string;
  readonly port: number;
}

export interface IntegrationsSettings {
  readonly github: GithubSettings;
  readonly claudeCode: ClaudeCodeSettings;
  readonly telegram: TelegramSettings;
  readonly obsidian: ObsidianSettings;
  readonly qdrant: QdrantSettings;
  readonly ollama: OllamaSettings;
}

// ------------------------------------------------------------------------------ notifications

export interface NotificationEventToggles {
  readonly sessionComplete: boolean;
  readonly sessionFailed: boolean;
  readonly syncFailed: boolean;
  readonly repositoryProblem: boolean;
  readonly costBudgetAlert: boolean;
}

export interface DailyReportSettings {
  readonly enabled: boolean;
  /** `"HH:mm"` in `general.timezone` — not the browser's zone, not the server's `TZ`. */
  readonly time: string;
}

export interface QuietHoursSettings {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}

export interface NotificationsSettingsDocument {
  readonly events: NotificationEventToggles;
  readonly dailyReport: DailyReportSettings;
  readonly quietHours: QuietHoursSettings;
}

// ------------------------------------------------------------------------------------- memory

/**
 * PRD §4.4 item 4, first half — "indexed sources (sessions, commits, ADRs, notes, PRs, docs)".
 *
 * One boolean per `MEMORY_SOURCE_TYPES` entry, field name = `memorySourceField(type)`, so the
 * six toggles and the six source types cannot drift apart. Every one of them is **read by the
 * indexer and by retrieval** — see `readMemoryPolicy` — because a toggle nothing obeys is worse
 * than no toggle at all.
 *
 * Turning a source off stops it being indexed and stops its existing chunks being returned; the
 * rows are kept, because deletion is irreversible and re-embedding a corpus is not free. The
 * explicit destructive path is `POST /memory-items/backfill { "mode": "rebuild" }`, which drops
 * the collection and re-indexes only the sources that are on.
 */
export interface IndexedSourceToggles {
  readonly session: boolean;
  readonly commit: boolean;
  readonly adr: boolean;
  readonly obsidianNote: boolean;
  readonly pullRequest: boolean;
  readonly document: boolean;
}

/**
 * PRD §4.4 item 4, second half — "retention policy per memory tier", and PRD §6.1's
 * "Session Memory — temporary" made true.
 *
 * Days, per tier, `0` = never expire — the same convention `security.auditLogRetentionDays`
 * already uses for "keep forever", and the default for all three, so an operator opts into
 * losing data rather than discovering it gone.
 *
 * **Three tiers, not four.** `agent` is Phase 4 and nothing writes it
 * (`PRODUCIBLE_MEMORY_TIERS`); a retention control for rows that cannot exist would be a policy
 * that can never apply. It arrives with its producer.
 */
export interface MemoryRetentionDays {
  readonly session: number;
  readonly project: number;
  readonly global: number;
}

export interface MemorySettings {
  readonly indexedSources: IndexedSourceToggles;
  readonly retentionDays: MemoryRetentionDays;
}

// ----------------------------------------------------------------------------------- security

export interface SecuritySettings {
  readonly sessionTimeoutMinutes: number;
  /** `0` = keep forever (WS5 §5.7.11's last option). */
  readonly auditLogRetentionDays: number;
  /** Extra WS/CSRF origins (§14.2), default `[]`. */
  readonly allowedOrigins: readonly string[];
}

// ------------------------------------------------------------------------------------- agents

/**
 * §7.2's `agents` category, with **one** of its two reserved fields.
 *
 * `defaultRuntime` is deliberately absent: there is exactly one launchable runtime, so the
 * setting would be a control with one position. The full argument is on `AGENT_KEYS` in
 * `registry.ts`.
 */
export interface AgentsSettings {
  /**
   * The permission template `POST /api/v1/agents` applies when the request names no permissions
   * (`entities/agent.ts`). Read on every agent create; it decides which tools that agent's
   * sessions lose.
   */
  readonly defaultPermissionTemplate: AgentPermissionTemplate;
}

// ---------------------------------------------------------------------------- the whole thing

/**
 * `GET /api/v1/settings` (§7.3).
 *
 * `agents` served as `{}` until Phase 4's first slice gave one of its two §7.2 fields a real
 * consumer — the same graduation `memory` made in Phase 3. The other field stays out for the
 * reason a placeholder was always wrong: a setting nothing reads is a control that lies.
 */
export interface SettingsDocument {
  readonly general: GeneralSettings;
  readonly integrations: IntegrationsSettings;
  readonly notifications: NotificationsSettingsDocument;
  readonly memory: MemorySettings;
  readonly agents: AgentsSettings;
  readonly security: SecuritySettings;
}

// ---------------------------------------------------------------------- test connection (§7.4)

/**
 * §7.4: a completed check is a **200 regardless of outcome** — failure of the *integration* is
 * data, not an API error. Only a refused *request* (`INTEGRATION_NOT_CONFIGURED`, 409) is an
 * error envelope.
 */
export interface TestConnectionResult {
  readonly ok: boolean;
  readonly checkedAt: IsoTimestamp;
  readonly latencyMs: number | null;
  readonly message: string;
  readonly detail: Record<string, unknown> | null;
}
