import type { Options as ClaudeQueryOptions } from '@anthropic-ai/claude-agent-sdk';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { normalizeSdkMessage } from './normalize.js';
import type {
  AgentRuntimePort,
  AgentSessionHandle,
  AgentSessionOptions,
  RuntimeEvent,
} from './runtime-events.js';

/**
 * **The only module in the Backend that imports `@anthropic-ai/claude-agent-sdk`** (WS6 §5.1,
 * F1.5). Everything else speaks `RuntimeEvent`.
 *
 * It opens one `query()` per Session in **streaming-input mode**: the `prompt` argument is an
 * async iterable this class feeds, which keeps the SDK session — and its `claude` child process
 * — alive across turns (TDS 02 §4.1). The alternative, one `query()` per prompt, would pay
 * resume latency on every message and lose the in-memory context the runtime already holds.
 *
 * ### Where the installed SDK (0.3.228, Claude Code 2.1.228) differs from the R1 spike
 *
 * - The spike wrote `include_partial_messages` (the CLI flag's snake_case). The TypeScript
 *   option is **`includePartialMessages`**; partial messages arrive as `type: 'stream_event'`
 *   wrapping an Anthropic API stream event, exactly as the spike described the CLI's.
 * - `interrupt()` and every other control request are documented as **streaming-input only**,
 *   which is a second, independent reason this class never uses single-prompt mode: §6.3.1's
 *   `[Stop]` control would be unimplementable.
 * - `Query` also exposes `close()` — a forceful teardown of the child, pending requests and MCP
 *   transports — which is what a cold pause wants (TDS 02 §5.1) and what the spike, written
 *   from the docs, did not mention.
 * - `ResultMessage.total_cost_usd` exists as the spike said, but the installed types add the
 *   part that matters: it is a **running total across turns of one `query()` call**, and
 *   "resumed sessions start fresh". `cost.ts` is built on that; summing results, which the
 *   spike's wording invites, would over-report by a factor of the turn count.
 * - `permissionMode: 'bypassPermissions'` additionally requires
 *   `allowDangerouslySkipPermissions: true` in this version — the spike listed the mode without
 *   that gate.
 */

export interface ClaudeAgentRuntimeOptions {
  /** `integrations.claudeCode.cliPath`. Omitted lets the SDK find its own bundled binary. */
  readonly cliPath?: string | null | undefined;
  /** `integrations.claudeCode.defaultModel`, used when the Session names no model. */
  readonly defaultModel?: string | null | undefined;
  /**
   * The **process-wide** permission default (F1.5: "Phase 1 uses static defaults").
   *
   * Phase 4's per-Agent gating is a *different* surface and deliberately so: it arrives per
   * Session as `disallowedTools` (`agents/permissions.ts`) and only ever subtracts. This mode
   * stays what it was, because raising it for an agent would auto-approve more than a Session
   * without one gets — a permission model that grants is not a permission model.
   *
   * `acceptEdits` is the default because Phase 1 has **no permission-prompt surface**: there is
   * no `canUseTool` handler and no UI to answer one, and the SDK is explicit that without a
   * prompt surface an `ask` decision is terminal. Under `default` mode every gated tool call
   * would therefore be denied silently and a managed session could not edit the file it was
   * launched to edit. `bypassPermissions` is deliberately not the default: it also needs
   * `allowDangerouslySkipPermissions`, and a console that can run any command unattended is not
   * something to opt an operator into by omission.
   */
  readonly permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | undefined;
  /**
   * Which on-disk Claude Code settings layers to load. The default matches the CLI, so an
   * operator's `CLAUDE.md`, project settings and skills apply to a managed session exactly as
   * they would in their own terminal.
   */
  readonly settingSources?: readonly ('user' | 'project' | 'local')[] | undefined;
  readonly onStderr?: ((data: string, sessionId: string) => void) | undefined;
}

export function createClaudeAgentRuntime(
  options: ClaudeAgentRuntimeOptions = {},
): AgentRuntimePort {
  return {
    start(session: AgentSessionOptions): AgentSessionHandle {
      return new ClaudeAgentSession(session, options);
    },
  };
}

/**
 * Every SDK option that depends on the Session rather than on the process — exported so the
 * mapping can be asserted without spawning a `claude` child.
 *
 * That matters most for the Agent binding (PRD §5): "the agent's instructions reach the runtime"
 * is a claim about *this object*, and the only honest way to check it offline is to build the
 * object and look. `prompt`, `abortController` and `stderr` stay with the instance below; they
 * are wiring, not policy.
 *
 * ## What an Agent changes here, and what it does not
 *
 * - **`systemPrompt`.** With no agent the option is absent entirely, which leaves the SDK on its
 *   own default — the behaviour every Session had before Phase 4. With an agent it becomes
 *   `{ type: 'preset', preset: 'claude_code', append }`: Claude Code's own prompt *plus* the
 *   persona. A bare string would replace the runtime's prompt wholesale and take its tool
 *   conventions with it, which is not what "a persona operating through a runtime" means.
 * - **`disallowedTools`.** Set only when non-empty, so an unrestricted Session's options are
 *   byte-identical to what they were before this existed.
 * - **`permissionMode` is untouched.** Agent permissions are subtractive
 *   (`agents/permissions.ts`); raising the permission mode for an agent would *widen* what the
 *   runtime auto-approves, which is the opposite of a permission model.
 */
export function buildSessionQueryOptions(
  session: AgentSessionOptions,
  options: ClaudeAgentRuntimeOptions = {},
): Omit<ClaudeQueryOptions, 'abortController' | 'stderr'> {
  const model = session.model ?? options.defaultModel ?? null;

  return {
    cwd: session.workingDirectory,
    includePartialMessages: true,
    permissionMode: options.permissionMode ?? 'acceptEdits',
    settingSources: [...(options.settingSources ?? ['user', 'project', 'local'])],
    ...(model === null ? {} : { model }),
    ...(session.resume === null ? {} : { resume: session.resume }),
    // F1.5: Clone is a fork of the resumed conversation, not a continuation of it.
    ...(session.fork ? { forkSession: true } : {}),
    ...(session.systemPromptAppend === null
      ? {}
      : {
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: session.systemPromptAppend,
          },
        }),
    ...(session.disallowedTools.length === 0
      ? {}
      : { disallowedTools: [...session.disallowedTools] }),
    // No `mcpServers` is passed anywhere in this Backend, so `strictMcpConfig: true` means "no
    // MCP tools at all" — which is the point: a deny list over built-in tool names cannot speak
    // about `mcp__something__write_file`.
    ...(session.strictMcpConfig ? { strictMcpConfig: true } : {}),
    ...(options.cliPath === null || options.cliPath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.cliPath }),
  };
}

/** What the SDK accepts on a streaming-input prompt iterable. */
type InboxMessage = SDKUserMessage;

class ClaudeAgentSession implements AgentSessionHandle {
  readonly #inbox = new PromptInbox();
  readonly #abort = new AbortController();
  readonly #sessionId: string;
  readonly #query: ReturnType<typeof query>;
  #closed = false;

  constructor(session: AgentSessionOptions, options: ClaudeAgentRuntimeOptions) {
    this.#sessionId = session.sessionId;

    session.signal?.addEventListener('abort', () => this.#abort.abort(), { once: true });

    this.#query = query({
      // Streaming input: the child lives across turns (TDS 02 §4.1).
      prompt: this.#inbox.stream(),
      options: {
        ...buildSessionQueryOptions(session, options),
        abortController: this.#abort,
        stderr: (data: string) => {
          options.onStderr?.(data, session.sessionId);
        },
      },
    });
  }

  get events(): AsyncIterable<RuntimeEvent> {
    return this.#stream();
  }

  async send(prompt: string): Promise<void> {
    if (this.#closed) throw new Error('The runtime session is closed');
    this.#inbox.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: this.#sessionId,
    } as InboxMessage);
  }

  async interrupt(): Promise<void> {
    // Control request; streaming-input only, which is what this class always is.
    await this.#query.interrupt();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inbox.close();
    try {
      // Forceful teardown: child process, pending requests, MCP transports.
      this.#query.close();
    } finally {
      this.#abort.abort();
    }
  }

  async *#stream(): AsyncGenerator<RuntimeEvent> {
    for await (const message of this.#query) {
      for (const event of normalizeSdkMessage(message)) yield event;
    }
  }
}

/**
 * The prompt inbox (TDS 02 §4.1): an async iterable the SDK pulls from and `send()` pushes to.
 *
 * Closing it is how a cold pause ends the conversation cleanly — the SDK sees the iterable
 * finish and shuts the child down — which is why `close()` resolves the pending `next()` rather
 * than rejecting it.
 */
class PromptInbox {
  readonly #pending: InboxMessage[] = [];
  readonly #waiters: ((result: IteratorResult<InboxMessage>) => void)[] = [];
  #closed = false;

  push(message: InboxMessage): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: message, done: false });
      return;
    }
    this.#pending.push(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  stream(): AsyncIterable<InboxMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<InboxMessage> {
        return {
          async next(): Promise<IteratorResult<InboxMessage>> {
            const queued = self.#pending.shift();
            if (queued !== undefined) return { value: queued, done: false };
            if (self.#closed) return { value: undefined, done: true };
            return new Promise<IteratorResult<InboxMessage>>((resolve) => {
              self.#waiters.push(resolve);
            });
          },
          async return(): Promise<IteratorResult<InboxMessage>> {
            self.close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
