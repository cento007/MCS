/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Emitted from `openapi.yaml`'s components by `pnpm api:types`, which builds the Backend's route
 * table and reads the response schemas the routes declare. `pnpm api:types:check` fails when this
 * file and those routes disagree, exactly as `pnpm api:spec:check` does for the document itself.
 *
 * **This file exists because a hand-written copy was wrong twice while typechecking cleanly.**
 * `ServiceHealthRow.status` once read `'ok' | … | 'not_configured'` against an API answering
 * `'healthy' | 'disabled'`; `Repository.lastSyncError` was omitted entirely; and `Session.agentId`
 * — added to the Backend's serializer in Phase 4 slice 1 — never reached the client type, which
 * made the whole agent runtime binding unreachable from the browser until slice 2 noticed.
 *
 * The prose that used to live here now lives next to the schemas these types are generated from
 * (`apps/backend/src/<domain>/response-schemas.ts`), which is the only place it cannot drift from
 * shape it describes. Field-level notes that survived the move are the `description` keyword on
 * those schemas and are reproduced below.
 *
 * Types that are still hand-written, and why, are in `./types.ts` — the seam is marked there.
 */

export interface Adr {
  readonly id: string;
  readonly projectId: string;
  readonly adrNumber: number;
  readonly title: string;
  readonly status: AdrStatus;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: string;
  readonly consequences: string;
  readonly sourceSessionId: string | null;
  readonly supersededByAdrId: string | null;
  readonly obsidianPath: string | null;
  readonly syncedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdrStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly runtime: AgentRuntime;
  readonly permissions: AgentPermissions;
  /** Derived from `permissions` by the same function the launch path calls, and never accepted on a write. `permissions` says what was asked for; this says what actually happens to the runtime, so the model can be audited rather than trusted. */
  readonly disallowedTools: readonly string[];
  readonly instructions: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentPermissions {
  readonly repository: {
    readonly read: boolean;
    readonly write: boolean;
    readonly shell: boolean;
  };
}

export type AgentRuntime = 'claude_code';

export type AgentScope = 'global' | 'project' | 'session';

export interface AgentTeam {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentTeamScope;
  readonly projectId: string | null;
  readonly members: readonly AgentTeamMember[];
  readonly projectIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentTeamMember {
  readonly agentId: string;
  readonly name: string;
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly runtime: AgentRuntime;
  readonly archivedAt: string | null;
  readonly addedAt: string;
}

export type AgentTeamScope = 'global' | 'project';

export interface AgentWorkflow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentWorkflowScope;
  readonly projectId: string | null;
  readonly steps: readonly AgentWorkflowStep[];
  readonly stepCount: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentWorkflowHandoff {
  readonly state: AgentWorkflowHandoffState;
  readonly reason: string | null;
  readonly promptBytes: number;
}

export type AgentWorkflowHandoffState = 'none' | 'full' | 'degraded';

export interface AgentWorkflowRun {
  readonly id: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly task: string;
  readonly workingDirectory: string;
  readonly branch: string | null;
  readonly model: string | null;
  readonly state: AgentWorkflowRunState;
  readonly stepCount: number;
  readonly currentStepOrdinal: number | null;
  readonly maxSessions: number;
  readonly sessionsLaunched: number;
  readonly haltReason: string | null;
  readonly steps: readonly AgentWorkflowRunStep[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentWorkflowRunState = 'running' | 'completed' | 'halted' | 'stopped';

export interface AgentWorkflowRunStep {
  readonly ordinal: number;
  readonly attempt: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly state: AgentWorkflowRunStepState;
  readonly handoff: AgentWorkflowHandoff;
  readonly promptSentAt: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export type AgentWorkflowRunStepState = 'running' | 'completed' | 'failed' | 'stopped';

export type AgentWorkflowScope = 'global' | 'project';

export interface AgentWorkflowStep {
  readonly ordinal: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentScope: string;
  readonly agentProjectId: string | null;
  readonly agentArchivedAt: string | null;
  readonly instructions: string | null;
}

export interface AgentsSettings {
  readonly defaultPermissionTemplate: 'read_only' | 'read_write' | 'full';
}

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ('full' | 'ingest')[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface AssignedTeam {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentTeamScope;
  readonly projectId: string | null;
  readonly memberCount: number;
  readonly archivedMemberCount: number;
  readonly assignedAt: string;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: 'user' | 'agent' | 'system';
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly requestId: string | null;
}

export interface AuthMe {
  readonly user: CurrentUser;
  readonly authMethod: 'cookie' | 'token';
  readonly session: AuthSession | null;
}

export interface AuthSession {
  readonly expiresAt: string;
}

export interface AvailableAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly runtime: AgentRuntime;
  readonly permissions: AgentPermissions;
  /** Derived from `permissions` by the same function the launch path calls, and never accepted on a write. `permissions` says what was asked for; this says what actually happens to the runtime, so the model can be audited rather than trusted. */
  readonly disallowedTools: readonly string[];
  readonly instructions: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly onTeam: boolean;
}

export interface ClaudeCodeSettings {
  readonly cliPath: string;
  readonly defaultModel: string;
  readonly maxConcurrentSessions: number;
  readonly costBudget: {
    readonly dailyUsd: number | null;
    readonly perSessionUsd: number | null;
    readonly alertThresholdPercent: number;
  };
}

export interface Commit {
  readonly id: string;
  readonly repositoryId: string;
  readonly sessionId: string | null;
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  readonly committedAt: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
}

export interface CommitDetail {
  readonly id: string;
  readonly repositoryId: string;
  readonly sessionId: string | null;
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  readonly committedAt: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly files: readonly CommitFile[];
}

export interface CommitFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly additions: number;
  readonly deletions: number;
}

export interface ContextPackage {
  readonly content: string;
  readonly tokenEstimate: number;
  readonly bytes: number;
  readonly generatedAt: string;
  readonly relatedContext: ContextPackageRelated;
}

export type ContextPackageGapReason =
  | 'not_configured'
  | 'unavailable'
  | 'stamp_mismatch'
  | 'index_empty'
  | 'below_threshold'
  | 'timed_out'
  | 'no_query'
  | 'only_own_session';

export interface ContextPackageRelated {
  readonly resultCount: number;
  readonly gapReason: ContextPackageGapReason | null;
  readonly gapDetail: string | null;
  readonly embeddingModel: string | null;
}

export interface CreatedApiToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ('full' | 'ingest')[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly token: string;
}

export interface CurrentUser {
  readonly id: string;
  readonly username: string;
}

export interface DiscoveredRepository {
  readonly repository: Repository;
  readonly owner: string;
  readonly repo: string;
}

export interface DiscoveryReport {
  readonly scannedAt: string;
  readonly truncated: boolean;
  readonly roots: readonly DiscoveryRoot[];
  readonly registered: readonly DiscoveredRepository[];
  readonly skipped: readonly DiscoverySkip[];
  readonly counts: {
    readonly workingTreesFound: number;
    readonly registered: number;
    readonly skipped: number;
  };
  readonly workflowMode: GithubWorkflowMode;
  readonly capability: 'read_only';
}

export interface DiscoveryRoot {
  readonly path: string;
  readonly status: DiscoveryRootStatus;
  readonly found: number;
  readonly detail: string | null;
}

export type DiscoveryRootStatus =
  | 'scanned'
  | 'scanned_as_repository'
  | 'path_missing'
  | 'not_a_directory'
  | 'not_absolute'
  | 'unreadable'
  | 'truncated';

export interface DiscoverySkip {
  readonly localPath: string;
  readonly reason: DiscoverySkipReason;
  readonly detail: string | null;
  readonly repositoryId: string | null;
}

export type DiscoverySkipReason =
  | 'already_registered'
  | 'not_a_git_repository'
  | 'no_remote'
  | 'remote_not_github'
  | 'remote_unreadable'
  | 'invalid_path';

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorEnvelopeCode;
    readonly message: string;
    readonly details: Record<string, unknown> | null;
    /** Also returned as the X-Request-Id header, and in every log line. */
    readonly requestId: string;
  };
}

/**
 * The F5.4 error-code registry (TDS 04 §1.3), verbatim from the Backend’s http/errors.ts.
 * Named ErrorEnvelopeCode rather than ErrorCode because the SPA already owns that name for a
 * deliberately wider union: lib/api/errors.ts admits codes the client synthesises for failures
 * that never reached the server (NETWORK_ERROR, ABORTED). This is the server’s list only.
 */
export type ErrorEnvelopeCode =
  | 'CONFLICT'
  | 'DATABASE_SCHEMA_MISMATCH'
  | 'FORBIDDEN'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'INTERNAL'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CURSOR'
  | 'INVALID_STATE_TRANSITION'
  | 'NOT_FOUND'
  | 'NO_TURN_IN_FLIGHT'
  | 'OPERATION_NOT_SUPPORTED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'RUNTIME_UNAVAILABLE'
  | 'SESSION_NOT_RUNNING'
  | 'UNAUTHORIZED'
  | 'VALIDATION_FAILED';

export interface GeneralSettings {
  readonly instanceName: string;
  readonly timezone: string;
  readonly dateFormat: 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM/DD/YYYY' | 'D MMM YYYY';
  readonly timeFormat: '24h' | '12h';
  readonly theme: 'dark' | 'light';
  readonly defaultLandingPage: 'dashboard' | 'projects' | 'sessions';
}

export interface GithubSettings {
  readonly token: SecretFieldRead;
  readonly account: string | null;
  readonly organizations: readonly string[];
  readonly discoveryRoots: readonly string[];
  readonly syncIntervalMinutes: number;
  readonly workflowMode: 'manual' | 'assisted';
}

export type GithubWorkflowMode = 'manual' | 'assisted';

export interface IntegrationsSettings {
  readonly github: GithubSettings;
  readonly claudeCode: ClaudeCodeSettings;
  readonly telegram: TelegramSettings;
  readonly obsidian: ObsidianSettings;
  readonly qdrant: QdrantSettings;
  readonly ollama: OllamaSettings;
}

export interface InterruptResult {
  readonly sessionId: string;
  readonly messageId: string | null;
}

export interface JobAccepted {
  readonly jobId: string;
}

export interface LaunchMeta {
  /** `queued` means the Session stayed in its pre-launch state and a durable session.launch job will move it. Render it as 'Queued for launch', never as a failure. */
  readonly launch: 'started' | 'queued';
}

export interface ListEnvelopeMeta {
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface LoginResult {
  readonly user: CurrentUser;
  readonly expiresAt: string;
}

export interface MemoryBackfillAccepted {
  readonly runId: string;
  readonly state: string;
  readonly mode: 'incremental' | 'rebuild';
  readonly createdAt: string;
}

export interface MemoryBackfillProgress {
  readonly stage: 'adr' | 'pull_request' | 'commit' | 'session' | null;
  readonly cursor: string | null;
  readonly sourcesSeen: number;
  readonly sourcesIndexed: number;
  readonly sourcesSkipped: number;
  readonly chunksEmbedded: number;
  readonly chunksDeleted: number;
  readonly failures: number;
  readonly lastError: string | null;
  readonly pruned: number;
  readonly notesDone: boolean;
  readonly documentsDone: boolean;
}

export interface MemoryBackfillStatus {
  readonly runId: string | null;
  readonly state: string | null;
  readonly mode: MemoryRunMode | null;
  readonly trigger: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
  readonly progress: MemoryBackfillProgress | null;
  readonly summary: string | null;
  readonly configured: boolean;
  readonly runtime: MemoryRuntimeKind;
  readonly runtimeReason: string | null;
  readonly indexedModels: readonly string[];
  readonly rowsFromOtherModels: number;
}

export type MemoryEmptyReason =
  | 'none'
  | 'not_configured'
  | 'unavailable'
  | 'stamp_mismatch'
  | 'index_empty'
  | 'below_threshold';

export interface MemoryItem {
  readonly memoryItemId: string;
  readonly score: number;
  readonly tier: MemoryTier;
  readonly sourceType: MemorySourceType;
  readonly sourceId: string | null;
  readonly sourceRef: string | null;
  readonly title: string;
  readonly content: string;
  readonly chunkOrdinal: number;
  readonly chunkCount: number;
  readonly occurredAt: string | null;
  readonly context: MemoryResultContext;
}

export interface MemoryResultContext {
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly sessionId: string | null;
}

export type MemoryRunMode = 'incremental' | 'rebuild';

export type MemoryRuntimeKind = 'not_configured' | 'unavailable' | 'stamp_mismatch' | 'ready';

export interface MemorySearchResponse {
  readonly results: readonly MemoryItem[];
  /** Six situations that all render as "no results" and for which the operator next action is completely different. A screen that renders them as one sends the operator to the wrong place four times out of five. */
  readonly emptyReason: MemoryEmptyReason;
  readonly detail: string | null;
  readonly minScore: number;
  readonly embeddingModel: string | null;
  readonly candidatesConsidered: number;
}

export interface MemorySettings {
  readonly indexedSources: {
    readonly session: boolean;
    readonly commit: boolean;
    readonly adr: boolean;
    readonly obsidianNote: boolean;
    readonly pullRequest: boolean;
    readonly document: boolean;
  };
  readonly retentionDays: {
    readonly session: number;
    readonly project: number;
    readonly global: number;
  };
}

export type MemorySourceType = 'session' | 'commit' | 'adr' | 'obsidian_note' | 'pull_request' | 'document';

export type MemoryTier = 'session' | 'project' | 'agent' | 'global';

export interface Message {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly role: MessageRole;
  readonly status: 'complete' | 'pending' | 'interrupted';
  readonly content: readonly MessageContentBlock[];
  readonly model: string | null;
  readonly tokenUsage: MessageTokenUsage | null;
  readonly runtimeUuid: string | null;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface MessageContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageTokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface Notification {
  readonly id: string;
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly payload: Record<string, unknown> | null;
  readonly correlationId: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly telegram: NotificationTelegramDelivery;
}

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface NotificationTelegramDelivery {
  readonly status: TelegramDeliveryStatus;
  readonly sentAt: string | null;
  readonly error: string | null;
}

export type NotificationType =
  | 'session_completed'
  | 'session_failed'
  | 'sync_failed'
  | 'repository_problem'
  | 'daily_report'
  | 'cost_budget_alert';

export interface NotificationsReadAll {
  readonly updated: number;
}

export interface NotificationsSettings {
  readonly events: {
    readonly sessionComplete: boolean;
    readonly sessionFailed: boolean;
    readonly syncFailed: boolean;
    readonly repositoryProblem: boolean;
    readonly costBudgetAlert: boolean;
  };
  readonly dailyReport: {
    readonly enabled: boolean;
    readonly time: string;
  };
  readonly quietHours: {
    readonly enabled: boolean;
    readonly start: string;
    readonly end: string;
  };
}

export interface ObsidianSettings {
  readonly vaultPath: string | null;
  readonly syncMode: 'two_way' | 'one_way' | 'paused';
  readonly syncIntervalMinutes: number;
  readonly conflictPolicy: 'newer_wins' | 'obsidian_wins' | 'mission_control_wins' | 'manual';
}

export type ObsidianSyncMode = 'two_way' | 'one_way' | 'paused';

export interface OllamaSettings {
  readonly host: string;
  readonly port: number;
}

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  /** null means INHERIT integrations.github.workflowMode (arbitration A10), not "no mode". Three-valued by design: a two-valued field could not express "follow the global default". */
  readonly workflowMode: WorkflowMode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ProjectAvailableAgents {
  readonly projectId: string;
  readonly team: AssignedTeam | null;
  readonly agents: readonly AvailableAgent[];
}

export interface PullRequest {
  readonly id: string;
  readonly repositoryId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly state: PullRequestState;
  readonly authorLogin: string | null;
  readonly sourceBranch: string | null;
  readonly targetBranch: string | null;
  readonly openedAt: string | null;
  readonly reviewedAt: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequestDetail {
  readonly id: string;
  readonly repositoryId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly state: PullRequestState;
  readonly authorLogin: string | null;
  readonly sourceBranch: string | null;
  readonly targetBranch: string | null;
  readonly openedAt: string | null;
  readonly reviewedAt: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly description: string | null;
}

export type PullRequestState = 'open' | 'merged' | 'closed' | 'draft';

export interface QdrantSettings {
  readonly host: string;
  readonly port: number;
  readonly apiKey: SecretFieldRead;
  readonly embeddingModel: string;
}

export interface Repository {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly localPath: string;
  readonly remoteUrl: string | null;
  readonly visibility: RepositoryVisibility;
  readonly defaultBranch: string;
  readonly lastSyncedAt: string | null;
  readonly syncStatus: RepositorySyncStatus;
  /** Why the last sync failed. Additive to TDS 04 5.1 and served so the Repositories view can explain a `failed` badge without sending the operator to the audit log. */
  readonly lastSyncError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepositoryStatus {
  readonly repositoryId: string;
  readonly localPath: string;
  readonly isGitWorkingTree: boolean;
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  readonly headSha: string | null;
  readonly uncommittedFiles: number | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  /** null iff the tree was read. Otherwise why not - an answer, not an error. Every value must render as *unverifiable*, never as clean. */
  readonly unavailableReason: WorkingTreeUnavailableReason | null;
  readonly detail: string | null;
  readonly checkedAt: string;
}

export type RepositorySyncStatus = 'ok' | 'failed' | 'never';

export type RepositoryVisibility = 'public' | 'private' | 'unknown';

export interface SearchResult {
  readonly type: SearchType;
  readonly id: string;
  /** PLAIN TEXT - render as text, never as HTML. It is the branch label straight from the corpus, so a commit subject containing markup arrives with those characters intact. */
  readonly title: string;
  /** HTML - and <mark>/</mark> are the only tags it can contain. Everything from the corpus is escaped first, which is what makes that promise also the bound. */
  readonly snippet: string;
  readonly occurredAt: string;
  readonly rank: number;
  readonly context: SearchResultContext;
}

export interface SearchResultContext {
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly sessionId: string | null;
}

export type SearchType = 'session' | 'adr' | 'commit' | 'message' | 'pull_request';

export interface SecretFieldRead {
  readonly isSet: boolean;
  readonly updatedAt: string | null;
}

export interface SecuritySettings {
  readonly sessionTimeoutMinutes: number;
  readonly auditLogRetentionDays: number;
  readonly allowedOrigins: readonly string[];
}

export interface Session {
  readonly id: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly sessionType: SessionType;
  readonly state: SessionState;
  /** Always a string; '' is the unset value, not a title of zero length. Display falls back to a derived label. */
  readonly title: string;
  /** Why a `failed` Session failed - spawn_error, process_crash, backend_restart. `null` in every other state, and legitimately `null` in `failed` too when the transition carried no reason. It is the whole triage signal. */
  readonly failureReason: string | null;
  readonly notes: string | null;
  readonly branch: string | null;
  readonly workingDirectory: string;
  /** The Agent persona this Session runs as (PRD 5.1), or null. The id ONLY - the Agent resource is served by GET /agents/{id}, because inlining a persona would put a 20 000-character system prompt on the session list. */
  readonly agentId: string | null;
  readonly runtime: SessionRuntimeInfo;
  readonly observation: SessionObservation | null;
  readonly costUsd: number | null;
  readonly tokenUsage: SessionTokenUsage | null;
  readonly durationSeconds: number | null;
  readonly resumedFromSessionId: string | null;
  readonly clonedFromSessionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface SessionExport {
  readonly format: 'markdown';
  readonly filename: string;
  readonly content: string;
}

export interface SessionFileTouch {
  readonly path: string;
  readonly outsideRoot: boolean;
  readonly touchCount: number;
  readonly toolTouchCount: number;
  readonly commitCount: number;
  readonly sources: readonly ('tool' | 'commit')[];
  readonly status: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly lastTouchedAt: string;
}

export interface SessionFiles {
  readonly root: string;
  readonly files: readonly SessionFileTouch[];
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly commitsAsOf: string | null;
  /** Contractual: a Files tab that merely looks short is indistinguishable from a Session that genuinely touched few files, so `partial` must be rendered and never quietly absorbed. */
  readonly completeness: 'complete' | 'partial';
  readonly completenessReason: 'observation_degraded' | 'hooks_not_installed' | null;
}

export interface SessionObservation {
  readonly channel: 'hooks_and_transcript' | 'hooks_only' | 'transcript_only';
  readonly degraded: boolean;
  readonly reason: string | null;
  readonly driftCount: number;
  readonly updatedAt: string;
}

export interface SessionRuntimeInfo {
  readonly kind: string;
  readonly runtimeSessionId: string | null;
  readonly claudeVersion: string | null;
  readonly model: string | null;
  readonly machine: string | null;
  readonly environment: string | null;
}

export type SessionState = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'archived';

export interface SessionTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type SessionType = 'managed' | 'observed';

export interface SettingsDocument {
  readonly general: GeneralSettings;
  readonly notifications: NotificationsSettings;
  readonly memory: MemorySettings;
  readonly agents: AgentsSettings;
  readonly security: SecuritySettings;
  readonly integrations: IntegrationsSettings;
}

export interface Spend {
  readonly timezone: string;
  readonly generatedAt: string;
  readonly day: SpendPeriod;
  readonly month: SpendPeriod;
  readonly budget: SpendBudget;
  /** Computed server-side, deliberately: four surfaces state the same spend number and must never disagree about when the bar turns amber. The client rounds a percentage for display and derives nothing else. */
  readonly dayStatus: SpendDayStatus;
}

export interface SpendBudget {
  readonly dailyUsd: number | null;
  readonly perSessionUsd: number | null;
  readonly alertThresholdPercent: number;
  readonly alertsEnabled: boolean;
}

export type SpendDayStatus = 'no_budget' | 'ok' | 'alert' | 'over';

export interface SpendPeriod {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalCostUsd: number;
  readonly sessionCount: number;
}

export interface StoppedSession {
  readonly sessionId: string;
  readonly outcome: 'ended' | 'cancelled' | 'already_terminal';
}

export interface SyncPreview {
  readonly vaultPath: string;
  readonly syncMode: ObsidianSyncMode;
  readonly conflictPolicy: string;
  readonly paused: boolean;
  readonly problem: {
    readonly kind: string;
    readonly detail: string;
  } | null;
  readonly summary: SyncPreviewSummary;
  readonly items: readonly SyncPreviewItem[];
  readonly itemsTruncated: boolean;
  readonly duplicateIdPaths: readonly string[];
}

export interface SyncPreviewItem {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly vaultPath: string;
  readonly reason: string;
  readonly resolution: string | null;
  readonly wouldKeepVaultCopy: boolean;
}

export interface SyncPreviewSummary {
  readonly create: number;
  readonly update: number;
  readonly import: number;
  readonly inSync: number;
  readonly conflict: number;
  readonly pendingPull: number;
  readonly error: number;
  readonly unmanaged: number;
}

export interface SyncRun {
  readonly id: string;
  readonly kind: 'obsidian';
  readonly state: SyncRunState;
  readonly trigger: SyncRunTrigger;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly stats: SyncRunStats | null;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface SyncRunDetail {
  readonly id: string;
  readonly kind: 'obsidian';
  readonly state: SyncRunState;
  readonly trigger: SyncRunTrigger;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly stats: SyncRunStats | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly conflicts: readonly SyncRunFileDetail[];
  readonly errors: readonly SyncRunFileDetail[];
}

export interface SyncRunFileDetail {
  readonly vaultPath: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastSyncedAt: string | null;
}

export type SyncRunState = 'queued' | 'running' | 'completed' | 'failed';

export interface SyncRunStats {
  readonly notesExported: number;
  readonly notesImported: number;
  readonly conflicts: number;
}

export type SyncRunTrigger = 'user' | 'schedule';

export type TelegramDeliveryStatus = 'skipped' | 'pending' | 'sent' | 'failed';

export interface TelegramSettings {
  readonly botToken: SecretFieldRead;
  readonly chatId: string | null;
  readonly enabled: boolean;
}

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  readonly message: string;
  readonly detail: Record<string, unknown> | null;
}

export interface TimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly kind: TimelineKind;
  readonly trigger: 'user' | 'system';
  readonly fromState?: SessionState;
  readonly toState?: SessionState;
  readonly refType?: 'commit' | 'message';
  readonly refId?: string;
  readonly detail?: string;
}

export type TimelineKind =
  | 'state_changed'
  | 'commit_linked'
  | 'prompt_submitted'
  | 'tool_used'
  | 'observation_changed'
  | 'other';

export interface WorkflowCostBudget {
  readonly dailyUsd: number | null;
  readonly spentTodayUsd: number;
  readonly remainingUsd: number | null;
}

export interface WorkflowCostEstimate {
  readonly workflowId: string;
  readonly stepCount: number;
  readonly defaultMaxSessions: number;
  readonly basis: 'observed_sessions';
  readonly steps: readonly WorkflowCostEstimateStep[];
  readonly projected: WorkflowCostProjection | null;
  readonly stepsWithoutHistory: number;
  readonly budget: WorkflowCostBudget;
}

export interface WorkflowCostEstimateStep {
  readonly ordinal: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly observed: WorkflowCostObserved | null;
}

export interface WorkflowCostObserved {
  readonly sessionCount: number;
  readonly meanUsd: number;
  readonly maxUsd: number;
}

export interface WorkflowCostProjection {
  readonly meanUsd: number;
  readonly maxUsd: number;
  readonly coveredSteps: number;
}

export type WorkflowMode = 'manual' | 'assisted';

export type WorkingTreeUnavailableReason =
  | 'path_missing'
  | 'not_a_directory'
  | 'not_a_git_repository'
  | 'git_unavailable'
  | 'timed_out'
  | 'git_failed';
