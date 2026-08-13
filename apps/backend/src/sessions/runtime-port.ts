import type { SessionType } from '@mc/shared';
import { ApiError } from '../http/errors.js';
import type { RuntimeAgentBinding } from './agent-binding.js';

/**
 * `SessionRuntimePort` — the seam between the Session domain and the Claude Code runtime.
 *
 * WS6 §5.1 states this as a testability *requirement* on WS1: all
 * `@anthropic-ai/claude-agent-sdk` calls sit behind a single Backend-owned interface so no
 * other module imports the SDK, and the mock runtime (WS6 §5.2) substitutes for it wholesale.
 * WS7 non-blocking finding **N8** notes WS1 never named it; this is that name, adopted.
 *
 * Nothing in this module knows what a runtime is. It knows what the domain needs from one:
 * a launch that either yields a native session id or fails, a way to ask whether a turn is
 * streaming (§6.3.1 `NO_TURN_IN_FLIGHT`), a way to stop that turn, and a way to let go of the
 * runtime when a Session cold-pauses or ends (TDS 02 §5.1).
 *
 * The Agent SDK implementation is the wrapper workstream's; `createUnavailableRuntimePort()`
 * below is the honest placeholder until it lands.
 */

export interface LaunchRequest {
  readonly sessionId: string;
  readonly sessionType: SessionType;
  readonly workingDirectory: string;
  readonly model: string | null;
  readonly branch: string | null;
  /**
   * The runtime-native session id to resume from — SDK `resume:` (F1.5). Set for an in-place
   * `paused -> running` resume, for a resume-as-new Session (the parent's id), and for a Clone.
   */
  readonly resumeFromRuntimeSessionId: string | null;
  /** SDK `forkSession: true` — this Session is a Clone of the resume target (F1.5). */
  readonly fork: boolean;
  /**
   * The Agent persona this Session runs as, resolved to what the runtime must do about it, or
   * `null` for a Session bound to no Agent (PRD §5.1).
   *
   * This is the field that makes an Agent more than a database row: F1.5 reserved the runtime's
   * control surfaces as the Phase 4 enforcement point, and this is where they are handed over —
   * a system-prompt append and a tool deny list, both computed once in `agents/binding.ts`.
   * A runtime that ignores it runs a session with no persona and no restrictions, which is why
   * `ManagedRuntime` forwards it rather than treating it as advisory.
   */
  readonly agent: RuntimeAgentBinding | null;
  /** Aborted when the launch is no longer wanted (shutdown, job lease expiry). */
  readonly signal?: AbortSignal | undefined;
}

/**
 * What the runtime reports once it has confirmed spawn/attach. `runtimeSessionId` is the
 * Claude Code native UUIDv4 (F1.5) — distinct from our UUIDv7 primary key (F4.2) — and is what
 * turns "we asked for a session" into F7's "system confirms spawn".
 */
export interface LaunchOutcome {
  readonly runtimeSessionId: string;
  readonly runtimeVersion?: string | null;
  readonly model?: string | null;
  readonly machine?: string | null;
  readonly environment?: string | null;
  readonly transcriptPath?: string | null;
}

export interface InterruptOutcome {
  /** The retained partial Message; `null` when the turn produced no persisted content (§6.3.1). */
  readonly messageId: string | null;
}

/** Why the runtime is being let go. `paused` is the cold pause of TDS 02 §5.1. */
export type RuntimeDisposeReason = 'paused' | 'ended' | 'failed' | 'shutdown';

export interface SessionRuntimePort {
  /** Spawn or attach. Resolves once the runtime has confirmed; throws to mean "spawn failed". */
  launch(request: LaunchRequest): Promise<LaunchOutcome>;
  /** Is an assistant turn currently streaming? Backs `NO_TURN_IN_FLIGHT` (§6.3.1). */
  hasTurnInFlight(sessionId: string): boolean;
  /** Stop the turn in flight *without* changing Session state (§6.3.1). */
  interrupt(sessionId: string): Promise<InterruptOutcome>;
  /** Dispose the runtime and release its resources. Must be safe to call twice. */
  dispose(sessionId: string, reason: RuntimeDisposeReason): Promise<void>;
}

/**
 * The default port: there is no runtime yet.
 *
 * It fails launches with `RUNTIME_UNAVAILABLE` (503), which is exactly what the error registry
 * means by "Claude Code CLI/SDK not reachable" (TDS 04 §1.3) and exactly what §6.3 says a
 * spawn failure does — the Session moves to `failed` and the caller gets a 503. That is a
 * truthful state for a Backend with no wrapper wired in, and it is far better than a stub that
 * pretends a session started.
 */
export function createUnavailableRuntimePort(): SessionRuntimePort {
  return {
    async launch(request) {
      throw new ApiError(
        'RUNTIME_UNAVAILABLE',
        'No Claude Code runtime is configured for this Backend',
        { sessionId: request.sessionId },
      );
    },
    hasTurnInFlight() {
      return false;
    },
    async interrupt(sessionId) {
      throw new ApiError('NO_TURN_IN_FLIGHT', 'No assistant turn is currently streaming', {
        sessionId,
      });
    },
    async dispose() {
      /* nothing was ever spawned */
    },
  };
}
