import type {
  RuntimeContentBlock,
  RuntimeEvent,
} from '../../src/sessions/managed/runtime-events.js';
import type { ScriptStep } from './mock-agent-runtime.js';

/**
 * The baseline script library of TDS 07 §5.2 — one named script per row of that table.
 *
 * Written as typed builders rather than JSON fixtures on purpose: these are *behavioural*
 * scripts in Mission Control's own `RuntimeEvent` vocabulary, so a change to that vocabulary
 * must break them at compile time. The fixtures that pin the **runtime's** wire format are a
 * different artifact and live in `test/fixtures/claude/` (§5.3), where being data is the point.
 */

const RUNTIME_SESSION_ID = '5f6c0b98-2a5b-4a1e-8c1a-7c9e8a1b2c3d';

export function started(
  overrides: Partial<Extract<RuntimeEvent, { type: 'session_started' }>> = {},
): RuntimeEvent {
  return {
    type: 'session_started',
    runtimeSessionId: RUNTIME_SESSION_ID,
    model: 'claude-sonnet-4-5',
    claudeVersion: '2.1.228',
    cwd: null,
    permissionMode: 'acceptEdits',
    tools: ['Read', 'Write', 'Bash'],
    ...overrides,
  };
}

export function textDelta(text: string, blockIndex = 0): RuntimeEvent {
  return { type: 'stream_delta', blockIndex, deltaType: 'text_delta', text, partialJson: null };
}

export function jsonDelta(partialJson: string, blockIndex = 1): RuntimeEvent {
  return {
    type: 'stream_delta',
    blockIndex,
    deltaType: 'input_json_delta',
    text: null,
    partialJson,
  };
}

export function messageStarted(providerMessageId = 'msg_01'): RuntimeEvent {
  return { type: 'message_started', providerMessageId, model: 'claude-sonnet-4-5' };
}

export function assistantMessage(input: {
  readonly uuid?: string | null;
  readonly text?: string;
  readonly blocks?: readonly RuntimeContentBlock[];
  readonly aborted?: boolean;
}): RuntimeEvent {
  const blocks = input.blocks ?? [{ type: 'text' as const, text: input.text ?? '' }];
  return {
    type: 'message_completed',
    role: 'assistant',
    uuid: input.uuid ?? 'uuid-assistant-1',
    model: 'claude-sonnet-4-5',
    blocks,
    text: input.text ?? '',
    aborted: input.aborted ?? false,
    stopReason: input.aborted === true ? null : 'end_turn',
    occurredAt: null,
    parentToolUseId: null,
  };
}

export function toolResultMessage(input: {
  readonly uuid?: string | null;
  readonly toolUseId: string;
  readonly output: string;
  readonly isError?: boolean;
}): RuntimeEvent {
  return {
    type: 'message_completed',
    role: 'user',
    uuid: input.uuid ?? 'uuid-tool-result-1',
    model: null,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: input.toolUseId,
        output: input.output,
        isError: input.isError ?? false,
      },
    ],
    text: '',
    aborted: false,
    stopReason: null,
    occurredAt: null,
    parentToolUseId: null,
  };
}

export function result(
  overrides: Partial<Extract<RuntimeEvent, { type: 'result' }>> = {},
): RuntimeEvent {
  return {
    type: 'result',
    subtype: 'success',
    isError: false,
    stopReason: 'end_turn',
    totalCostUsd: 0.0125,
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
    },
    modelUsage: { 'claude-sonnet-4-5': { inputTokens: 1200, outputTokens: 300 } },
    numTurns: 1,
    durationMs: 4200,
    durationApiMs: 3800,
    rateLimited: false,
    errors: [],
    ...overrides,
  };
}

// --------------------------------------------------------------------------- the library

/** init -> partial deltas -> completed message -> result with cost + usage. */
export const happySingleTurn: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  { emit: textDelta('Refactoring the ') },
  { emit: textDelta('queue consumer') },
  { emit: assistantMessage({ text: 'Refactoring the queue consumer' }) },
  { emit: result() },
];

/** As above, then waits for a second prompt — the live-chat bidirectional loop. */
export const happyMultiTurn: readonly ScriptStep[] = [
  ...happySingleTurn,
  { waitForPrompt: true },
  { emit: messageStarted('msg_02') },
  { emit: textDelta('Done. Anything else?') },
  { emit: assistantMessage({ uuid: 'uuid-assistant-2', text: 'Done. Anything else?' }) },
  // Cumulative within one query() call — see `cost.ts`: totals are read, never summed.
  { emit: result({ totalCostUsd: 0.031, numTurns: 2 }) },
];

/** Interleaved tool activity: a `tool_use` block, its streamed input, and its result. */
export const toolUseTurn: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  { emit: textDelta('Reading the file.') },
  { emit: jsonDelta('{"file_path":') },
  { emit: jsonDelta('"/repo/src/queue.ts"}') },
  {
    emit: assistantMessage({
      text: 'Reading the file.',
      blocks: [
        { type: 'text', text: 'Reading the file.' },
        {
          type: 'tool_use',
          toolUseId: 'toolu_01',
          toolName: 'Read',
          input: { file_path: '/repo/src/queue.ts' },
        },
      ],
    }),
  },
  { emit: toolResultMessage({ toolUseId: 'toolu_01', output: 'export const queue = 1;' }) },
  { emit: assistantMessage({ uuid: 'uuid-assistant-2', text: 'It exports one binding.' }) },
  { emit: result({ numTurns: 2 }) },
];

/** Immediate `runtime_error(spawn_failed)` before any output. */
export const spawnFailure: readonly ScriptStep[] = [
  {
    emit: {
      type: 'runtime_error',
      reason: 'spawn_failed',
      message: 'claude executable not found on PATH',
    },
  },
  { end: true },
];

/** Deltas, then the async iterable throws. */
export const midStreamCrash: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  { emit: textDelta('Starting the refa') },
  { throw: new Error('claude child exited with code 1') },
];

/** A turn that ends on a rate-limit stop reason. The Session must stay `running`. */
export const rateLimitStop: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  {
    emit: {
      type: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_800_000_000,
      rateLimitType: 'five_hour',
    },
  },
  {
    emit: result({
      subtype: 'error_max_budget_usd',
      isError: true,
      stopReason: 'rate_limit',
      rateLimited: true,
      totalCostUsd: 0.004,
      errors: ['rate limit reached; retry after the window resets'],
    }),
  },
];

/** Long inter-delta latency. Short in absolute terms; the point is that it is non-zero. */
export const slowStream: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  { emit: textDelta('thinking'), delayMs: 25 },
  { emit: textDelta(' harder'), delayMs: 25 },
  { emit: assistantMessage({ text: 'thinking harder' }), delayMs: 25 },
  { emit: result() },
];

/** A turn interrupted mid-stream: the runtime answers with an aborted message, then a result. */
export const interruptedTurn: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  { emit: textDelta('Starting the ') },
  { emit: textDelta('refactor') },
  // Parks here; `interrupt()` releases it, which is exactly the real ordering.
  { waitForPrompt: true },
  { emit: assistantMessage({ text: 'Starting the refactor', aborted: true }) },
  { emit: result({ subtype: 'error_during_execution', isError: true, stopReason: null }) },
];

/** A turn the runtime never finishes answering — `interrupt()` must flush the partial itself. */
export const unresponsiveInterrupt: readonly ScriptStep[] = [
  { emit: started() },
  { waitForPrompt: true },
  { emit: messageStarted() },
  { emit: textDelta('Half a thought') },
  { waitForPrompt: true },
  { waitForPrompt: true },
];

export const SCRIPTS = {
  'happy-single-turn': happySingleTurn,
  'happy-multi-turn': happyMultiTurn,
  'tool-use-turn': toolUseTurn,
  'spawn-failure': spawnFailure,
  'mid-stream-crash': midStreamCrash,
  'rate-limit-stop': rateLimitStop,
  'slow-stream': slowStream,
  'interrupted-turn': interruptedTurn,
  'unresponsive-interrupt': unresponsiveInterrupt,
} as const;
