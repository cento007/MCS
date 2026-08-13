import type { MessageRole, SessionState, SessionType } from '@mc/shared';
import type {
  MessageRow,
  SessionEventRow,
  SessionRow,
  TranscriptTailStateRow,
} from './repository.js';

/**
 * DB row -> API resource. TDS 04 §6.1/§6.6/§6.7 shapes, using the TDS 03 §3.9 mapping table
 * as the authority for every column that is not a straight `snake_case` -> `camelCase` rename.
 *
 * The `Commit` resource (§5.2) is **not** one of them: `commits/serialize.ts` owns it, and
 * §6.10.1's Session-scoped list is explicitly "the `Commit` resource of §5.2" — one resource,
 * one serializer, whichever route serves it. Re-exported here so this module stays the single
 * import site for everything the Session routes put on the wire.
 */

export {
  type CommitDetailResource,
  type CommitFileResource,
  type CommitResource,
  serializeCommit,
  serializeCommitDetail,
} from '../commits/serialize.js';

export interface SessionObservation {
  readonly channel: 'hooks_and_transcript' | 'hooks_only' | 'transcript_only';
  readonly degraded: boolean;
  readonly reason: string | null;
  readonly driftCount: number;
  readonly updatedAt: string;
}

export interface SessionResource {
  readonly id: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly sessionType: SessionType;
  readonly state: SessionState;
  readonly title: string;
  /**
   * Why a `failed` Session failed — `spawn_error`, `process_crash`, `backend_restart`, … —
   * mirroring `sessions.failure_reason` (TDS 03 §3.9) and the `session.failed` payload.
   *
   * `null` in every other state. Exposed because the failure code is the whole triage signal
   * and the UI is specified to render it: WS5 §5.2's Needs Attention row and §5.5's failure
   * banner both show it, and until now the column was written and never served, so both
   * surfaces could only say "Session failed" without saying why.
   */
  readonly failureReason: string | null;
  readonly notes: string | null;
  readonly branch: string | null;
  readonly workingDirectory: string;
  /**
   * The Agent persona this Session runs as (PRD §5.1), or `null`.
   *
   * The id only. The Agent resource is served by `GET /api/v1/agents/{id}`, and inlining a
   * persona's instructions into every Session payload would put a 20 000-character system prompt
   * on the session list.
   */
  readonly agentId: string | null;
  readonly runtime: {
    readonly kind: string;
    readonly runtimeSessionId: string | null;
    readonly claudeVersion: string | null;
    readonly model: string | null;
    readonly machine: string | null;
    readonly environment: string | null;
  };
  readonly observation: SessionObservation | null;
  readonly costUsd: number | null;
  readonly tokenUsage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  } | null;
  readonly durationSeconds: number | null;
  readonly resumedFromSessionId: string | null;
  readonly clonedFromSessionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface MessageContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface MessageResource {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly role: MessageRole;
  readonly status: 'complete' | 'pending' | 'interrupted';
  readonly content: readonly MessageContentBlock[];
  readonly model: string | null;
  readonly tokenUsage: { readonly input: number; readonly output: number } | null;
  readonly runtimeUuid: string | null;
  readonly occurredAt: string;
  readonly createdAt: string;
}

/** Presentation projection of the F6 event name — total and fixed (TDS 04 §6.7 / WS7 N4). */
export type TimelineKind =
  | 'state_changed'
  | 'commit_linked'
  | 'prompt_submitted'
  | 'tool_used'
  | 'observation_changed'
  | 'other';

export interface TimelineEntryResource {
  readonly id: string;
  readonly occurredAt: string;
  /** The F6 event name, verbatim — the source of truth; `kind` is derived from it. */
  readonly type: string;
  readonly kind: TimelineKind;
  readonly trigger: 'user' | 'system';
  readonly fromState?: SessionState;
  readonly toState?: SessionState;
  readonly refType?: 'commit' | 'message';
  readonly refId?: string;
  readonly detail?: string;
}

export function serializeSession(
  row: SessionRow,
  observation: SessionObservation | null,
): SessionResource {
  return {
    id: row.id,
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    sessionType: row.sessionType as SessionType,
    state: row.state as SessionState,
    // §6.1: `title` is always present and always a string; the unset value is `''`, which maps
    // to `sessions.title IS NULL` in storage.
    title: row.title ?? '',
    failureReason: row.failureReason,
    notes: row.notes,
    branch: row.branch,
    workingDirectory: row.workingDir ?? '',
    agentId: row.agentId,
    runtime: {
      kind: row.runtime,
      runtimeSessionId: row.runtimeSessionId,
      claudeVersion: row.runtimeVersion,
      model: row.model,
      machine: row.machine,
      environment: row.environment,
    },
    observation,
    costUsd: row.totalCostUsd === null ? null : Number(row.totalCostUsd),
    tokenUsage: serializeTokenUsage(row),
    // TDS 03 §3.9 (WS7 N3): storage stays milliseconds because that is the runtime's own unit;
    // the rounding happens on read, where it is lossless-enough, not on write.
    durationSeconds: row.durationMs === null ? null : Math.round(row.durationMs / 1000),
    // A6: one FK plus a discriminator populates two distinct API fields.
    resumedFromSessionId: row.lineageKind === 'resumed' ? row.resumedFromSessionId : null,
    clonedFromSessionId: row.lineageKind === 'cloned' ? row.resumedFromSessionId : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTokenUsage(row: SessionRow): SessionResource['tokenUsage'] {
  const usage = row.usage;
  if (usage === null || usage === undefined) return null;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * `Session.observation` (§6.9), mapped field-by-field from `transcript_tail_states` so the
 * degraded-fidelity badge renders on cold load rather than only for a client that happened to
 * be connected when the event fired. `null` for managed Sessions.
 *
 * `channel` is derived: both attached = `hooks_and_transcript`; tailer detached or never
 * attached = `hooks_only`. The third value, `transcript_only`, means "hooks profile not
 * installed for this session" and needs the hooks installer's state, which arrives with the
 * observed-session ingest work — until then no Session can honestly claim it.
 */
export function serializeObservation(
  row: SessionRow,
  tailState: TranscriptTailStateRow | null,
): SessionObservation | null {
  if (row.sessionType !== 'observed') return null;

  if (tailState === null) {
    return {
      channel: 'hooks_only',
      degraded: false,
      reason: null,
      driftCount: 0,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    channel: tailState.degraded ? 'hooks_only' : 'hooks_and_transcript',
    degraded: tailState.degraded,
    reason: tailState.lastError,
    driftCount: tailState.driftCount,
    updatedAt: tailState.updatedAt.toISOString(),
  };
}

export function serializeMessage(row: MessageRow): MessageResource {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ordinal: Number(row.ordinal),
    role: row.role as MessageRole,
    status: row.status as MessageResource['status'],
    content: normalizeContentBlocks(row),
    model: row.model,
    tokenUsage: null,
    runtimeUuid: row.runtimeMessageId,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `content_blocks` holds the raw structured blocks for faithful re-rendering; `content` holds
 * the canonical rendered text (TDS 03 §3.11). A Message written without blocks — every Message
 * Mission Control originates itself — is projected as a single `text` block so the API's
 * `content[]` contract holds for every row.
 */
function normalizeContentBlocks(row: MessageRow): MessageContentBlock[] {
  const blocks = row.contentBlocks;
  if (Array.isArray(blocks) && blocks.length > 0) {
    return blocks.filter(isContentBlock);
  }
  return row.content.length === 0 ? [] : [{ type: 'text', text: row.content }];
}

function isContentBlock(value: unknown): value is MessageContentBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** §6.7's total projection from F6 event name to timeline `kind`. */
export function timelineKindOf(row: SessionEventRow): TimelineKind {
  switch (row.type) {
    case 'session.state_changed':
      return 'state_changed';
    case 'commit.recorded':
      return 'commit_linked';
    case 'session.observation_degraded':
      return 'observation_changed';
    case 'session.message.appended': {
      const role = readString(row.payload, 'role');
      if (role === 'user') return 'prompt_submitted';
      if (role === 'tool') return 'tool_used';
      return 'other';
    }
    default:
      return 'other';
  }
}

export function serializeTimelineEntry(row: SessionEventRow): TimelineEntryResource {
  const refType = readString(row.payload, 'refType');
  const refId =
    readString(row.payload, 'messageId') ??
    readString(row.payload, 'commitId') ??
    readString(row.payload, 'refId');
  const detail = readString(row.payload, 'reason') ?? readString(row.payload, 'detail');

  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    type: row.type,
    kind: timelineKindOf(row),
    trigger: row.trigger as 'user' | 'system',
    ...(row.fromState === null ? {} : { fromState: row.fromState as SessionState }),
    ...(row.toState === null ? {} : { toState: row.toState as SessionState }),
    ...(refId === undefined ? {} : { refId }),
    ...(refType === 'commit' || refType === 'message'
      ? { refType }
      : row.type === 'session.message.appended'
        ? { refType: 'message' as const }
        : row.type === 'commit.recorded'
          ? { refType: 'commit' as const }
          : {}),
    ...(detail === undefined ? {} : { detail }),
  };
}

function readString(payload: Record<string, unknown> | null, key: string): string | undefined {
  if (payload === null) return undefined;
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}
