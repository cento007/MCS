import { type EntityId, newId } from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { toolFilePathOf } from './content.js';
import { CostAccumulator, type SessionCostSnapshot, ZERO_COST } from './cost.js';
import type {
  MessageSink,
  RateLimitedTurn,
  SessionCostStore,
  SessionDeltaSink,
  SessionStatePort,
} from './ports.js';
import type {
  AgentSessionHandle,
  RuntimeContentBlock,
  RuntimeEvent,
  RuntimeMessageCompletedEvent,
  RuntimeResultEvent,
} from './runtime-events.js';

/**
 * `ManagedSessionController` — one per Session in `running` state (TDS 02 §4.1).
 *
 * It owns exactly one thing: **the pump**. A single async loop drains the runtime's event stream
 * and fans it out four ways (§4.2):
 *
 *   1. ephemeral deltas -> the WebSocket hub, never persisted (§14.5);
 *   2. finished messages -> `MessageService.append`, one `messages` row per message and per
 *      tool call, with the ordinal, dedupe and A13 title derivation the domain already owns;
 *   3. `result` -> cost and usage accumulated onto the Session (F1.5 canonical cost source);
 *   4. failures -> the state machine, and *only* through the state machine (TDS 02 §2).
 *
 * One loop rather than N handlers is deliberate: message persistence assigns a per-Session
 * `ordinal` under a row lock (TDS 03 §3.11 "each Session has exactly one writer at any moment"),
 * and the pump *is* that writer. Concurrency here would be a correctness bug, not a speedup.
 *
 * The controller never spawns anything. `AgentSessionHandle` does, behind
 * `claude-agent-runtime.ts`, which is the only module in the Backend that imports the SDK.
 */

/** How long `interrupt()` waits for the runtime to end the turn before flushing it itself. */
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
/** How long `dispose()` waits for an interrupted turn to settle before letting go anyway. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
/**
 * Rendered-text ceiling for a tool Message. A `Read` of a large file is legitimate and routine;
 * putting a megabyte of it in a searchable `content` column is not. `tool_payload` keeps the raw
 * truth (§6.10.2 storage note), so nothing is lost — only the rendered copy is bounded.
 */
export const MAX_TOOL_TEXT_CHARS = 32_000;

export interface ManagedSessionFacts {
  readonly runtimeSessionId: string;
  readonly claudeVersion: string | null;
  readonly model: string | null;
  readonly cwd: string | null;
}

export interface ManagedSessionControllerOptions {
  readonly sessionId: string;
  readonly handle: AgentSessionHandle;
  readonly messages: MessageSink;
  readonly stateMachine: SessionStatePort;
  readonly cost: SessionCostStore;
  readonly deltas?: SessionDeltaSink | undefined;
  /** Totals already on the Session row — a resumed query restarts its own at zero (`cost.ts`). */
  readonly baseline?: SessionCostSnapshot | undefined;
  readonly onError?: ((error: unknown, sessionId: string) => void) | undefined;
  /** Called when a turn ends rate-limited. The registry turns it into a delayed job (§4.3). */
  readonly onRateLimited?: ((turn: RateLimitedTurn) => void) | undefined;
  /** Called once the pump has stopped, whatever the cause. */
  readonly onClosed?: ((sessionId: string) => void) | undefined;
  readonly interruptTimeoutMs?: number | undefined;
  readonly disposeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class ManagedSessionController {
  readonly #sessionId: string;
  readonly #handle: AgentSessionHandle;
  readonly #messages: MessageSink;
  readonly #stateMachine: SessionStatePort;
  readonly #costStore: SessionCostStore;
  readonly #deltas: SessionDeltaSink | null;
  readonly #onError: ((error: unknown, sessionId: string) => void) | undefined;
  readonly #onRateLimited: ((turn: RateLimitedTurn) => void) | undefined;
  readonly #onClosed: ((sessionId: string) => void) | undefined;
  readonly #interruptTimeoutMs: number;
  readonly #disposeTimeoutMs: number;
  readonly #now: () => Date;
  readonly #accumulator: CostAccumulator;

  readonly #ready: Deferred<ManagedSessionFacts>;
  #readySettled = false;
  /** Settled *successfully* — i.e. the runtime confirmed a session id. */
  #confirmed = false;
  #facts: ManagedSessionFacts | null = null;

  /** The pump. Started in the constructor; awaited by `dispose()`. */
  readonly #pump: Promise<void>;

  #turnInFlight = false;
  #interrupting = false;
  #turnEnd: Deferred<string | null> | null = null;
  /** Pre-allocated id shared by a streaming assistant message's deltas and its durable row. */
  #streamingMessageId: EntityId | null = null;
  /** Text accumulated per content-block index, so an interrupt can retain what was streamed. */
  readonly #partial = new Map<number, string>();
  #interruptedMessageId: string | null = null;
  /** The prompt this turn is answering — what a rate-limit retry has to re-send (§4.3). */
  #currentPrompt: { content: string; messageId: string | null; attempt: number } | null = null;

  #disposing = false;
  #closed = false;

  constructor(options: ManagedSessionControllerOptions) {
    this.#sessionId = options.sessionId;
    this.#handle = options.handle;
    this.#messages = options.messages;
    this.#stateMachine = options.stateMachine;
    this.#costStore = options.cost;
    this.#deltas = options.deltas ?? null;
    this.#onError = options.onError;
    this.#onRateLimited = options.onRateLimited;
    this.#onClosed = options.onClosed;
    this.#interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.#disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#accumulator = new CostAccumulator(options.baseline ?? ZERO_COST);
    this.#ready = deferred<ManagedSessionFacts>();
    // The pump is started here and never restarted: one query, one stream, one reader.
    this.#pump = this.#run();
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get hasTurnInFlight(): boolean {
    return this.#turnInFlight;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Resolves when the runtime has confirmed the session (F7 "system confirms spawn"), rejects
   * when it failed to. The registry turns the rejection into `created -> failed` + 503.
   */
  ready(): Promise<ManagedSessionFacts> {
    return this.#ready.promise;
  }

  /**
   * Hand a prompt to the runtime (§6.4 — the Message is already persisted `pending` by the
   * caller, which is what makes a prompt survive a pause that beats it to the runtime).
   */
  async submit(prompt: {
    readonly content: string;
    readonly messageId: string | null;
    readonly attempt?: number;
  }): Promise<void> {
    if (this.#closed) {
      throw new ApiError('RUNTIME_UNAVAILABLE', 'The runtime session is no longer available', {
        sessionId: this.#sessionId,
      });
    }

    this.#currentPrompt = {
      content: prompt.content,
      messageId: prompt.messageId,
      attempt: prompt.attempt ?? 0,
    };
    this.#turnInFlight = true;
    this.#interruptedMessageId = null;
    this.#partial.clear();

    try {
      await this.#handle.send(prompt.content);
    } catch (error) {
      this.#turnInFlight = false;
      throw error;
    }
  }

  /**
   * §6.3.1 — stop the turn in flight, change **no** Session state, and return the retained
   * partial Message.
   *
   * The wait is what makes the response honest: the runtime normally answers an interrupt with
   * an `aborted` assistant message followed by a `result`, and persisting *that* is better than
   * persisting our reconstruction of it. If the runtime does not answer in time we flush the
   * accumulated deltas ourselves rather than return nothing — a partial turn that vanished is
   * the one outcome §6.3.1 forbids.
   */
  async interrupt(): Promise<{ messageId: string | null }> {
    if (!this.#turnInFlight) {
      throw new ApiError('NO_TURN_IN_FLIGHT', 'No assistant turn is currently streaming', {
        sessionId: this.#sessionId,
      });
    }

    this.#interrupting = true;
    const settled = this.#turnEnd ?? deferred<string | null>();
    this.#turnEnd = settled;

    try {
      await this.#handle.interrupt();
    } catch (error) {
      this.#onError?.(error, this.#sessionId);
    }

    const messageId = await withTimeout(settled.promise, this.#interruptTimeoutMs, null);
    if (messageId !== null) return { messageId };

    // Timed out, or the turn ended with nothing persisted: flush whatever streamed.
    const flushed = await this.#flushPartial();
    this.#turnInFlight = false;
    this.#interrupting = false;
    this.#turnEnd = null;
    return { messageId: flushed };
  }

  /**
   * Cold pause / end / shutdown (TDS 02 §5.1, in that order): interrupt the turn in flight,
   * close the inbox, let the child go. The concurrency slot is released by the registry when the
   * state change lands, which is why pausing a Session actually frees capacity.
   *
   * Safe to call twice, and never throws: a runtime that is already gone must not be able to
   * block an operator's pause.
   */
  async dispose(): Promise<void> {
    if (this.#disposing) {
      await this.#pump;
      return;
    }
    this.#disposing = true;

    if (this.#turnInFlight) {
      this.#interrupting = true;
      const settled = this.#turnEnd ?? deferred<string | null>();
      this.#turnEnd = settled;
      try {
        await this.#handle.interrupt();
      } catch (error) {
        this.#onError?.(error, this.#sessionId);
      }
      await withTimeout(settled.promise, this.#disposeTimeoutMs, null);
    }

    try {
      await this.#handle.close();
    } catch (error) {
      this.#onError?.(error, this.#sessionId);
    }

    await withTimeout(this.#pump, this.#disposeTimeoutMs, undefined);

    // §5.1: "partial assistant output already streamed is persisted as an interrupted message".
    // No-op when the runtime already answered the interrupt with its own aborted message.
    if (this.#partial.size > 0) await this.#flushPartial();

    this.#turnInFlight = false;
    this.#interrupting = false;
    this.#turnEnd = null;
  }

  // -------------------------------------------------------------------------- the pump

  async #run(): Promise<void> {
    try {
      for await (const event of this.#handle.events) {
        await this.#handleEvent(event);
      }
      await this.#onStreamEnd(null);
    } catch (error) {
      await this.#onStreamEnd(error);
    }
  }

  async #handleEvent(event: RuntimeEvent): Promise<void> {
    switch (event.type) {
      case 'session_started':
        this.#facts = {
          runtimeSessionId: event.runtimeSessionId,
          claudeVersion: event.claudeVersion,
          model: event.model,
          cwd: event.cwd,
        };
        this.#settleReady(this.#facts);
        return;

      case 'message_started':
        // A new assistant message begins: its deltas and its durable row share a fresh id, so a
        // client can stitch the stream to the committed Message without guessing.
        this.#streamingMessageId = newId();
        this.#partial.clear();
        return;

      case 'stream_delta':
        this.#relayDelta(event.blockIndex, event.deltaType, event.text, event.partialJson);
        return;

      case 'message_completed':
        await this.#persistMessage(event);
        return;

      case 'result':
        await this.#onResult(event);
        return;

      case 'rate_limit':
        // Advisory only: it ends no turn. `rejected` becomes actionable when the turn's result
        // says so, which is the moment WS1 §4.3's backoff has something to retry.
        if (event.status === 'rejected') {
          this.#onError?.(
            new Error(`runtime reported a rate limit (${event.rateLimitType ?? 'unknown'})`),
            this.#sessionId,
          );
        }
        return;

      case 'runtime_error':
        await this.#onRuntimeError(event.reason, event.message);
        return;

      /* c8 ignore next 2 — exhaustive over the union; a new member is a compile error above */
      default:
        return;
    }
  }

  #relayDelta(
    blockIndex: number,
    deltaType: 'text_delta' | 'input_json_delta' | 'thinking_delta',
    text: string | null,
    partialJson: string | null,
  ): void {
    const messageId = this.#streamingMessageId ?? newId();
    this.#streamingMessageId = messageId;

    if (text !== null) {
      // Kept so an interrupt can persist what the operator already watched arrive. Tool inputs
      // (`input_json_delta`) are deliberately not accumulated: half a JSON document is not a
      // tool call, and persisting one would put an unparseable payload in the transcript.
      this.#partial.set(blockIndex, (this.#partial.get(blockIndex) ?? '') + text);
    }

    this.#deltas?.publishSessionDelta({
      sessionId: this.#sessionId,
      messageId,
      blockIndex,
      deltaType,
      text,
      partialJson,
      streamEventType: 'content_block_delta',
      correlationId: this.#sessionId,
    });
  }

  async #persistMessage(event: RuntimeMessageCompletedEvent): Promise<void> {
    const occurredAt = parseTimestamp(event.occurredAt) ?? this.#now();

    if (event.role === 'assistant') {
      const status = event.aborted || this.#interrupting ? 'interrupted' : 'complete';
      const id = this.#streamingMessageId ?? newId();
      this.#streamingMessageId = null;
      this.#partial.clear();

      const appended = await this.#append({
        id,
        role: 'assistant',
        content: event.text,
        contentBlocks: [...event.blocks],
        status,
        model: event.model,
        runtimeMessageId: event.uuid,
        occurredAt,
      });

      if (status === 'interrupted' && appended !== null) this.#interruptedMessageId = appended;

      for (const block of event.blocks) {
        if (block.type === 'tool_use') await this.#appendToolUse(block, event.uuid, occurredAt);
      }
      return;
    }

    // Role `user` on the OUTPUT stream is the runtime echoing tool results, not the operator —
    // the operator's prompt was persisted by the prompt path before it was ever transmitted
    // (§6.4). Only the tool results are new information here.
    for (const block of event.blocks) {
      if (block.type === 'tool_result') await this.#appendToolResult(block, event.uuid, occurredAt);
    }
  }

  async #appendToolUse(
    block: Extract<RuntimeContentBlock, { type: 'tool_use' }>,
    messageUuid: string | null,
    occurredAt: Date,
  ): Promise<void> {
    await this.#append({
      role: 'tool',
      content: '',
      contentBlocks: [block],
      status: 'complete',
      toolName: block.toolName,
      toolUseId: block.toolUseId,
      toolPayload: { input: block.input ?? null },
      // §6.10.2: written once by the ingester, at the moment it already parses the tool input.
      toolFilePath: toolFilePathOf(block.toolName, block.input),
      runtimeMessageId: messageUuid === null ? null : `${messageUuid}:tool_use:${block.toolUseId}`,
      occurredAt,
    });
  }

  async #appendToolResult(
    block: Extract<RuntimeContentBlock, { type: 'tool_result' }>,
    messageUuid: string | null,
    occurredAt: Date,
  ): Promise<void> {
    await this.#append({
      role: 'tool',
      content: block.output.slice(0, MAX_TOOL_TEXT_CHARS),
      contentBlocks: [block],
      status: 'complete',
      toolUseId: block.toolUseId,
      toolPayload: { output: block.output, isError: block.isError },
      runtimeMessageId:
        messageUuid === null ? null : `${messageUuid}:tool_result:${block.toolUseId}`,
      occurredAt,
    });
  }

  /**
   * One `messages` row. Persistence failures are reported and swallowed on purpose: a Session
   * whose transcript lost one row is degraded, and a pump that died mid-turn because of it would
   * take the whole live session — and every later row — with it.
   */
  async #append(input: {
    readonly id?: EntityId;
    readonly role: 'assistant' | 'tool';
    readonly content: string;
    readonly contentBlocks: unknown[];
    readonly status: 'complete' | 'interrupted';
    readonly model?: string | null;
    readonly toolName?: string | null;
    readonly toolUseId?: string | null;
    readonly toolPayload?: Record<string, unknown> | null;
    readonly toolFilePath?: string | null;
    readonly runtimeMessageId: string | null;
    readonly occurredAt: Date;
  }): Promise<string | null> {
    try {
      const result = await this.#messages.append({
        ...(input.id === undefined ? {} : { id: input.id }),
        sessionId: this.#sessionId,
        role: input.role,
        content: input.content,
        contentBlocks: input.contentBlocks,
        status: input.status,
        model: input.model ?? null,
        toolName: input.toolName ?? null,
        toolUseId: input.toolUseId ?? null,
        toolPayload: input.toolPayload ?? null,
        toolFilePath: input.toolFilePath ?? null,
        runtimeMessageId: input.runtimeMessageId,
        occurredAt: input.occurredAt,
        trigger: 'system',
        correlationId: this.#sessionId,
      });
      return result.message?.id ?? null;
    } catch (error) {
      this.#onError?.(error, this.#sessionId);
      return null;
    }
  }

  /** The terminal message of a turn (§4.2 step 4). */
  async #onResult(result: RuntimeResultEvent): Promise<void> {
    try {
      await this.#costStore.write(this.#sessionId, this.#accumulator.apply(result));
    } catch (error) {
      this.#onError?.(error, this.#sessionId);
    }

    const interrupted = this.#interrupting;
    const prompt = this.#currentPrompt;

    this.#turnInFlight = false;
    this.#currentPrompt = null;

    if (interrupted) {
      // Nothing persisted for this turn yet (no `aborted` assistant message): flush the deltas.
      const messageId = this.#interruptedMessageId ?? (await this.#flushPartial());
      this.#interrupting = false;
      this.#turnEnd?.resolve(messageId);
      this.#turnEnd = null;
      return;
    }

    this.#turnEnd?.resolve(this.#interruptedMessageId);
    this.#turnEnd = null;
    this.#streamingMessageId = null;
    this.#partial.clear();

    if (result.rateLimited) {
      // WS1 §4.3: the turn failed, the session did not. No transition, no `session.state_changed`
      // — the prompt is re-enqueued as a delayed job and the Session stays `running`.
      this.#onRateLimited?.({
        sessionId: this.#sessionId,
        content: prompt?.content ?? null,
        messageId: prompt?.messageId ?? null,
        attempt: (prompt?.attempt ?? 0) + 1,
        reason: result.stopReason ?? result.subtype,
      });
      return;
    }

    if (result.isError) {
      // A failed *turn* on a healthy process: reported, not escalated. The Session is still
      // `running` and the operator can prompt again. Only the stream dying fails a Session.
      this.#onError?.(
        new Error(`turn ended with ${result.subtype}: ${result.errors.join('; ')}`),
        this.#sessionId,
      );
    }
  }

  /** Persist what streamed before an interrupt, when the runtime did not do it for us. */
  async #flushPartial(): Promise<string | null> {
    const text = [...this.#partial.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join('');
    this.#partial.clear();

    if (text.length === 0) return this.#interruptedMessageId;

    const id = this.#streamingMessageId ?? newId();
    this.#streamingMessageId = null;

    const messageId = await this.#append({
      id,
      role: 'assistant',
      content: text,
      contentBlocks: [{ type: 'text', text }],
      status: 'interrupted',
      // No runtime uuid: this row is Mission Control's reconstruction, not a runtime message,
      // so it is exempt from the ingest dedupe index by construction (TDS 03 §3.11).
      runtimeMessageId: null,
      occurredAt: this.#now(),
    });

    this.#interruptedMessageId = messageId;
    return messageId;
  }

  /**
   * The stream stopped. Two very different meanings:
   *   - we asked for it (pause/end/shutdown) — nothing to record, the caller owns the transition;
   *   - it stopped on its own — the child died. That is F7's `running -> failed`, and it is the
   *     one place this class writes state, through the state machine like everyone else.
   */
  async #onStreamEnd(error: unknown): Promise<void> {
    this.#closed = true;
    this.#turnInFlight = false;
    this.#turnEnd?.resolve(this.#interruptedMessageId);
    this.#turnEnd = null;

    if (!this.#confirmed) {
      // It never confirmed a session id, so this is a spawn failure and **not** a crash: the
      // Session is still `created` (or `paused`), and `created -> failed` belongs to the launch
      // path, which is the only caller that knows which state it is transitioning from (§6.3).
      this.#rejectReady(
        error instanceof Error
          ? error
          : new Error('the runtime stream ended before the session was confirmed'),
      );
      this.#onClosed?.(this.#sessionId);
      return;
    }

    if (!this.#disposing) {
      if (error !== undefined && error !== null) this.#onError?.(error, this.#sessionId);
      // Both an iterator throw and an unrequested clean end record `process_crash`: in
      // streaming-input mode the child only exits when *we* close the inbox, so an end we did
      // not ask for means the process is gone either way. Keeping one reason keeps
      // TDS 03 §3.9's failure vocabulary closed instead of inventing a sixth value.
      await this.#fail('process_crash');
    }

    this.#onClosed?.(this.#sessionId);
  }

  async #onRuntimeError(
    reason: 'spawn_failed' | 'crashed' | 'rate_limited',
    message: string,
  ): Promise<void> {
    if (reason === 'rate_limited') {
      // Classified on the assistant message; the turn's `result` carries the actionable form.
      this.#onError?.(new Error(message), this.#sessionId);
      return;
    }

    if (!this.#confirmed) {
      this.#rejectReady(new Error(message));
      return;
    }

    this.#onError?.(new Error(message), this.#sessionId);
    await this.#fail('process_crash');
  }

  /** `running -> failed` (system). TDS 03 §3.9's failure-reason vocabulary. */
  async #fail(reason: string): Promise<void> {
    try {
      await this.#stateMachine.transition({
        sessionId: this.#sessionId,
        to: 'failed',
        trigger: 'system',
        action: 'system',
        reason,
      });
    } catch (transitionError) {
      // Already terminal (a concurrent `end`, or restart recovery got there first). Nothing to
      // repair — F7 rejected an edge that no longer applies.
      this.#onError?.(transitionError, this.#sessionId);
    }
  }

  #settleReady(facts: ManagedSessionFacts): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#confirmed = true;
    this.#ready.resolve(facts);
  }

  #rejectReady(error: Error): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#ready.reject(error);
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  // The rejection is always consumed by `ready()`, but a controller nobody awaited must not be
  // able to take the process down with an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        // Never the reason a process stays alive (F8.1).
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
