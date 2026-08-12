import { newId } from '@mc/shared';
import { ApiError } from '../../src/http/errors.js';
import type {
  InterruptOutcome,
  LaunchOutcome,
  LaunchRequest,
  RuntimeDisposeReason,
  SessionRuntimePort,
} from '../../src/sessions/runtime-port.js';

/**
 * A scriptable `SessionRuntimePort` for the integration tier — the seam WS6 §5.1 requires and
 * the shape §5.2's `MockAgentRuntime` will grow into once the Agent SDK wrapper exists.
 *
 * This is deliberately not that mock. It scripts *outcomes*, not streams: the Session domain
 * only ever asks the runtime four questions (did the launch succeed, is a turn streaming, stop
 * that turn, let go), and those four are what these tests need to control. Message streaming,
 * cost capture and the fixture-driven script library belong with the wrapper.
 */

export interface FakeRuntimeOptions {
  /** Fail the next `launch` call with this error, once. */
  readonly failLaunch?: boolean;
}

export interface FakeRuntime extends SessionRuntimePort {
  readonly launches: LaunchRequest[];
  readonly disposals: { sessionId: string; reason: RuntimeDisposeReason }[];
  /** Make the next launch fail (spawn error). Reset after it fires. */
  failNextLaunch(): void;
  /** Make every launch fail until cleared. */
  failAllLaunches(fail: boolean): void;
  /** Pretend an assistant turn is streaming for this Session (§6.3.1). */
  setTurnInFlight(sessionId: string, inFlight: boolean): void;
  /** The Message id `interrupt` will report as the retained partial turn. */
  setInterruptMessageId(messageId: string | null): void;
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const launches: LaunchRequest[] = [];
  const disposals: { sessionId: string; reason: RuntimeDisposeReason }[] = [];
  const turns = new Set<string>();

  let failOnce = options.failLaunch === true;
  let failAlways = false;
  let interruptMessageId: string | null = null;

  return {
    launches,
    disposals,

    failNextLaunch() {
      failOnce = true;
    },
    failAllLaunches(fail) {
      failAlways = fail;
    },
    setTurnInFlight(sessionId, inFlight) {
      if (inFlight) turns.add(sessionId);
      else turns.delete(sessionId);
    },
    setInterruptMessageId(messageId) {
      interruptMessageId = messageId;
    },

    async launch(request: LaunchRequest): Promise<LaunchOutcome> {
      launches.push(request);

      if (failAlways || failOnce) {
        failOnce = false;
        throw new ApiError('RUNTIME_UNAVAILABLE', 'scripted spawn failure', {
          sessionId: request.sessionId,
        });
      }

      return {
        // The runtime issues its own native id; ours is the UUIDv7 primary key (F1.5/F4.2).
        runtimeSessionId: newId(),
        runtimeVersion: '2.0.14-test',
        model: request.model ?? 'claude-sonnet-4-5',
        machine: 'test-host',
        environment: 'test',
      };
    },

    hasTurnInFlight(sessionId: string): boolean {
      return turns.has(sessionId);
    },

    async interrupt(sessionId: string): Promise<InterruptOutcome> {
      if (!turns.has(sessionId)) {
        throw new ApiError('NO_TURN_IN_FLIGHT', 'No assistant turn is currently streaming', {
          sessionId,
        });
      }
      turns.delete(sessionId);
      return { messageId: interruptMessageId };
    },

    async dispose(sessionId: string, reason: RuntimeDisposeReason): Promise<void> {
      disposals.push({ sessionId, reason });
      turns.delete(sessionId);
    },
  };
}
