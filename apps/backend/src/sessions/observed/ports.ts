import type { MessageRole } from '@mc/shared';

/**
 * The seams of observed-session ingest (TDS 02 §6.3, F1.5).
 *
 * Everything the transcript tailer needs from the rest of the system is one of these three
 * interfaces, which is what lets the whole tailer — cursor arithmetic, lenient parsing, the
 * drift counter and the degradation ladder — be unit tested with **no database and no Fastify**
 * (TDS 07 §5.4). The DB-backed implementations live in `tail-state.ts` and `ingest.ts`.
 */

/** One row of `transcript_tail_states` (TDS 03 §3.15), in the shape the tailer reasons about. */
export interface TailState {
  readonly sessionId: string;
  /** Absolute native path to the runtime JSONL. */
  readonly transcriptPath: string;
  readonly byteOffset: number;
  readonly lineNo: number;
  readonly driftCount: number;
  /**
   * `true` = the tailer detached and observation continues on hooks only. **Sticky for the
   * life of the Session** (WS7 arbitration A11): there is no re-attach and no restored event,
   * because re-attaching cannot recover the lines already skipped.
   */
  readonly degraded: boolean;
  readonly lastError: string | null;
}

export interface TailCursorAdvance {
  readonly byteOffset: number;
  readonly lineNo: number;
  readonly driftCount: number;
  readonly lastError?: string | null;
  readonly lastReadAt?: Date;
}

/** Persistence for the tail cursor. One row per observed Session; restart-safe by construction. */
export interface TailStateStore {
  /** Create the row if absent (idempotent) and return the current state. */
  attach(input: {
    readonly sessionId: string;
    readonly transcriptPath: string;
  }): Promise<TailState>;
  load(sessionId: string): Promise<TailState | null>;
  advance(sessionId: string, advance: TailCursorAdvance): Promise<void>;
  /**
   * Flip `degraded` false -> true, persist the reason and drift count, write the timeline row
   * and emit `session.observation_degraded` — **one transaction**.
   *
   * @returns `true` only for the transition itself. A second call for the same Session
   *   returns `false` and emits nothing, which is what makes the badge un-flappable and the
   *   event exactly-once per Session (TDS 04 §6.9).
   */
  degrade(sessionId: string, reason: string, driftCount: number): Promise<boolean>;
  /** Non-terminal observed Sessions with a usable (non-degraded) cursor — the boot reattach set. */
  listResumable(): Promise<readonly TailState[]>;
}

/** A conversation turn or tool activity recovered from one transcript line. */
export interface TranscriptRecord {
  /** The runtime's own line `uuid` — the ingest dedupe key when present (TDS 03 §3.11). */
  readonly runtimeMessageId: string | null;
  readonly role: MessageRole;
  readonly content: string;
  readonly contentBlocks: unknown[] | null;
  readonly model: string | null;
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly toolPayload: Record<string, unknown> | null;
  readonly toolFilePath: string | null;
  readonly occurredAt: Date | null;
}

/**
 * Where parsed transcript records go. The tailer knows nothing about Messages, ordinals or
 * title derivation — `MessageService.append` owns all three (TDS 04 §6.11.1).
 */
export interface TranscriptSink {
  append(sessionId: string, record: TranscriptRecord): Promise<void>;
  /**
   * `false` = the Session reached a terminal state (or vanished) and the tailer should let go.
   * Checked once per burst rather than per line.
   */
  isObservable(sessionId: string): Promise<boolean>;
}

export interface TailBurst {
  readonly sessionId: string;
  readonly linesRead: number;
  readonly appended: number;
  readonly drifted: number;
  readonly byteOffset: number;
  /** `true` when this burst crossed the drift threshold, or the Session was already degraded. */
  readonly degraded: boolean;
}

/**
 * `TranscriptTailerPort` — the fidelity channel of observed observation (TDS 02 §6.3).
 *
 * Implementations watch **individual session files**, never directory trees (Windows watcher
 * efficiency, spike §8), read from a persisted byte offset, parse leniently, and degrade rather
 * than fail. No method throws: a tailer that can take down the process is a tailer that turns a
 * Claude Code version bump into an outage.
 */
export interface TranscriptTailerPort {
  attach(input: {
    readonly sessionId: string;
    readonly transcriptPath: string;
  }): Promise<TailState | null>;
  detach(sessionId: string): Promise<void>;
  /** Read whatever is on disk now for one Session. */
  drain(sessionId: string): Promise<TailBurst | null>;
  /** Reattach every resumable Session after a Backend restart. @returns how many attached. */
  resume(): Promise<number>;
  stop(): Promise<void>;
  readonly attached: readonly string[];
}
