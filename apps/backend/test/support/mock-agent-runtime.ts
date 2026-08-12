import type {
  AgentRuntimePort,
  AgentSessionHandle,
  AgentSessionOptions,
  RuntimeEvent,
} from '../../src/sessions/managed/runtime-events.js';

/**
 * `MockAgentRuntime` — the scripted `AgentRuntimePort` of TDS 07 §5.2.
 *
 * It replays **scripts**: ordered lists of `RuntimeEvent`s, with a few control markers that make
 * a conversation (rather than a recording) expressible:
 *
 *   - `{ waitForPrompt: true }` — park until the controller sends the next prompt. This is what
 *     turns `happy-single-turn` into `happy-multi-turn` without duplicating a single event.
 *   - `{ delayMs }` — inter-event latency (`slow-stream`), real but tiny in tests.
 *   - `{ throw: Error }` — the async iterable throws (`mid-stream-crash`), which is the only
 *     way to reproduce "the child died mid-turn" from the consumer's side.
 *
 * It is selected by dependency injection at app construction (§5.2: "never by `NODE_ENV`
 * sniffing inside production code paths"), and it records every launch, prompt, interrupt and
 * close so the port-level assertions (`resume`, `forkSession`, "recovery never respawns") are
 * about observed calls rather than about internal state.
 */

export type ScriptStep =
  | { readonly emit: RuntimeEvent; readonly delayMs?: number }
  /** Park until the next `send()`. The prompt is recorded before the script continues. */
  | { readonly waitForPrompt: true }
  /** The stream throws — an abnormal termination, not a clean end. */
  | { readonly throw: Error }
  /** The stream ends cleanly without anyone asking (an unrequested child exit). */
  | { readonly end: true };

export interface MockAgentSession extends AgentSessionHandle {
  readonly options: AgentSessionOptions;
  readonly prompts: readonly string[];
  readonly interrupts: number;
  readonly closes: number;
}

export interface MockAgentRuntime extends AgentRuntimePort {
  /** Sessions started, in order. */
  readonly sessions: readonly MockAgentSession[];
  readonly launches: readonly AgentSessionOptions[];
  /** Use this script for the next `start()`. Later starts reuse the last script set. */
  script(steps: readonly ScriptStep[]): void;
  /** The most recently started session, or `null`. */
  last(): MockAgentSession | null;
}

export function createMockAgentRuntime(initial: readonly ScriptStep[] = []): MockAgentRuntime {
  const sessions: MockAgentSession[] = [];
  const launches: AgentSessionOptions[] = [];
  let steps: readonly ScriptStep[] = initial;

  return {
    sessions,
    launches,
    script(next: readonly ScriptStep[]): void {
      steps = next;
    },
    last(): MockAgentSession | null {
      return sessions.at(-1) ?? null;
    },
    start(options: AgentSessionOptions): AgentSessionHandle {
      launches.push(options);
      const session = new ScriptedSession(options, steps);
      sessions.push(session);
      return session;
    },
  };
}

class ScriptedSession implements MockAgentSession {
  readonly options: AgentSessionOptions;
  readonly prompts: string[] = [];
  interrupts = 0;
  closes = 0;

  readonly #steps: readonly ScriptStep[];
  readonly #promptWaiters: (() => void)[] = [];
  /**
   * Prompts that arrived before the script reached its `waitForPrompt`. Buffering them removes
   * the only real race in this mock: the pump resolves `ready()` and the caller can send a
   * prompt in the same microtask turn the generator uses to reach its park point.
   */
  #pendingPrompts = 0;
  #closed = false;
  #interruptSignal: (() => void) | null = null;

  constructor(options: AgentSessionOptions, steps: readonly ScriptStep[]) {
    this.options = options;
    this.#steps = steps;
  }

  get events(): AsyncIterable<RuntimeEvent> {
    return this.#play();
  }

  async send(prompt: string): Promise<void> {
    if (this.#closed) throw new Error('The mock runtime session is closed');
    this.prompts.push(prompt);
    const waiter = this.#promptWaiters.shift();
    if (waiter === undefined) {
      this.#pendingPrompts += 1;
      return;
    }
    waiter();
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    // Releases a script parked on `waitForPrompt`, so an interrupt during a turn that is waiting
    // for the operator's next prompt does not deadlock the stream.
    this.#interruptSignal?.();
  }

  async close(): Promise<void> {
    this.closes += 1;
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#promptWaiters.splice(0)) waiter();
    this.#interruptSignal?.();
  }

  async *#play(): AsyncGenerator<RuntimeEvent> {
    for (const step of this.#steps) {
      if (this.#closed) return;

      if ('waitForPrompt' in step) {
        await this.#awaitPrompt();
        continue;
      }
      if ('throw' in step) throw step.throw;
      if ('end' in step) return;

      if (step.delayMs !== undefined && step.delayMs > 0) await sleep(step.delayMs);
      if (this.#closed) return;
      yield step.emit;
    }

    // A script that runs out parks instead of ending: a real streaming-input session stays alive
    // until its inbox closes, and a mock that ended here would fake a crash after every turn.
    while (!this.#closed) await this.#awaitPrompt();
  }

  async #awaitPrompt(): Promise<void> {
    if (this.#closed) return;
    if (this.#pendingPrompts > 0) {
      this.#pendingPrompts -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.#promptWaiters.push(settle);
      this.#interruptSignal = settle;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
