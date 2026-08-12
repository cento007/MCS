import type {
  EntityId,
  IsoTimestamp,
  MessageRole,
  SessionState,
  SessionType,
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
  readonly notes: string | null;
  readonly branch: string | null;
  readonly workingDirectory: string;
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
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

// --------------------------------------------------------------- service health (§7.5)

export interface ServiceHealthRow {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'down' | 'not_configured' | 'unknown';
  readonly detail: string | null;
  readonly checkedAt: IsoTimestamp;
}
