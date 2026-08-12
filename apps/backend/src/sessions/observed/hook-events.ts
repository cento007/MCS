import { createHash } from 'node:crypto';
import type { MessageRole } from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { isUsableTranscriptPath } from './paths.js';
import { toolFilePathFrom } from './tool-files.js';

/**
 * The hook wire format (TDS 04 §6.8) and everything derived from it — all pure, all total.
 *
 * Two shapes arrive at `POST /api/v1/hook-events` and both are accepted:
 *
 *   1. **The documented envelope** — `{ hookEventName, runtimeSessionId, transcriptPath, cwd,
 *      occurredAt?, payload }` (§6.8). This is the contract, and what any Mission Control
 *      tooling sends.
 *   2. **A raw Claude Code hook body** — `{ hook_event_name, session_id, transcript_path, cwd,
 *      tool_name, tool_input, … }`. An HTTP hook posts the runtime's *own* JSON; it has no
 *      opportunity to reshape it into (1). Rejecting it would make the profile our installer
 *      writes unusable against the very runtime it targets, so the raw form is normalized into
 *      the documented envelope with the un-extracted remainder kept verbatim as `payload`.
 *      (Recorded as a contract finding rather than a silent deviation.)
 *
 * Everything past normalization speaks the §6.8 vocabulary and nothing else.
 */

/** §6.8's `hookEventName` union, verbatim. */
export const HOOK_EVENT_NAMES = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const);

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === 'string' && (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

/** The normalized event every downstream consumer sees. */
export interface HookEvent {
  readonly hookEventName: HookEventName;
  /** Claude Code's native session UUID (F1.5). */
  readonly runtimeSessionId: string;
  /** Absolute native path to the session JSONL, or `null` when the payload omitted a usable one. */
  readonly transcriptPath: string | null;
  readonly cwd: string | null;
  readonly occurredAt: Date | null;
  /** Hook-specific body, stored raw — never rejected for shape (F1.5 version-drift rule). */
  readonly payload: Record<string, unknown>;
}

const MAX_RUNTIME_SESSION_ID = 128;
const MAX_CWD_LENGTH = 4096;
const MAX_PROMPT_LENGTH = 256 * 1024;

/**
 * Validate and normalize a request body into a `HookEvent`.
 *
 * Throws `VALIDATION_FAILED` (400) only for the four fields the contract requires us to
 * understand — the event name and the runtime session id. Everything else degrades to `null`
 * or rides along in `payload`, because a hook that 400s is a hook the operator sees fail in
 * their own terminal.
 */
export function normalizeHookRequestBody(body: unknown): HookEvent {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('VALIDATION_FAILED', 'Hook event body must be a JSON object');
  }

  const raw = body as Record<string, unknown>;

  const hookEventName = raw['hookEventName'] ?? raw['hook_event_name'];
  if (!isHookEventName(hookEventName)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `hookEventName must be one of: ${HOOK_EVENT_NAMES.join(', ')}`,
      { field: 'hookEventName' },
    );
  }

  const runtimeSessionId = firstString(raw['runtimeSessionId'], raw['session_id']);
  if (runtimeSessionId === null || runtimeSessionId.length > MAX_RUNTIME_SESSION_ID) {
    throw new ApiError('VALIDATION_FAILED', 'runtimeSessionId must be a non-empty string', {
      field: 'runtimeSessionId',
    });
  }

  const transcriptCandidate = raw['transcriptPath'] ?? raw['transcript_path'];
  const cwd = firstString(raw['cwd'], raw['project_dir'], raw['workingDirectory']);
  const occurredAt = parseTimestamp(raw['occurredAt'] ?? raw['timestamp']);

  return {
    hookEventName,
    runtimeSessionId,
    transcriptPath: isUsableTranscriptPath(transcriptCandidate) ? transcriptCandidate : null,
    cwd: cwd !== null && cwd.length <= MAX_CWD_LENGTH ? cwd : null,
    occurredAt,
    payload: extractPayload(raw),
  };
}

/**
 * The hook-specific body.
 *
 * The documented envelope carries it under `payload`; a raw Claude Code body *is* the payload
 * once the envelope fields are removed. Either way the result is stored raw — this function
 * never inspects, reshapes or validates what it keeps.
 */
function extractPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const declared = raw['payload'];
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    return declared as Record<string, unknown>;
  }

  const envelopeKeys = new Set([
    'hookEventName',
    'hook_event_name',
    'runtimeSessionId',
    'session_id',
    'transcriptPath',
    'transcript_path',
    'occurredAt',
    'payload',
  ]);

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!envelopeKeys.has(key)) rest[key] = value;
  }
  return rest;
}

function firstString(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ------------------------------------------------------------------ the dedupe key (§3.11)

/**
 * `(session_id, runtime_message_id)` is the **single** ingest idempotency key (WS7 N11), and
 * hooks have to state their half of it. Two sources, in order:
 *
 *   1. the runtime's own event uuid when the payload echoes one — which is what makes a hook
 *      row and the transcript line for the same event converge on one row;
 *   2. otherwise a deterministic synthetic id, TDS 03 §3.11 verbatim:
 *      `hook:{hookEventName}:{sha256(canonical_json(payload) || occurredAt ?? '')}`.
 *
 * (2) is a pure function of the request body, so a retried POST produces the identical key and
 * collapses. Nothing depends on the optional `occurredAt` being present — which is precisely
 * why §6.8's `(runtimeSessionId, hookEventName, occurredAt)` triple was rejected as the
 * storage key.
 */
export function runtimeMessageIdFor(event: HookEvent): string {
  const echoed = event.payload['uuid'] ?? event.payload['message_uuid'];
  if (typeof echoed === 'string' && echoed.length > 0 && echoed.length <= 128) return echoed;

  const digest = createHash('sha256')
    .update(canonicalJson(event.payload), 'utf8')
    .update(event.occurredAt === null ? '' : event.occurredAt.toISOString(), 'utf8')
    .digest('hex');

  return `hook:${event.hookEventName}:${digest}`;
}

/**
 * Deterministic JSON: object keys sorted, arrays in order, `undefined` and functions dropped.
 *
 * Two byte-identical payloads must hash identically regardless of key order on the wire, or a
 * retry would land as a second Message.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined || typeof entry === 'function') continue;
    result[key] = canonicalize(entry);
  }
  return result;
}

// ---------------------------------------------------------- hook payload -> Message (§6.8)

/** What a hook event contributes to the conversation, if anything. */
export interface HookMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly toolPayload: Record<string, unknown> | null;
  readonly toolFilePath: string | null;
}

/**
 * The Message a hook event produces, or `null` when it produces none.
 *
 * `SessionStart`, `Stop` and `SessionEnd` are lifecycle facts, not content — TDS 03 §3.11:
 * *"Hook events that do not produce a Message need no key"*. `UserPromptSubmit` produces the
 * user turn that A13 derives the Session title from; `PostToolUse` produces the tool row that
 * feeds the §6.10.2 Files panel.
 */
export function hookMessageFor(event: HookEvent): HookMessage | null {
  switch (event.hookEventName) {
    case 'UserPromptSubmit': {
      const prompt = firstString(event.payload['prompt'], event.payload['user_prompt']);
      if (prompt === null || prompt.trim().length === 0) return null;
      return {
        role: 'user',
        content: prompt.slice(0, MAX_PROMPT_LENGTH),
        toolName: null,
        toolUseId: null,
        toolPayload: null,
        toolFilePath: null,
      };
    }
    case 'PostToolUse': {
      const toolName = firstString(event.payload['tool_name'], event.payload['toolName']);
      const toolInput = event.payload['tool_input'] ?? event.payload['toolInput'] ?? null;
      const toolResponse = event.payload['tool_response'] ?? event.payload['tool_result'] ?? null;

      return {
        role: 'tool',
        content: '',
        toolName,
        toolUseId: firstString(event.payload['tool_use_id'], event.payload['toolUseId']),
        // Raw truth, unreshaped (TDS 03 §3.11): `tool_payload` is what we keep when our
        // understanding of the tool schema turns out to be a version behind.
        toolPayload: { input: toolInput, response: toolResponse },
        toolFilePath: toolFilePathFrom(toolName, toolInput),
      };
    }
    default:
      return null;
  }
}
