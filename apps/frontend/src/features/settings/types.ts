import type { IsoTimestamp } from '@mc/shared/types';

/**
 * The Settings category documents (TDS 04 §7.2), hand-written against the contract.
 *
 * They live here rather than in `lib/api/types.ts` for one reason: WS2 §7.6 states that the
 * **settings key registry** (`packages/shared/src/settings/registry.ts`) is the single source
 * from which both the Backend's validation and these shapes derive, and that registry has not
 * landed. When it does, this file is deleted and the panels import the shared types — so
 * keeping the provisional copy inside the feature slice makes the seam obvious and stops a
 * half-verified shape from settling into the shared API-type surface.
 *
 * **Bootstrap settings are absent by construction** (F8.2, PRD §4.4): `DATABASE_URL`,
 * `MC_HOST`/`MC_PORT`, `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`. They are required before the
 * database is reachable, so they cannot be stored in it, and the Integrations panel says so in
 * a footnote rather than leaving the operator to wonder where the port setting went.
 */

/**
 * §7.1 read shape for a write-only secret.
 *
 * **`updatedAt` is an addition to §7.1 and is deliberate.** WS5 §4.4/§5.7.3 make the masked
 * row read `•••••••••••• (saved 2026-08-10 09:14)` and call the changed timestamp "the only
 * honest confirmation possible for a write-only value" — a value the UI is forbidden to read
 * back cannot be confirmed any other way. §7.1's `{ isSet: boolean }` alone cannot express it.
 * The field is optional and `null`-tolerant so a Backend that ships §7.1 verbatim degrades to
 * a bare "Set" chip instead of rendering a fake time.
 */
export interface SecretFieldRead {
  readonly isSet: boolean;
  readonly updatedAt?: IsoTimestamp | null;
}

/** §7.1 write shape: `string` sets, `null` clears, omitted keeps. */
export type SecretFieldWrite = string | null;

// -------------------------------------------------------------------------------- general

export const TIME_FORMATS = ['24h', '12h'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export const THEMES = ['dark', 'light'] as const;
export type SettingsTheme = (typeof THEMES)[number];

export const LANDING_PAGES = ['dashboard', 'projects', 'sessions'] as const;
export type LandingPage = (typeof LANDING_PAGES)[number];

export interface GeneralSettings {
  readonly instanceName: string;
  /** IANA name. It is the calendar boundary for spend (§7.8) and the daily report (§7.7). */
  readonly timezone: string;
  readonly dateFormat: string;
  readonly timeFormat: TimeFormat;
  readonly theme: SettingsTheme;
  readonly defaultLandingPage: LandingPage;
}

/** WS5 §5.7.1 offers a closed list; ISO-first because every timestamp on the wire is ISO. */
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY', 'D MMM YYYY'] as const;

// --------------------------------------------------------------------------- integrations

export const WORKFLOW_MODES = ['manual', 'assisted'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export interface GithubSettings {
  readonly token: SecretFieldRead;
  readonly account: string | null;
  readonly organizations: readonly string[];
  /** Absolute native paths (F8.1) — rendered mono, verbatim, never normalised for display. */
  readonly discoveryRoots: readonly string[];
  /** `0` = manual only (§7.7 reads `> 0` as "scheduled"). */
  readonly syncIntervalMinutes: number;
  /** PRD §4.3. The global default; a Project may override it (§4, arbitration A10). */
  readonly workflowMode: WorkflowMode;
}

export interface CostBudget {
  readonly dailyUsd: number | null;
  readonly perSessionUsd: number | null;
  /** 1–100, default 80 (§7.8). */
  readonly alertThresholdPercent: number;
}

export interface ClaudeCodeSettings {
  readonly cliPath: string;
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

/**
 * §7.2's enum, with WS5 §5.7.6's labels attached here rather than invented at the call site.
 * The two documents name the same four policies differently ("Vault wins" is `obsidian_wins`,
 * "Keep both & flag" is `manual`), so the mapping is written down once.
 */
export const OBSIDIAN_CONFLICT_POLICIES = [
  'newer_wins',
  'obsidian_wins',
  'mission_control_wins',
  'manual',
] as const;
export type ObsidianConflictPolicy = (typeof OBSIDIAN_CONFLICT_POLICIES)[number];

export const OBSIDIAN_CONFLICT_POLICY_LABELS: Readonly<Record<ObsidianConflictPolicy, string>> = {
  newer_wins: 'Newest wins',
  obsidian_wins: 'Vault wins',
  mission_control_wins: 'Mission Control wins',
  manual: 'Keep both & flag',
};

export interface ObsidianSettings {
  readonly vaultPath: string | null;
  readonly syncMode: ObsidianSyncMode;
  readonly syncIntervalMinutes: number;
  readonly conflictPolicy: ObsidianConflictPolicy;
}

/**
 * Phase 3 — **live**, not staged. These values are consumed: `embeddingModel` decides whether
 * memory is configured at all, and `host`/`port`/`apiKey` reach a real Qdrant through the
 * shared vector-store port. Test Connection verifies reachability *and* that the collection's
 * embedding stamp agrees with `embeddingModel` (§7.4).
 */
export interface QdrantSettings {
  readonly host: string;
  readonly port: number;
  readonly apiKey: SecretFieldRead;
  readonly embeddingModel: string;
}

/**
 * Phase 3 — `host` and `port`, both live: every embedding is produced through them.
 *
 * The card used to carry two more fields, `enabled` and `defaultModel`, and both described Ollama
 * as an *agent* runtime (PRD §5.4) that this build cannot select — `AGENT_RUNTIMES` has one
 * member. Neither was read by anything, and the toggle's own description said so, which is a
 * strange thing for a switch to have to admit. They were withdrawn from the key registry rather
 * than left as furniture; the embedding model lives on `QdrantSettings.embeddingModel`, beside the
 * collection it must match, and always did.
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

/** URL segments of `PUT /settings/integrations/{integration}` (§7.3) — kebab-case on the wire. */
export const INTEGRATION_SLUGS = [
  'github',
  'claude-code',
  'telegram',
  'obsidian',
  'qdrant',
  'ollama',
] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

// --------------------------------------------------------------------------- notifications

export interface NotificationEventToggles {
  readonly sessionComplete: boolean;
  readonly sessionFailed: boolean;
  readonly syncFailed: boolean;
  readonly repositoryProblem: boolean;
  readonly costBudgetAlert: boolean;
}

export interface NotificationsSettings {
  readonly events: NotificationEventToggles;
  /** `time` is `HH:mm` in `general.timezone` — not the browser's zone. */
  readonly dailyReport: { readonly enabled: boolean; readonly time: string };
  readonly quietHours: {
    readonly enabled: boolean;
    readonly start: string;
    readonly end: string;
  };
}

// ---------------------------------------------------------------------------------- memory

/**
 * The `memory` category document (PRD §4.4 item 4) — deliberately **open**, and this is the one
 * shape in this file that is not written to a contract.
 *
 * Every other category has a settled key registry behind it. `memory` is being filled in as
 * Phase 3 lands, and the two apps ship separately: today's Backend answers `{}`, tomorrow's may
 * answer `retention` + `indexedSources`, and a later one may answer more. Declaring the contract
 * here as a required interface would make the panel *believe* it — it would draw a retention
 * control against `undefined` and present a switch for something nothing reads.
 *
 * So the document is carried as an open record and interpreted at runtime by
 * `panels/memory-shape.ts`, which renders only the keys that actually arrived and carries the
 * rest through the full-category replace untouched.
 */
export type MemorySettingsDocument = Readonly<Record<string, unknown>>;

// -------------------------------------------------------------------------------- security

export interface SecuritySettings {
  readonly sessionTimeoutMinutes: number;
  readonly auditLogRetentionDays: number;
  /** Extra WS/CSRF origins (§14.2), default `[]`. */
  readonly allowedOrigins: readonly string[];
}

// -------------------------------------------------------------------- test connection (§7.4)

/**
 * §7.4: "A completed check is a 200 **regardless of outcome** — failure of the *integration*
 * is data, not an API error." So `ok: false` arrives through the success path and only a
 * refused *request* (e.g. `INTEGRATION_NOT_CONFIGURED`, 409) throws.
 */
export interface TestConnectionResult {
  readonly ok: boolean;
  readonly checkedAt: IsoTimestamp;
  readonly latencyMs: number | null;
  readonly message: string;
  readonly detail: Record<string, unknown> | null;
}

// -------------------------------------------------------------------------- api tokens (§3.2)

/** `POST /auth/tokens` — the one response in the system that carries a raw credential. */
export interface CreatedApiToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: IsoTimestamp | null;
  readonly expiresAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  /** Shown exactly once, never stored by the client, never re-requestable. */
  readonly token: string;
}
