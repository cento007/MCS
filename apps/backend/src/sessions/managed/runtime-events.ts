/**
 * `RuntimeEvent` — **our** normalized vocabulary for what a Claude Code runtime says, and the
 * `AgentRuntimePort` that produces it (WS6 §5.1, TDS 02 §4.2).
 *
 * The rule this file exists to keep: **no module outside `claude-agent-runtime.ts` may import
 * `@anthropic-ai/claude-agent-sdk`.** Everything downstream — the controller, the persistence
 * mapping, the WebSocket relay, every test — speaks these types instead. That is what makes the
 * mock runtime (WS6 §5.2) a wholesale substitute rather than a partial one, and it is what keeps
 * an SDK format change confined to one adapter plus its contract tests (§5.3).
 *
 * The union is deliberately smaller than the SDK's (37 message types at 0.3.228 and growing).
 * Mission Control persists messages, streams deltas, records cost, and reacts to failures; a
 * message type that serves none of those four is dropped by the normalizer, on purpose, because
 * an event we cannot act on is an event we cannot test.
 */

/** F7-adjacent failure classification (WS6 §5.1). Drives which state transition, if any. */
export type RuntimeErrorReason = 'spawn_failed' | 'crashed' | 'rate_limited';

/**
 * The §6.6 `Message.content` block vocabulary, verbatim. This is the *storage and API* shape,
 * not the runtime's — the normalizer maps the SDK's blocks onto it so `contentBlocks` never
 * carries a dialect the API contract does not define.
 */
export type RuntimeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly toolUseId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly output: string;
      readonly isError: boolean;
    };

/** Token counters as the SDK reports them (`ResultMessage.usage`), field names unchanged. */
export interface RuntimeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface RuntimeStartedEvent {
  readonly type: 'session_started';
  /** Claude Code's native session id (UUIDv4, F1.5) — F7's "system confirms spawn". */
  readonly runtimeSessionId: string;
  readonly model: string | null;
  readonly claudeVersion: string | null;
  readonly cwd: string | null;
  readonly permissionMode: string | null;
  readonly tools: readonly string[];
}

/**
 * One assistant message has begun streaming. Not relayed to clients — the controller uses it to
 * rotate the pre-allocated Message id that its deltas and its eventual durable row share.
 */
export interface RuntimeMessageStartedEvent {
  readonly type: 'message_started';
  /** The provider's message id (`msg_…`) when the stream carries one. */
  readonly providerMessageId: string | null;
  readonly model: string | null;
}

/** A `content_block_delta`. The only stream event that reaches a browser (§14.5). */
export interface RuntimeDeltaEvent {
  readonly type: 'stream_delta';
  readonly blockIndex: number;
  readonly deltaType: 'text_delta' | 'input_json_delta' | 'thinking_delta';
  readonly text: string | null;
  readonly partialJson: string | null;
}

/** A finished message, ready to become one or more `messages` rows (TDS 02 §4.2 step 3). */
export interface RuntimeMessageCompletedEvent {
  readonly type: 'message_completed';
  readonly role: 'assistant' | 'user';
  /** Runtime message uuid — the `(session_id, runtime_message_id)` dedupe key (TDS 03 §3.11). */
  readonly uuid: string | null;
  readonly model: string | null;
  readonly blocks: readonly RuntimeContentBlock[];
  /** Concatenated `text` blocks — the canonical rendered text and the A13 derivation input. */
  readonly text: string;
  /** The SDK's `aborted: true`: the turn was cut short by an interrupt (§6.3.1). */
  readonly aborted: boolean;
  readonly stopReason: string | null;
  /** Runtime-reported ISO timestamp when present; the controller falls back to receive time. */
  readonly occurredAt: string | null;
  /** Set on messages produced inside a subagent — persisted for fidelity, never for ordering. */
  readonly parentToolUseId: string | null;
}

/** The terminal message of a turn: cost, usage, and how the turn ended (F1.5 canonical cost). */
export interface RuntimeResultEvent {
  readonly type: 'result';
  readonly subtype: string;
  readonly isError: boolean;
  readonly stopReason: string | null;
  /** Cumulative for this `query()` call — see `cost.ts` for why that matters. */
  readonly totalCostUsd: number;
  readonly usage: RuntimeUsage;
  readonly modelUsage: Readonly<Record<string, unknown>>;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly durationApiMs: number;
  /** True when the turn ended on a rate-limit/budget stop reason (WS1 §4.3). */
  readonly rateLimited: boolean;
  readonly errors: readonly string[];
}

/** An out-of-band rate-limit notice. Advisory: it ends no turn on its own. */
export interface RuntimeRateLimitEvent {
  readonly type: 'rate_limit';
  readonly status: 'allowed' | 'allowed_warning' | 'rejected';
  readonly resetsAt: number | null;
  readonly rateLimitType: string | null;
}

export interface RuntimeErrorEvent {
  readonly type: 'runtime_error';
  readonly reason: RuntimeErrorReason;
  readonly message: string;
}

export type RuntimeEvent =
  | RuntimeStartedEvent
  | RuntimeMessageStartedEvent
  | RuntimeDeltaEvent
  | RuntimeMessageCompletedEvent
  | RuntimeResultEvent
  | RuntimeRateLimitEvent
  | RuntimeErrorEvent;

export interface AgentSessionOptions {
  /** Our UUIDv7 Session id — for log correlation only; the runtime issues its own (F1.5). */
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly model: string | null;
  /** SDK `resume:` — set for in-place resume, resume-as-new, and Clone (F1.5). */
  readonly resume: string | null;
  /** SDK `forkSession: true` — this Session is a Clone of the resume target. */
  readonly fork: boolean;
  /**
   * The Agent persona (PRD §5), appended to the runtime's own system prompt. `null` for a
   * Session bound to no Agent, which is every Session before Phase 4.
   */
  readonly systemPromptAppend: string | null;
  /**
   * Tools this Session must not have — PRD §5.5 as the runtime enforces it
   * (`agents/permissions.ts`). Empty for an unrestricted Session.
   */
  readonly disallowedTools: readonly string[];
  /**
   * Ignore on-disk MCP configuration. Set for a restricted Session so a locally-configured MCP
   * server cannot supply a differently-named tool that does a denied thing.
   */
  readonly strictMcpConfig: boolean;
  readonly signal?: AbortSignal | undefined;
}

/**
 * One live runtime session. Mirrors WS6 §5.1's `startSession`/`sendPrompt`/`interrupt`/`end`
 * with the streaming-input inbox hidden behind `send` (TDS 02 §4.1).
 */
export interface AgentSessionHandle {
  /** Iterated exactly once, by the controller's single pump task. */
  readonly events: AsyncIterable<RuntimeEvent>;
  /** Push a prompt into the inbox. Resolves once the runtime has taken it. */
  send(prompt: string): Promise<void>;
  /** Stop the turn in flight. No Session state changes (§6.3.1). */
  interrupt(): Promise<void>;
  /** Close the inbox and dispose the child. Must be safe to call twice. */
  close(): Promise<void>;
}

export interface AgentRuntimePort {
  /**
   * Open a runtime session. Returns synchronously; spawn success or failure is reported on the
   * stream as `session_started` or `runtime_error(spawn_failed)`, so both paths are scriptable.
   */
  start(options: AgentSessionOptions): AgentSessionHandle;
}
