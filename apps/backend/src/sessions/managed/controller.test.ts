import { newId } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import {
  createFakeCostStore,
  createFakeDeltaSink,
  createFakeMessageSink,
  createFakeStateMachine,
  type FakeCostStore,
  type FakeDeltaSink,
  type FakeMessageSink,
  type FakeStateMachine,
  waitFor,
} from '../../../test/support/managed-doubles.js';
import {
  createMockAgentRuntime,
  type MockAgentRuntime,
  type ScriptStep,
} from '../../../test/support/mock-agent-runtime.js';
import {
  happyMultiTurn,
  happySingleTurn,
  interruptedTurn,
  midStreamCrash,
  rateLimitStop,
  slowStream,
  spawnFailure,
  toolUseTurn,
  unresponsiveInterrupt,
} from '../../../test/support/runtime-scripts.js';
import { ManagedSessionController } from './controller.js';
import { ZERO_COST } from './cost.js';
import type { RateLimitedTurn } from './ports.js';

/**
 * `ManagedSessionController` against the WS6 §5.2 mock runtime — the whole pump, with **no
 * database** (TDS 07 §3: `pnpm test` must pass on a machine with no PostgreSQL).
 *
 * Everything the controller does is observable through four ports, so every assertion here is
 * about an effect the rest of the system can see: a Message that was persisted, a delta that was
 * relayed, a cost that was written, a transition that was requested.
 */

interface Harness {
  readonly sessionId: string;
  readonly controller: ManagedSessionController;
  readonly runtime: MockAgentRuntime;
  readonly messages: FakeMessageSink;
  readonly state: FakeStateMachine;
  readonly cost: FakeCostStore;
  readonly deltas: FakeDeltaSink;
  readonly errors: unknown[];
  readonly rateLimits: RateLimitedTurn[];
}

function harness(
  script: readonly ScriptStep[],
  options: { interruptTimeoutMs?: number; disposeTimeoutMs?: number } = {},
): Harness {
  const sessionId = newId();
  const runtime = createMockAgentRuntime(script);
  const messages = createFakeMessageSink();
  const state = createFakeStateMachine();
  const cost = createFakeCostStore();
  const deltas = createFakeDeltaSink();
  const errors: unknown[] = [];
  const rateLimits: RateLimitedTurn[] = [];

  const controller = new ManagedSessionController({
    sessionId,
    handle: runtime.start({
      sessionId,
      workingDirectory: '/repo',
      model: null,
      resume: null,
      fork: false,
    }),
    messages,
    stateMachine: state,
    cost,
    deltas,
    baseline: ZERO_COST,
    onError: (error) => errors.push(error),
    onRateLimited: (turn) => rateLimits.push(turn),
    interruptTimeoutMs: options.interruptTimeoutMs ?? 200,
    disposeTimeoutMs: options.disposeTimeoutMs ?? 200,
  });

  return { sessionId, controller, runtime, messages, state, cost, deltas, errors, rateLimits };
}

describe('spawn confirmation (F7 "system confirms spawn")', () => {
  it('resolves ready() with the runtime-native session id', async () => {
    const h = harness(happySingleTurn);

    const facts = await h.controller.ready();

    expect(facts.runtimeSessionId).toBe('5f6c0b98-2a5b-4a1e-8c1a-7c9e8a1b2c3d');
    expect(facts.claudeVersion).toBe('2.1.228');
    expect(facts.model).toBe('claude-sonnet-4-5');
    await h.controller.dispose();
  });

  it('rejects ready() on a spawn failure and never transitions the Session', async () => {
    const h = harness(spawnFailure);

    await expect(h.controller.ready()).rejects.toThrow(/claude executable not found/);
    // §6.3: the launch path owns `created -> failed`, because only it knows which state the
    // Session was in. A controller that never started must not write a transition of its own.
    expect(h.state.transitions).toEqual([]);
    await h.controller.dispose();
  });
});

describe('multi-turn streaming (WS6 §5.2 happy-multi-turn)', () => {
  it('relays every delta ephemerally and persists one Message per completed turn', async () => {
    const h = harness(happyMultiTurn);
    await h.controller.ready();

    await h.controller.submit({ content: 'Refactor the queue consumer', messageId: newId() });
    await waitFor(() => h.messages.byRole('assistant').length === 1, { label: 'first turn' });

    await h.controller.submit({ content: 'Thanks', messageId: newId() });
    await waitFor(() => h.messages.byRole('assistant').length === 2, { label: 'second turn' });

    expect(h.deltas.text()).toBe('Refactoring the queue consumerDone. Anything else?');
    expect(h.messages.byRole('assistant').map((message) => message.content)).toEqual([
      'Refactoring the queue consumer',
      'Done. Anything else?',
    ]);
    // The deltas of a turn and the durable Message it becomes share one id, so a client can
    // stitch the stream to the committed row instead of guessing (§14.5 `messageId`).
    expect(h.deltas.deltas[0]?.messageId).toBe(h.messages.byRole('assistant')[0]?.id);
    expect(h.deltas.deltas.at(-1)?.messageId).toBe(h.messages.byRole('assistant')[1]?.id);
    // The user's own prompt is persisted by the prompt path, never echoed back in by the pump.
    expect(h.messages.byRole('user')).toEqual([]);

    await h.controller.dispose();
  });

  it('captures cost and usage from the terminal result, reading rather than summing', async () => {
    const h = harness(happyMultiTurn);
    await h.controller.ready();

    await h.controller.submit({ content: 'one', messageId: null });
    await waitFor(() => h.cost.writes.length === 1);
    await h.controller.submit({ content: 'two', messageId: null });
    await waitFor(() => h.cost.writes.length === 2);

    // `total_cost_usd` is a running total per query() call: the second result's 0.031 is the
    // whole session, not an increment. Summing would report 0.0435.
    expect(h.cost.latest()?.totalCostUsd).toBeCloseTo(0.031, 6);
    // `usage` is per-turn, so it *is* summed.
    expect(h.cost.latest()?.usage.input_tokens).toBe(2400);
    expect(h.cost.latest()?.usage.cache_read_input_tokens).toBe(1600);
    expect(h.cost.latest()?.numTurns).toBe(2);
    expect(h.cost.latest()?.durationMs).toBe(8400);

    await h.controller.dispose();
  });

  it('keeps streaming under long inter-delta latency', async () => {
    const h = harness(slowStream);
    await h.controller.ready();

    await h.controller.submit({ content: 'slow please', messageId: null });
    await waitFor(() => h.cost.writes.length === 1, { label: 'slow stream result' });

    expect(h.deltas.text()).toBe('thinking harder');
    await h.controller.dispose();
  });
});

describe('tool calls (WS6 §5.2 tool-use-turn)', () => {
  it('persists a tool Message per call and per result, with the §6.10.2 file path', async () => {
    const h = harness(toolUseTurn);
    await h.controller.ready();

    await h.controller.submit({ content: 'Read the queue', messageId: null });
    await waitFor(() => h.messages.byRole('tool').length === 2, { label: 'tool rows' });

    const [use, output] = h.messages.byRole('tool');
    expect(use?.toolName).toBe('Read');
    expect(use?.toolUseId).toBe('toolu_01');
    expect(use?.toolPayload).toEqual({ input: { file_path: '/repo/src/queue.ts' } });
    // The Files panel reads this column and nothing else (§6.10.2).
    expect(use?.toolFilePath).toBe('/repo/src/queue.ts');
    expect(output?.toolUseId).toBe('toolu_01');
    expect(output?.content).toBe('export const queue = 1;');
    expect(output?.toolFilePath).toBeNull();

    // The assistant Message keeps the tool_use block too, so the turn re-renders faithfully.
    const assistant = h.messages.byRole('assistant')[0];
    expect(assistant?.contentBlocks).toEqual([
      { type: 'text', text: 'Reading the file.' },
      {
        type: 'tool_use',
        toolUseId: 'toolu_01',
        toolName: 'Read',
        input: { file_path: '/repo/src/queue.ts' },
      },
    ]);

    // Partial tool JSON is streamed for rendering but never accumulated into a Message: half a
    // JSON document is not a tool call.
    expect(h.deltas.deltas.filter((delta) => delta.deltaType === 'input_json_delta')).toHaveLength(
      2,
    );

    await h.controller.dispose();
  });
});

describe('interrupt (§6.3.1 — no state transition)', () => {
  it('persists the runtime’s aborted message as interrupted and leaves state untouched', async () => {
    const h = harness(interruptedTurn);
    await h.controller.ready();
    await h.controller.submit({ content: 'Start the refactor', messageId: null });
    await waitFor(() => h.deltas.deltas.length === 2, { label: 'deltas before interrupt' });

    const outcome = await h.controller.interrupt();

    const partial = h.messages.byRole('assistant')[0];
    expect(outcome.messageId).toBe(partial?.id);
    expect(partial?.status).toBe('interrupted');
    expect(partial?.content).toBe('Starting the refactor');
    // The whole point of §6.3.1: no F7 transition, so no `session.state_changed`.
    expect(h.state.transitions).toEqual([]);
    // …and the Session is immediately ready for the next prompt.
    expect(h.controller.hasTurnInFlight).toBe(false);

    await h.controller.dispose();
  });

  it('flushes the accumulated deltas itself when the runtime never ends the turn', async () => {
    const h = harness(unresponsiveInterrupt, { interruptTimeoutMs: 50 });
    await h.controller.ready();
    await h.controller.submit({ content: 'Start', messageId: null });
    await waitFor(() => h.deltas.deltas.length === 1);

    const outcome = await h.controller.interrupt();

    const partial = h.messages.byRole('assistant')[0];
    expect(outcome.messageId).toBe(partial?.id);
    expect(partial?.content).toBe('Half a thought');
    expect(partial?.status).toBe('interrupted');
    // A reconstruction, not a runtime message: no dedupe key, because there is no runtime uuid
    // to key on and inventing one would collide with the real message if it ever arrived.
    expect(partial?.runtimeMessageId).toBeNull();
    expect(h.state.transitions).toEqual([]);

    await h.controller.dispose();
  });

  it('refuses when no turn is in flight (NO_TURN_IN_FLIGHT)', async () => {
    const h = harness(happySingleTurn);
    await h.controller.ready();

    await expect(h.controller.interrupt()).rejects.toMatchObject({ code: 'NO_TURN_IN_FLIGHT' });
    await h.controller.dispose();
  });
});

describe('failure paths', () => {
  it('fails the Session when the stream dies mid-turn (WS6 §5.2 mid-stream-crash)', async () => {
    const h = harness(midStreamCrash);
    await h.controller.ready();
    await h.controller.submit({ content: 'Start', messageId: null });

    await waitFor(() => h.state.transitions.length === 1, { label: 'crash transition' });

    expect(h.state.transitions[0]).toMatchObject({
      to: 'failed',
      trigger: 'system',
      action: 'system',
      reason: 'process_crash',
    });
    expect(h.controller.closed).toBe(true);
    // Partial output stays: a failed turn is retained, never discarded (WS4 §6.2).
    expect(h.deltas.text()).toBe('Starting the refa');
  });

  it('backs off a rate-limited turn without transitioning the Session (WS1 §4.3)', async () => {
    const h = harness(rateLimitStop);
    await h.controller.ready();
    await h.controller.submit({ content: 'Do the thing', messageId: 'message-1' });

    await waitFor(() => h.rateLimits.length === 1, { label: 'rate limit callback' });

    expect(h.rateLimits[0]).toMatchObject({
      sessionId: h.sessionId,
      content: 'Do the thing',
      messageId: 'message-1',
      attempt: 1,
      reason: 'rate_limit',
    });
    // The turn failed; the session did not.
    expect(h.state.transitions).toEqual([]);
    expect(h.controller.hasTurnInFlight).toBe(false);
    // Cost accrued before the limit is still recorded.
    expect(h.cost.latest()?.totalCostUsd).toBeCloseTo(0.004, 6);

    await h.controller.dispose();
  });

  it('survives a persistence failure instead of taking the pump down with it', async () => {
    const h = harness(happyMultiTurn);
    await h.controller.ready();
    h.messages.failNext(new Error('database unavailable'));

    await h.controller.submit({ content: 'one', messageId: null });
    await waitFor(() => h.cost.writes.length === 1, { label: 'first result' });

    expect(h.errors).toHaveLength(1);
    // The next turn still lands: one lost row is a degraded transcript, not a dead session.
    await h.controller.submit({ content: 'two', messageId: null });
    await waitFor(() => h.messages.byRole('assistant').length === 1, { label: 'second turn' });

    expect(h.state.transitions).toEqual([]);
    await h.controller.dispose();
  });
});

describe('cold pause (TDS 02 §5.1)', () => {
  it('interrupts the turn, closes the inbox, and records no transition of its own', async () => {
    const h = harness(interruptedTurn);
    await h.controller.ready();
    await h.controller.submit({ content: 'Start the refactor', messageId: null });
    await waitFor(() => h.deltas.deltas.length === 2);

    await h.controller.dispose();

    const session = h.runtime.last();
    expect(session?.interrupts).toBe(1);
    expect(session?.closes).toBeGreaterThanOrEqual(1);
    // The state change belongs to whoever asked for the pause (§5.1 step 4) — the controller
    // must not write one, or a pause would look like a crash.
    expect(h.state.transitions).toEqual([]);
    // The partial the operator already watched arrive is retained.
    expect(h.messages.byRole('assistant')[0]?.status).toBe('interrupted');
  });

  it('is idempotent and does not fail the Session on a requested stream end', async () => {
    const h = harness(happySingleTurn);
    await h.controller.ready();

    await h.controller.dispose();
    await h.controller.dispose();

    expect(h.state.transitions).toEqual([]);
    expect(h.controller.closed).toBe(true);
  });
});
