import { isRecord, renderText, toContentBlocks } from './content.js';
import type { RuntimeEvent, RuntimeUsage } from './runtime-events.js';

/**
 * The SDK-message normalizer — the single place that knows what `@anthropic-ai/claude-agent-sdk`
 * puts on the wire (F1.5 "version-tolerant parser isolated in an adapter module"; WS6 §5.3 pins
 * it with a fixture corpus).
 *
 * It takes `unknown` rather than an SDK type on purpose. The SDK's declared union has 37 members
 * at 0.3.228 and its own `.d.ts` reaches into `@anthropic-ai/sdk` beta types that are only a peer
 * dependency; typing this function against those would make an SDK bump a compile error in a
 * dozen files instead of a contract-test failure in one. Structural parsing plus a fixture corpus
 * gives the stronger guarantee: **an unrecognized shape is dropped loudly in a contract test, not
 * silently in production.**
 *
 * One SDK message can produce zero, one, or several `RuntimeEvent`s; the array is the return
 * type for exactly that reason.
 *
 * SDK message types consumed (0.3.228 / Claude Code 2.1.228):
 *   `system`/`init`, `stream_event`, `assistant`, `user`, `result`, `rate_limit_event`.
 * Everything else — `status`, `hook_*`, `task_*`, `compact_boundary`, … — is deliberately
 * dropped: Mission Control persists messages, streams deltas, records cost and reacts to
 * failures, and a message serving none of those is one we could not test the handling of.
 */

/** Stop reasons and result subtypes that mean "the plan/budget ran out", not "the child died". */
const RATE_LIMIT_STOP_REASONS = ['rate_limit', 'rate_limited', 'max_budget', 'budget_exceeded'];
const RATE_LIMIT_RESULT_SUBTYPES = ['error_max_budget_usd'];

export function normalizeSdkMessage(message: unknown): RuntimeEvent[] {
  if (!isRecord(message)) return [];

  switch (message['type']) {
    case 'system':
      return normalizeSystem(message);
    case 'stream_event':
      return normalizeStreamEvent(message);
    case 'assistant':
      return normalizeAssistant(message);
    case 'user':
      return normalizeUser(message);
    case 'result':
      return normalizeResult(message);
    case 'rate_limit_event':
      return normalizeRateLimit(message);
    default:
      return [];
  }
}

/**
 * `system`/`init` is F7's "system confirms spawn": it is the first message of every session and
 * carries the runtime-native session id the Session row stores (F1.5). Other `system` subtypes
 * (`status`, `permission_denied`, `session_state_changed`, …) are not lifecycle facts for us.
 */
function normalizeSystem(message: Record<string, unknown>): RuntimeEvent[] {
  if (message['subtype'] !== 'init') return [];

  const runtimeSessionId = message['session_id'];
  if (typeof runtimeSessionId !== 'string' || runtimeSessionId.length === 0) return [];

  return [
    {
      type: 'session_started',
      runtimeSessionId,
      model: stringOrNull(message['model']),
      // `claude_code_version` on the SDK's init message; `sessions.runtime_version` in ours.
      claudeVersion: stringOrNull(message['claude_code_version']),
      cwd: stringOrNull(message['cwd']),
      permissionMode: stringOrNull(message['permissionMode']),
      tools: stringArray(message['tools']),
    },
  ];
}

/**
 * `stream_event` wraps an Anthropic API stream event verbatim (spike §2). Two of the six matter:
 * `message_start` (rotates the pre-allocated Message id) and `content_block_delta` (the only
 * event relayed to browsers, §14.5). `content_block_start/stop`, `message_delta` and
 * `message_stop` add nothing the completed `assistant` message does not already carry.
 */
function normalizeStreamEvent(message: Record<string, unknown>): RuntimeEvent[] {
  const event = message['event'];
  if (!isRecord(event)) return [];

  if (event['type'] === 'message_start') {
    const inner = isRecord(event['message']) ? event['message'] : {};
    return [
      {
        type: 'message_started',
        providerMessageId: stringOrNull(inner['id']),
        model: stringOrNull(inner['model']),
      },
    ];
  }

  if (event['type'] !== 'content_block_delta') return [];

  const delta = event['delta'];
  if (!isRecord(delta)) return [];
  const blockIndex = typeof event['index'] === 'number' ? event['index'] : 0;

  switch (delta['type']) {
    case 'text_delta': {
      const text = delta['text'];
      if (typeof text !== 'string') return [];
      return [
        { type: 'stream_delta', blockIndex, deltaType: 'text_delta', text, partialJson: null },
      ];
    }
    case 'thinking_delta': {
      // The API field is `thinking`; §14.5's payload field is `text`, with `deltaType`
      // carrying the distinction.
      const text = delta['thinking'];
      if (typeof text !== 'string') return [];
      return [
        { type: 'stream_delta', blockIndex, deltaType: 'thinking_delta', text, partialJson: null },
      ];
    }
    case 'input_json_delta': {
      const partialJson = delta['partial_json'];
      if (typeof partialJson !== 'string') return [];
      return [
        {
          type: 'stream_delta',
          blockIndex,
          deltaType: 'input_json_delta',
          text: null,
          partialJson,
        },
      ];
    }
    // `signature_delta` and anything newer: nothing renderable, nothing to persist.
    default:
      return [];
  }
}

function normalizeAssistant(message: Record<string, unknown>): RuntimeEvent[] {
  const inner = isRecord(message['message']) ? message['message'] : {};
  const blocks = toContentBlocks(inner['content']);
  const events: RuntimeEvent[] = [
    {
      type: 'message_completed',
      role: 'assistant',
      uuid: stringOrNull(message['uuid']),
      model: stringOrNull(inner['model']),
      blocks,
      text: renderText(blocks),
      // `aborted: true` is the SDK's own marker for a turn cut short by an interrupt — §6.3.1's
      // "partial assistant Message … persisted with status = 'interrupted'".
      aborted: message['aborted'] === true,
      stopReason: stringOrNull(inner['stop_reason']),
      occurredAt: stringOrNull(message['timestamp']),
      parentToolUseId: stringOrNull(message['parent_tool_use_id']),
    },
  ];

  // A per-message error classification the result may never repeat: `rate_limit` here means the
  // turn is over for capacity reasons and WS1 §4.3's backoff applies (the Session stays running).
  const error = message['error'];
  if (typeof error === 'string' && error.length > 0) {
    events.push({
      type: 'runtime_error',
      reason: error === 'rate_limit' || error === 'overloaded' ? 'rate_limited' : 'crashed',
      message: `assistant turn failed: ${error}`,
    });
  }

  return events;
}

/**
 * `user` messages on the *output* stream are the runtime echoing tool results (and replays), not
 * the operator. They are what makes a tool call renderable end to end, so they persist.
 */
function normalizeUser(message: Record<string, unknown>): RuntimeEvent[] {
  const inner = isRecord(message['message']) ? message['message'] : {};
  const blocks = toContentBlocks(inner['content']);
  if (blocks.length === 0) return [];

  return [
    {
      type: 'message_completed',
      role: 'user',
      uuid: stringOrNull(message['uuid']),
      model: null,
      blocks,
      text: renderText(blocks),
      aborted: false,
      stopReason: null,
      occurredAt: stringOrNull(message['timestamp']),
      parentToolUseId: stringOrNull(message['parent_tool_use_id']),
    },
  ];
}

function normalizeResult(message: Record<string, unknown>): RuntimeEvent[] {
  const subtype = typeof message['subtype'] === 'string' ? message['subtype'] : 'unknown';
  const stopReason = stringOrNull(message['stop_reason']);
  const errors = stringArray(message['errors']);

  return [
    {
      type: 'result',
      subtype,
      isError: message['is_error'] === true,
      stopReason,
      totalCostUsd: numberOr(message['total_cost_usd'], 0),
      usage: toUsage(message['usage']),
      modelUsage: isRecord(message['modelUsage']) ? message['modelUsage'] : {},
      numTurns: numberOr(message['num_turns'], 0),
      durationMs: numberOr(message['duration_ms'], 0),
      durationApiMs: numberOr(message['duration_api_ms'], 0),
      rateLimited: isRateLimited(subtype, stopReason, errors),
      errors,
    },
  ];
}

function normalizeRateLimit(message: Record<string, unknown>): RuntimeEvent[] {
  const info = isRecord(message['rate_limit_info']) ? message['rate_limit_info'] : {};
  const status = info['status'];
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return [];

  return [
    {
      type: 'rate_limit',
      status,
      resetsAt: typeof info['resetsAt'] === 'number' ? info['resetsAt'] : null,
      rateLimitType: stringOrNull(info['rateLimitType']),
    },
  ];
}

/**
 * "Did this turn end because of capacity rather than a fault?" — the question WS1 §4.3 turns
 * into "back off, and do **not** transition the Session".
 */
export function isRateLimited(
  subtype: string,
  stopReason: string | null,
  errors: readonly string[],
): boolean {
  if (RATE_LIMIT_RESULT_SUBTYPES.includes(subtype)) return true;
  if (stopReason !== null && RATE_LIMIT_STOP_REASONS.includes(stopReason)) return true;
  return errors.some((error) => /rate.?limit|usage limit|quota/i.test(error));
}

function toUsage(value: unknown): RuntimeUsage {
  if (!isRecord(value)) return {};
  return {
    ...pickNumber(value, 'input_tokens'),
    ...pickNumber(value, 'output_tokens'),
    ...pickNumber(value, 'cache_creation_input_tokens'),
    ...pickNumber(value, 'cache_read_input_tokens'),
  };
}

function pickNumber(source: Record<string, unknown>, key: string): Record<string, number> {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
