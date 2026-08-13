/**
 * The Session aggregate: `sessions`, `session_events`, `messages`, `transcript_tail_states`
 * (TDS 03 §3.9–§3.11, §3.15).
 *
 * The F7 vocabulary is imported from `src/entities/session-state.ts` — the single source of
 * truth for state names — so the CHECK constraints below cannot drift from the state machine
 * the API enforces (F9.5 vocabulary discipline).
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  MESSAGE_ROLES,
  SEMI_TERMINAL_SESSION_STATES,
  SESSION_STATES,
  type SessionType,
  TERMINAL_SESSION_STATE,
} from '../../entities/session-state.js';
import { agents } from './agents.js';
import { users } from './auth.js';
import { createdAt, primaryKeyId, timestamptz, tsvector, updatedAt, valueList } from './columns.js';
import { projects, repositories } from './projects.js';

/**
 * F4.1 — a Session is either driven by Mission Control or merely observed (F1.5).
 * `satisfies` anchors the CHECK to the shared union so the two cannot diverge silently.
 */
const SESSION_TYPES = ['managed', 'observed'] as const satisfies readonly SessionType[];

/** Claude Code CLI is the primary V1 runtime; Ollama is optional (F1.5). V2 runtimes via CHECK alter. */
const SESSION_RUNTIMES = ['claude_code', 'ollama'] as const;

/**
 * The three non-terminal F7 states, **derived** from the state machine rather than re-typed:
 * everything that is neither semi-terminal (`completed`, `failed`) nor terminal (`archived`).
 * Backs the Dashboard "Active Sessions" partial index (TDS 03 §3.9).
 */
const ACTIVE_SESSION_STATES = SESSION_STATES.filter(
  (state) => state !== TERMINAL_SESSION_STATE && !SEMI_TERMINAL_SESSION_STATES.includes(state),
);

/** How a Session descends from its parent (arbitration A6 / finding B7). */
const SESSION_LINEAGE_KINDS = ['resumed', 'cloned'] as const;

/** Who caused a timeline entry (F7 rules). */
const SESSION_EVENT_TRIGGERS = ['user', 'system'] as const;

/** Cold-pause delivery status for a Message (TDS 02 §5.1). */
const MESSAGE_STATUSES = ['complete', 'pending', 'interrupted'] as const;

/**
 * Cumulative token usage as reported by the SDK `ResultMessage` (spike §6). Serialized to
 * the API as `tokenUsage` — a projected subset, see the TDS 03 §3.9 mapping table.
 */
export interface SessionUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  usage_by_model?: Record<string, unknown>;
}

/**
 * The core entity (TDS 03 §3.9).
 *
 * Two identities (F1.5): `id` is our UUIDv7 PK; `runtime_session_id` is Claude Code's native
 * session ID (UUIDv4), NULL until spawn/attach. Resume-as-new produces a NEW row linked via
 * `resumed_from_session_id`; `paused -> running` is an in-place transition on the SAME row.
 *
 * Transition *legality* is enforced in the application layer (F7,
 * `apps/backend/src/sessions/state-machine.ts`); the DB constrains only the value set.
 *
 * `agent_id` arrived by additive migration in Phase 4, as this header promised it would.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** Nullable (finding B8): a Session may run outside any registered Repository. */
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** `ON DELETE RESTRICT`, not SET NULL — nulling only the FK would orphan `lineage_kind`. */
    resumedFromSessionId: uuid('resumed_from_session_id').references(
      (): AnyPgColumn => sessions.id,
      { onDelete: 'restrict' },
    ),
    /** NULL iff `resumed_from_session_id` is NULL — see `ck_sessions_lineage`. */
    lineageKind: text('lineage_kind'),
    /**
     * The Agent persona this Session runs as (PRD §5.1 `Runtime → Agent → Task`), or NULL for a
     * Session that is nobody in particular. Bound before launch and fixed from then on: the
     * agent's instructions become the runtime's system prompt at spawn, and a runtime has no way
     * to be handed a different one mid-conversation.
     *
     * `ON DELETE RESTRICT`, which is the archive-only rule for agents made structural — the row
     * that says "this conversation ran as the Architect" must not be able to become a dangling id
     * (`agents.ts`).
     */
    agentId: uuid('agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'restrict' }),
    sessionType: text('session_type').notNull(),
    state: text('state').notNull().default('created'),
    runtime: text('runtime').notNull().default('claude_code'),
    /** Runtime-native session ID (UUIDv4); NULL until spawn/attach. */
    runtimeSessionId: text('runtime_session_id'),
    /** e.g. Claude Code CLI/SDK version (PRD §4.1 "Claude Version"). */
    runtimeVersion: text('runtime_version'),
    model: text('model'),
    /** Hostname (PRD §4.1 "Machine"). */
    machine: text('machine'),
    /** e.g. 'windows-dev', 'ubuntu-prod' (PRD §4.1 "Environment"). */
    environment: text('environment'),
    branch: text('branch'),
    /** Absolute native path. */
    workingDir: text('working_dir'),
    /** Runtime JSONL path (observation fidelity channel, F1.5). */
    transcriptPath: text('transcript_path'),
    title: text('title'),
    /** Operator notes, PRD §8.3 Notes tab (finding B8). Search input, never a filter. */
    notes: text('notes'),
    /** Populated on `state = 'failed'`; vocabulary owned by WS1. */
    failureReason: text('failure_reason'),
    /** Money is `numeric`, never float (F4.2). Drizzle maps it to `string`. */
    totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }),
    usage: jsonb('usage').$type<SessionUsage>(),
    numTurns: integer('num_turns'),
    /** Runtime-reported active duration. Serialized as `durationSeconds` (WS7 N3). */
    durationMs: bigint('duration_ms', { mode: 'number' }),
    /** Diagnostic only — not exposed by the API. */
    durationApiMs: bigint('duration_api_ms', { mode: 'number' }),
    startedAt: timestamptz('started_at'),
    /** Set on `completed` OR `failed`. */
    completedAt: timestamptz('completed_at'),
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Stored generated column, maintained by PostgreSQL (TDS 03 §4.6). Never written. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') || setweight(to_tsvector('pg_catalog.english', coalesce(notes, '')), 'B')`,
    ),
  },
  (table) => [
    check(
      'ck_sessions_lineage_kind',
      sql`${table.lineageKind} IN (${valueList(SESSION_LINEAGE_KINDS)})`,
    ),
    check('ck_sessions_session_type', sql`${table.sessionType} IN (${valueList(SESSION_TYPES)})`),
    check('ck_sessions_state', sql`${table.state} IN (${valueList(SESSION_STATES)})`),
    check('ck_sessions_runtime', sql`${table.runtime} IN (${valueList(SESSION_RUNTIMES)})`),
    check('ck_sessions_total_cost_usd', sql`${table.totalCostUsd} >= 0`),
    check('ck_sessions_usage_object', sql`jsonb_typeof(${table.usage}) = 'object'`),
    check('ck_sessions_num_turns', sql`${table.numTurns} >= 0`),
    check('ck_sessions_duration_ms', sql`${table.durationMs} >= 0`),
    check('ck_sessions_duration_api_ms', sql`${table.durationApiMs} >= 0`),
    /** Lineage invariant (A6): a Session either has a parent AND a lineage kind, or neither. */
    check(
      'ck_sessions_lineage',
      sql`(${table.resumedFromSessionId} IS NULL) = (${table.lineageKind} IS NULL)`,
    ),
    /**
     * Primary list query: sessions by project, filtered by state, newest first (the UUIDv7 PK
     * is time-ordered, but `created_at` is the explicit, human-auditable sort key).
     */
    index('ix_sessions_project_state_created_at').on(
      table.projectId,
      table.state,
      sql`${table.createdAt} DESC`,
    ),
    index('ix_sessions_user_id').on(table.userId),
    /** `?repositoryId=` list filter (WS2 §6.2) + FK index. */
    index('ix_sessions_repository_id')
      .on(table.repositoryId)
      .where(sql`${table.repositoryId} IS NOT NULL`),
    index('ix_sessions_resumed_from').on(table.resumedFromSessionId),
    /** "Which Sessions ran as this Agent" + the FK index the RESTRICT check needs. */
    index('ix_sessions_agent_id').on(table.agentId).where(sql`${table.agentId} IS NOT NULL`),
    /** Dashboard "Active Sessions" widget: tiny hot subset. */
    index('ix_sessions_active')
      .on(sql`${table.createdAt} DESC`)
      .where(sql`${table.state} IN (${valueList(ACTIVE_SESSION_STATES)})`),
    /** One record per runtime-native session; idempotent observed-session detection. */
    uniqueIndex('ux_sessions_runtime_session_id')
      .on(table.runtime, table.runtimeSessionId)
      .where(sql`${table.runtimeSessionId} IS NOT NULL`),
    index('ix_sessions_search_tsv').using('gin', table.searchTsv),
    /**
     * NOTE: `ix_sessions_started_at` (TDS 03 §3.9 — the WS2 §7.8 spend aggregate) is NOT
     * declared here. It carries `INCLUDE (total_cost_usd)`, which Drizzle's index builder
     * cannot express, so it is created by the custom migration
     * `0001_custom_include_and_fillfactor.sql`. Do not add it here — that would create a
     * second, INCLUDE-less index with the same name.
     */
  ],
);

/**
 * Append-only session timeline (TDS 03 §3.10). Every F7 transition is recorded with
 * timestamp + trigger; also carries non-transition timeline entries. `type` uses F6 event
 * names verbatim.
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: primaryKeyId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** F6 event name, e.g. 'session.state_changed'. */
    type: text('type').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    trigger: text('trigger').notNull(),
    /** F6.2 envelope payload subset (IDs, reasons). */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** F6.2 correlationId. */
    correlationId: uuid('correlation_id'),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
    /** Convention only (F4.2); rows are append-only. */
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'ck_session_events_from_state',
      sql`${table.fromState} IN (${valueList(SESSION_STATES)})`,
    ),
    check('ck_session_events_to_state', sql`${table.toState} IN (${valueList(SESSION_STATES)})`),
    check(
      'ck_session_events_trigger',
      sql`${table.trigger} IN (${valueList(SESSION_EVENT_TRIGGERS)})`,
    ),
    index('ix_session_events_session_occurred').on(table.sessionId, table.occurredAt),
  ],
);

/**
 * Conversation turns and tool activity (TDS 03 §3.11).
 *
 * Ordering is an application-assigned, per-session monotonic `ordinal` — each Session has
 * exactly one writer at any moment. Gaps are permitted (failed turns); order is what matters.
 *
 * `(session_id, runtime_message_id)` is the **single** ingest idempotency key (WS7 N11);
 * every ingest write is `ON CONFLICT DO NOTHING` against `ux_messages_session_runtime_id`.
 */
export const messages = pgTable(
  'messages',
  {
    id: primaryKeyId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ordinal: bigint('ordinal', { mode: 'number' }).notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('complete'),
    /** Canonical rendered text — searchable, exportable. */
    content: text('content').notNull().default(''),
    /** Raw structured blocks (text/tool_use/tool_result) for faithful re-rendering. */
    contentBlocks: jsonb('content_blocks').$type<unknown[]>(),
    /** Assistant messages. */
    model: text('model'),
    /** Tool role. */
    toolName: text('tool_name'),
    /** Runtime tool-use correlation id. */
    toolUseId: text('tool_use_id'),
    toolPayload: jsonb('tool_payload'),
    /**
     * Absolute native path parsed from the tool input; NULL unless a file-naming tool
     * (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` — WS2 §6.10.2 owns the list).
     * An unrecognized tool or payload shape leaves it NULL and must never fail the ingest.
     */
    toolFilePath: text('tool_file_path'),
    /** Runtime message uuid, or a synthesized 'hook:…' key. Sole dedupe key. */
    runtimeMessageId: text('runtime_message_id'),
    /** Runtime-reported time when available. */
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Conversation turns only (TDS 03 §4.6): tool payloads dominate volume and pollute
     * ranking, so they are excluded from the vector itself (NULL), not merely from the
     * index. `left(…, 100000)` guards PostgreSQL's 1 MB tsvector ceiling.
     */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`CASE WHEN role IN ('user', 'assistant') THEN setweight(to_tsvector('pg_catalog.english', left(coalesce(content, ''), 100000)), 'B') ELSE NULL END`,
    ),
  },
  (table) => [
    check('ck_messages_ordinal', sql`${table.ordinal} >= 0`),
    check('ck_messages_role', sql`${table.role} IN (${valueList(MESSAGE_ROLES)})`),
    check('ck_messages_status', sql`${table.status} IN (${valueList(MESSAGE_STATUSES)})`),
    check('ck_messages_content_blocks_array', sql`jsonb_typeof(${table.contentBlocks}) = 'array'`),
    /** Conversation read path + cursor pagination (F5.3) + ordering contract, one index. */
    uniqueIndex('ux_messages_session_ordinal').on(table.sessionId, table.ordinal),
    /** Dual-channel ingest idempotency. */
    uniqueIndex('ux_messages_session_runtime_id')
      .on(table.sessionId, table.runtimeMessageId)
      .where(sql`${table.runtimeMessageId} IS NOT NULL`),
    /** Session Files panel (WS2 §6.10.2): group tool touches by path within one Session. */
    index('ix_messages_session_tool_file')
      .on(table.sessionId, table.toolFilePath)
      .where(sql`${table.toolFilePath} IS NOT NULL`),
    index('ix_messages_search_tsv')
      .using('gin', table.searchTsv)
      .where(sql`${table.searchTsv} IS NOT NULL`),
  ],
);

/**
 * Per-observed-session tail state so transcript tailing survives Backend restarts
 * (TDS 02 §6.3, TDS 03 §3.15). One row per Session; rows for managed sessions never exist.
 *
 * The row is updated on every tailer read burst, so the table carries `fillfactor = 90` to
 * encourage HOT updates. Drizzle cannot express table storage parameters — the setting is
 * applied by the custom migration `0001_custom_include_and_fillfactor.sql`.
 */
export const transcriptTailStates = pgTable(
  'transcript_tail_states',
  {
    id: primaryKeyId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Absolute native path to the runtime JSONL. */
    transcriptPath: text('transcript_path').notNull(),
    byteOffset: bigint('byte_offset', { mode: 'number' }).notNull().default(0),
    /** Lines fully parsed (diagnostics). */
    lineNo: bigint('line_no', { mode: 'number' }).notNull().default(0),
    /** Parse failures (TDS 02 §6.3). */
    driftCount: integer('drift_count').notNull().default(0),
    /** true = detached, hook-only observation. */
    degraded: boolean('degraded').notNull().default(false),
    lastReadAt: timestamptz('last_read_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_transcript_tail_states_byte_offset', sql`${table.byteOffset} >= 0`),
    check('ck_transcript_tail_states_line_no', sql`${table.lineNo} >= 0`),
    check('ck_transcript_tail_states_drift_count', sql`${table.driftCount} >= 0`),
    uniqueIndex('ux_transcript_tail_session').on(table.sessionId),
  ],
);
