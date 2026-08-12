import { newId } from '@mc/shared';
import type { SessionCostSnapshot } from '../../src/sessions/managed/cost.js';
import { ZERO_COST } from '../../src/sessions/managed/cost.js';
import type {
  MessageSink,
  SessionCostStore,
  SessionDeltaSink,
  SessionStatePort,
} from '../../src/sessions/managed/ports.js';
import type { AppendMessageInput, AppendMessageResult } from '../../src/sessions/messages.js';
import type { TransitionRequest, TransitionResult } from '../../src/sessions/state-machine.js';
import type { SessionMessageDelta } from '../../src/ws/hub.js';

/**
 * In-memory stand-ins for the four ports `ManagedSessionController` consumes.
 *
 * They exist so the controller's whole behaviour — streaming, persistence order, cost, interrupt,
 * crash handling — is provable in the **unit** tier, which TDS 07 §3 requires to run with no
 * PostgreSQL installed. The integration tier then proves the same paths against the real
 * `MessageService`, `SessionStateMachine` and hub, so these doubles never become the only thing
 * the controller has ever been run against.
 */

export interface RecordedMessage extends AppendMessageInput {
  readonly id: string;
  readonly ordinal: number;
}

export interface FakeMessageSink extends MessageSink {
  readonly appended: readonly RecordedMessage[];
  /** Make the next `append` throw — the pump must survive a persistence failure. */
  failNext(error?: Error): void;
  byRole(role: string): readonly RecordedMessage[];
}

export function createFakeMessageSink(): FakeMessageSink {
  const appended: RecordedMessage[] = [];
  const seen = new Set<string>();
  let failure: Error | null = null;

  return {
    appended,
    failNext(error = new Error('append failed')): void {
      failure = error;
    },
    byRole(role: string): readonly RecordedMessage[] {
      return appended.filter((message) => message.role === role);
    },
    async append(input: AppendMessageInput): Promise<AppendMessageResult> {
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }

      // The real dedupe is a partial unique index on `(session_id, runtime_message_id)`
      // (TDS 03 §3.11); collapsing here keeps the double honest about what callers may assume.
      const key =
        input.runtimeMessageId === null || input.runtimeMessageId === undefined
          ? null
          : `${input.sessionId}:${input.runtimeMessageId}`;
      if (key !== null && seen.has(key)) {
        return { message: null, titleDerived: false, deduplicated: true };
      }
      if (key !== null) seen.add(key);

      const record: RecordedMessage = {
        ...input,
        id: input.id ?? newId(),
        ordinal: appended.length,
      };
      appended.push(record);

      return {
        message: {
          id: record.id,
          ordinal: record.ordinal,
          role: record.role,
          status: record.status ?? 'complete',
          content: record.content ?? '',
        } as unknown as NonNullable<AppendMessageResult['message']>,
        titleDerived: false,
        deduplicated: false,
      };
    },
  };
}

export interface FakeStateMachine extends SessionStatePort {
  readonly transitions: readonly TransitionRequest[];
  /** Reject the next transition, as the real one does for an illegal edge. */
  failNext(error?: Error): void;
}

export function createFakeStateMachine(): FakeStateMachine {
  const transitions: TransitionRequest[] = [];
  let failure: Error | null = null;

  return {
    transitions,
    failNext(error = new Error('INVALID_STATE_TRANSITION')): void {
      failure = error;
    },
    async transition(request: TransitionRequest): Promise<TransitionResult> {
      transitions.push(request);
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
      return {
        session: { id: request.sessionId, state: request.to } as TransitionResult['session'],
        from: 'running',
        to: request.to,
      };
    },
  };
}

export interface FakeCostStore extends SessionCostStore {
  readonly writes: readonly SessionCostSnapshot[];
  latest(): SessionCostSnapshot | null;
}

export function createFakeCostStore(baseline: SessionCostSnapshot = ZERO_COST): FakeCostStore {
  const writes: SessionCostSnapshot[] = [];
  return {
    writes,
    latest(): SessionCostSnapshot | null {
      return writes.at(-1) ?? null;
    },
    async read(): Promise<SessionCostSnapshot> {
      return baseline;
    },
    async write(_sessionId: string, snapshot: SessionCostSnapshot): Promise<void> {
      writes.push(snapshot);
    },
  };
}

export interface FakeDeltaSink extends SessionDeltaSink {
  readonly deltas: readonly SessionMessageDelta[];
  text(): string;
}

export function createFakeDeltaSink(): FakeDeltaSink {
  const deltas: SessionMessageDelta[] = [];
  return {
    deltas,
    text(): string {
      return deltas.map((delta) => delta.text ?? '').join('');
    },
    publishSessionDelta(delta: SessionMessageDelta): unknown {
      deltas.push(delta);
      return delta;
    },
  };
}

/** Poll until `predicate` holds. Cheaper and far more stable than a fixed sleep (TDS 07 §11.3). */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out: ${options.label ?? 'condition never held'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
