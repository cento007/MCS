import type {
  EntityId,
  IsoTimestamp,
  MessageRole,
  NotificationSeverity,
  NotificationType,
  ServiceStatus,
  SessionState,
  SessionType,
  TelegramDeliveryStatus,
} from '@mc/shared/types';

/**
 * API resource shapes.
 *
 * TDS 05 §2.1 plans for these to be *generated* from WS2's OpenAPI 3.1 document
 * (`openapi-typescript`, types only, no runtime codegen). **No such document exists in the
 * repository yet** — WS2's contract is prose in `docs/tds/04-api-contracts-and-events.md`
 * and the Backend's Fastify schemas. So the Phase 1 shapes below are hand-written against
 * TDS 04 §3/§6 and verified against `apps/backend/src/sessions/serialize.ts`. They are the
 * seam: when the Backend emits `openapi.yaml`, this file is replaced by generated types and
 * nothing else in the SPA moves.
 *
 * The *vocabulary* is never re-declared here — `SessionState`, `SessionType`, `MessageRole`,
 * `EntityId` and `IsoTimestamp` all come from `@mc/shared/types` (F4.1/F4.2), so the client
 * cannot drift from the state machine the Backend enforces.
 */

// ------------------------------------------------------------------------------- auth (§3)

export interface CurrentUser {
  readonly id: EntityId;
  readonly username: string;
}

export interface AuthMe {
  readonly user: CurrentUser;
  readonly authMethod: 'cookie' | 'token';
  /** `null` under bearer-token auth — a token has no server-side session (§3.1). */
  readonly session: { readonly expiresAt: IsoTimestamp } | null;
}

export interface LoginResult {
  readonly user: CurrentUser;
  readonly expiresAt: IsoTimestamp;
}

export interface ApiTokenSummary {
  readonly id: EntityId;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: IsoTimestamp | null;
  readonly expiresAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

// --------------------------------------------------------------------------- sessions (§6)

export interface SessionObservation {
  readonly channel: 'hooks_and_transcript' | 'hooks_only' | 'transcript_only';
  readonly degraded: boolean;
  readonly reason: string | null;
  readonly driftCount: number;
  readonly updatedAt: IsoTimestamp;
}

export interface SessionRuntimeInfo {
  readonly kind: string;
  /** Claude Code's own UUIDv4, not one of ours (F1.5). */
  readonly runtimeSessionId: string | null;
  readonly claudeVersion: string | null;
  readonly model: string | null;
  readonly machine: string | null;
  readonly environment: string | null;
}

export interface Session {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly repositoryId: EntityId | null;
  readonly sessionType: SessionType;
  readonly state: SessionState;
  /** Always a string; `''` is the unset value (§6.1). Display falls back per §9.3. */
  readonly title: string;
  /**
   * Why a `failed` Session failed — `spawn_error`, `process_crash`, `backend_restart`, … —
   * mirroring `sessions.failure_reason` (TDS 03 §3.9). `null` in every other state, and
   * legitimately `null` in `failed` too when the transition carried no reason.
   *
   * It is the whole triage signal, and both surfaces that render it are specified to: the
   * Needs Attention row (§5.2) and the §5.5 failure banner. Read it from here rather than
   * from the timeline — the column and the `session.state_changed` payload are written from
   * the same argument in the same transaction, so the resource is the cheaper of two
   * identical answers.
   */
  readonly failureReason: string | null;
  readonly notes: string | null;
  readonly branch: string | null;
  readonly workingDirectory: string;
  /**
   * The Agent persona this Session runs as (PRD §5.1), or `null`.
   *
   * **The id only.** The Agent resource is served by `GET /agents/{id}`; inlining a persona's
   * instructions into every Session payload would put a 20 000-character system prompt on the
   * session list. The consequence of the binding — the tools removed from the runtime — is read
   * from the Agent, which is why the Session header resolves the id rather than displaying it.
   *
   * This field was served by `apps/backend/src/sessions/serialize.ts` from Phase 4 slice 1 and was
   * **missing from this hand-written type until slice 2**, which is exactly the failure mode the
   * header note above describes: nothing in the SPA could see an agent, so nothing offered one.
   */
  readonly agentId: EntityId | null;
  readonly runtime: SessionRuntimeInfo;
  readonly observation: SessionObservation | null;
  readonly costUsd: number | null;
  readonly tokenUsage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  } | null;
  readonly durationSeconds: number | null;
  readonly resumedFromSessionId: EntityId | null;
  readonly clonedFromSessionId: EntityId | null;
  readonly createdAt: IsoTimestamp;
  readonly startedAt: IsoTimestamp | null;
  readonly completedAt: IsoTimestamp | null;
  readonly archivedAt: IsoTimestamp | null;
  readonly updatedAt: IsoTimestamp;
}

/** Blocks are opaque past `type`: unknown block kinds render a neutral fallback (§6.2). */
export interface MessageContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Message {
  readonly id: EntityId;
  readonly sessionId: EntityId;
  /** Per-session ordering key; the messages cursor is keyed on this, never on `id` (§6.6). */
  readonly ordinal: number;
  readonly role: MessageRole;
  readonly status: 'complete' | 'pending' | 'interrupted';
  readonly content: readonly MessageContentBlock[];
  readonly model: string | null;
  readonly tokenUsage: { readonly input: number; readonly output: number } | null;
  readonly runtimeUuid: string | null;
  readonly occurredAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

/**
 * `meta.launch` on `start` / in-place `resume` (§6.2.1). Saturation is **never** an error:
 * `queued` means the Session stayed in its pre-launch state and a durable `session.launch`
 * job will move it, so the UI renders a "Queued for launch" affordance rather than a failure.
 */
export interface LaunchMeta {
  readonly launch: 'started' | 'queued';
}

export interface SessionActionResult {
  readonly data: Session;
  readonly meta?: LaunchMeta;
}

/** `POST /sessions/{id}/interrupt` (§6.3.1) — no F7 transition, hence no `state` here. */
export interface InterruptResult {
  readonly sessionId: EntityId;
  /** The retained partial Message; `null` when the turn produced no persisted content. */
  readonly messageId: EntityId | null;
}

/** §6.7 — `kind` is a presentation projection of `type`, never a second vocabulary. */
export type TimelineKind =
  | 'state_changed'
  | 'commit_linked'
  | 'prompt_submitted'
  | 'tool_used'
  | 'observation_changed'
  | 'other';

export interface TimelineEntry {
  readonly id: EntityId;
  readonly occurredAt: IsoTimestamp;
  /** The F6 event name, verbatim. `kind` is derived from it (§6.7). */
  readonly type: string;
  readonly kind: TimelineKind;
  readonly trigger: 'user' | 'system';
  readonly fromState?: SessionState;
  readonly toState?: SessionState;
  readonly refType?: 'commit' | 'message';
  readonly refId?: EntityId;
  readonly detail?: string;
}

/** §5.2 / §6.10.1 — the Session-scoped list carries no `files[]`. */
export interface Commit {
  readonly id: EntityId;
  readonly repositoryId: EntityId;
  readonly sessionId: EntityId | null;
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  readonly committedAt: IsoTimestamp;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: IsoTimestamp;
}

export interface SessionFileTouch {
  /** Root-relative with `/` separators — or the absolute native path when `outsideRoot`. */
  readonly path: string;
  readonly outsideRoot: boolean;
  readonly touchCount: number;
  readonly toolTouchCount: number;
  readonly commitCount: number;
  readonly sources: readonly ('tool' | 'commit')[];
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly lastTouchedAt: IsoTimestamp;
}

/**
 * §6.10.2 — a bounded read model, so no cursor and no `meta`. `completeness` is contractual:
 * "a Files tab that merely looks short is indistinguishable from a Session that genuinely
 * touched few files", so `partial` must be rendered, never quietly absorbed.
 */
export interface SessionFiles {
  readonly root: string;
  readonly files: readonly SessionFileTouch[];
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly commitsAsOf: IsoTimestamp | null;
  readonly completeness: 'complete' | 'partial';
  readonly completenessReason: 'observation_degraded' | 'hooks_not_installed' | null;
}

// -------------------------------------------------------------------------- projects (§4)

export interface Project {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly description: string | null;
  /** `null` = inherit `integrations.github.workflowMode` (§4, arbitration A10). */
  readonly workflowMode: 'manual' | 'assisted' | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly archivedAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------- repositories (§5.1)

export interface Repository {
  readonly id: EntityId;
  readonly projectId: EntityId | null;
  readonly name: string;
  /** Absolute native path (F8.1). The launch modal shows this verbatim — never a nickname. */
  readonly localPath: string;
  readonly remoteUrl: string | null;
  readonly visibility: 'public' | 'private' | 'unknown';
  readonly defaultBranch: string;
  readonly lastSyncedAt: IsoTimestamp | null;
  readonly syncStatus: 'ok' | 'failed' | 'never';
  /**
   * Why the last sync failed. Additive to §5.1 and served by the Backend, which justifies the
   * column with the requirement this client implements: the Repositories view must be able to
   * explain a `failed` badge **without sending the operator to the audit log** (TDS 03 §3.6,
   * finding B8). A badge with no explanation is a dead end, so the column and this field exist
   * specifically so the row can carry the reason.
   */
  readonly lastSyncError: string | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Why a working tree could not be read, verbatim from the Backend's `WorkingTreeUnavailableReason`
 * (`apps/backend/src/repositories/git.ts`).
 *
 * These are **answers, not errors**: `GET /repositories/{id}/status` returns `200` with one of
 * these set rather than failing, because "the path was deleted" is a fact about the repository
 * and not a fault in the request. The UI's obligation is to render every one of them as
 * *unverifiable* — never as clean.
 */
export const WORKING_TREE_UNAVAILABLE_REASONS = [
  'path_missing',
  'not_a_directory',
  'not_a_git_repository',
  'git_unavailable',
  'timed_out',
  'git_failed',
] as const;

export type WorkingTreeUnavailableReason = (typeof WORKING_TREE_UNAVAILABLE_REASONS)[number];

/**
 * `GET /repositories/{id}/status` — a bounded, computed read model (§1.2: `{ data }`, no `meta`).
 *
 * Nothing here is persisted; every field is true as of `checkedAt` and stale immediately after.
 */
export interface RepositoryStatus {
  readonly repositoryId: EntityId;
  readonly localPath: string;
  readonly isGitWorkingTree: boolean;
  /** `null` when detached, unnamed, or unreadable. */
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  readonly headSha: string | null;
  /** Tracked modifications + staged + untracked. `null` when the tree could not be read. */
  readonly uncommittedFiles: number | null;
  /** Relative to the upstream branch; `null` when there is no upstream. */
  readonly ahead: number | null;
  readonly behind: number | null;
  /** `null` iff the tree was read. */
  readonly unavailableReason: WorkingTreeUnavailableReason | null;
  /** git's own first line of complaint, truncated. Never invented by the server. */
  readonly detail: string | null;
  readonly checkedAt: IsoTimestamp;
}

/**
 * `POST /repositories/discover` — the discovery report.
 *
 * The route answers `200` with the report rather than §5.1's `202 { jobId }`, and the Backend
 * flags that deviation with its reason: **the skip reasons have nowhere else to live.** "This
 * directory has no remote", "this one points at GitLab", "this one is already registered" are
 * the entire value of running a scan, and no table stores them — a `202` would discard them and
 * leave the operator guessing why a repository they expected did not appear. So the client
 * renders them, which is the only thing that makes the deviation worth having.
 *
 * Typed loosely past the fields this client renders: it is a young, flagged contract, and a
 * strict mirror would turn a server-side field rename into a crashed screen rather than a
 * missing line.
 */
export interface DiscoverySkip {
  readonly localPath: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly repositoryId: string | null;
}

export interface DiscoveredRepositoryEntry {
  readonly repository: Repository;
  readonly owner: string;
  readonly repo: string;
}

export interface DiscoveryReport {
  readonly scannedAt: IsoTimestamp;
  /** A cap or the wall-clock deadline stopped the scan early — say so, never imply completeness. */
  readonly truncated: boolean;
  readonly registered: readonly DiscoveredRepositoryEntry[];
  readonly skipped: readonly DiscoverySkip[];
  readonly counts: {
    readonly workingTreesFound: number;
    readonly registered: number;
    readonly skipped: number;
  };
}

/** `POST /repositories/{id}/sync` — `202 { data: { jobId } }` (§5.1). */
export interface SyncAccepted {
  readonly jobId: string;
}

// --------------------------------------------------------------- service health (§7.5)

/**
 * Re-exported from `@mc/shared`, not re-declared. This file previously carried its own copy
 * reading `'ok' | … | 'not_configured'` — no overlap with the API on the two most common
 * values — so a Services panel written against it typechecked cleanly while rendering every
 * healthy service as unknown. One declaration makes the next mismatch a compile error.
 */
export type { ServiceStatus };

export interface ServiceHealthRow {
  readonly name: string;
  /** Display name from the server, e.g. `Queue (PostgreSQL)` — never derive it client-side. */
  readonly label: string;
  readonly status: ServiceStatus;
  readonly detail: string | null;
  readonly checkedAt: IsoTimestamp;
  /** Probe-specific extras (latency, heartbeat age, queue depth). Shape varies by service. */
  readonly meta: Record<string, unknown> | null;
}

/** `GET /services/health` answers the read model, not a bare array (§7.5). */
export interface ServiceHealth {
  readonly services: readonly ServiceHealthRow[];
}

// --------------------------------------------------------------------------- schedule (§7.7)

/**
 * The computed schedule read model behind the Dashboard's "Upcoming Tasks" widget.
 *
 * **There is no Task entity and none is implied** (WS7 arbitration A1, TDS 06 §6.2 footnote).
 * Every value here is derived at read time from Settings plus last-run records; nothing is
 * persisted, no event exists, and the widget that renders it says so.
 */
export type ScheduleKind = 'obsidian_sync' | 'github_poll' | 'daily_report';

export interface ScheduleEntry {
  readonly kind: ScheduleKind;
  /** Display text from the server, e.g. `Obsidian vault sync`. */
  readonly label: string;
  readonly enabled: boolean;
  /**
   * `null` whenever the row is disabled or its interval is 0 — the row is still returned so
   * the UI can say *why* nothing is scheduled instead of hiding it (§7.7).
   */
  readonly nextRunAt: IsoTimestamp | null;
  readonly lastRunAt: IsoTimestamp | null;
}

// ------------------------------------------------------------------------------ spend (§7.8)

export interface SpendPeriod {
  /** ISO 8601 UTC, inclusive. */
  readonly periodStart: IsoTimestamp;
  /** ISO 8601 UTC, exclusive. */
  readonly periodEnd: IsoTimestamp;
  readonly totalCostUsd: number;
  readonly sessionCount: number;
}

/**
 * **Computed server-side, deliberately** (§7.8): four surfaces state the same spend number —
 * the Dashboard Spend widget, the top-bar chip, the Needs Attention budget row and the
 * current-spend line in Settings → Claude Code — and they must never disagree about when the
 * bar turns amber. The client rounds a percentage for display and derives nothing else.
 */
export type SpendDayStatus = 'no_budget' | 'ok' | 'alert' | 'over';

export interface Spend {
  /** The IANA zone actually used — `general.timezone`, or `UTC` when unset/unparseable. */
  readonly timezone: string;
  readonly generatedAt: IsoTimestamp;
  /** Current calendar day **in `timezone`**, never UTC-by-accident (§7.8). */
  readonly day: SpendPeriod;
  readonly month: SpendPeriod;
  readonly budget: {
    readonly dailyUsd: number | null;
    readonly perSessionUsd: number | null;
    readonly alertThresholdPercent: number;
    readonly alertsEnabled: boolean;
  };
  readonly dayStatus: SpendDayStatus;
}

// ---------------------------------------------------------------------- notifications (§8)

export interface Notification {
  readonly id: EntityId;
  /** The notification-type enum — never an F6 event name (arbitration A8). */
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  /** Pre-rendered text; Telegram and the UI share it. */
  readonly body: string;
  /** Entity IDs for deep links; `payload.eventType` carries the originating F6 event. */
  readonly payload: Record<string, unknown> | null;
  readonly correlationId: string | null;
  /** The in-app "delivery" state. `null` = unread. */
  readonly readAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly telegram: {
    readonly status: TelegramDeliveryStatus;
    readonly sentAt: IsoTimestamp | null;
    readonly error: string | null;
  };
}
