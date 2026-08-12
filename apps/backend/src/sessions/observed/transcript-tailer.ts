import { Buffer } from 'node:buffer';
import { type FSWatcher, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import type {
  TailBurst,
  TailState,
  TailStateStore,
  TranscriptSink,
  TranscriptTailerPort,
} from './ports.js';
import { parseTranscriptLine } from './transcript-parse.js';

/**
 * `TranscriptTailer` — the fidelity channel of observed-session observation (TDS 02 §6.3).
 *
 * Four properties, and every one of them is a rule this file exists to keep:
 *
 * 1. **Per-file watching.** `fs.watch` is pointed at the single session JSONL, never at a
 *    directory tree (spike §8 — Windows watchers are per-handle and expensive). A low-frequency
 *    interval backs the watcher up, because file watchers miss events on every OS and a missed
 *    event must cost latency, not data.
 * 2. **Restart-safe cursor.** Reads start at the persisted `byte_offset` and advance only by
 *    **complete lines** (TDS 03 §3.15). A partial trailing line is simply not consumed, so the
 *    next burst — or the next process — re-reads it from the same offset. There is no in-memory
 *    partial-line buffer to lose.
 * 3. **Drift, not failure.** Every unparseable or unrecognised line increments a per-session
 *    counter. Past the threshold the tailer **detaches and degrades to hook-only** — persisting
 *    `degraded`, emitting `session.observation_degraded` once, and leaving the Session's F7
 *    state untouched. Parser drift never transitions a Session (TDS 02 §5.2/§6.3).
 * 4. **Terminal degradation (WS7 arbitration A11).** There is no re-attach, no restored event
 *    and no retry loop. `transcript_tail_states.degraded` is sticky across restarts so the UI
 *    badge cannot flap, and because re-attaching would not recover the lines already skipped —
 *    "restored" would be a claim we cannot support.
 *
 * No method throws. A tailer that can take down the Backend turns a Claude Code version bump
 * into an outage, which is the exact failure mode F1.5's adapter boundary exists to prevent.
 */

/**
 * Parse failures tolerated before the tailer detaches.
 *
 * Chosen to be well clear of incidental noise (a truncated final line while the runtime is
 * mid-write is *normal* and is not drift at all) while still tripping long before a genuinely
 * changed format has quietly dropped a session's worth of turns.
 */
export const DEFAULT_DRIFT_THRESHOLD = 25;

/** Watcher backstop. Long enough to be free, short enough that a missed event is not visible. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Ceiling on one read burst. A burst that hits it simply continues on the next one. */
export const DEFAULT_MAX_BYTES_PER_READ = 1024 * 1024;

/** Coalesce the burst of watcher events a single append produces. */
const WATCH_DEBOUNCE_MS = 25;

export interface TranscriptTailerOptions {
  readonly store: TailStateStore;
  readonly sink: TranscriptSink;
  readonly driftThreshold?: number;
  readonly pollIntervalMs?: number;
  readonly maxBytesPerRead?: number;
  /** `false` in tests that drive `drain()` directly and want no timers at all. */
  readonly watch?: boolean;
  readonly now?: () => Date;
  /** Diagnostics only — the tailer never propagates an error to its caller. */
  readonly onError?: (error: unknown, sessionId: string) => void;
  readonly onDegraded?: (info: {
    readonly sessionId: string;
    readonly reason: string;
    readonly driftCount: number;
  }) => void;
}

interface Attachment {
  readonly sessionId: string;
  transcriptPath: string;
  byteOffset: number;
  lineNo: number;
  driftCount: number;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  debounce: NodeJS.Timeout | null;
  /** Serializes bursts for one Session; also what `stop()` waits on. */
  chain: Promise<unknown>;
  closed: boolean;
}

export class TranscriptTailer implements TranscriptTailerPort {
  readonly #store: TailStateStore;
  readonly #sink: TranscriptSink;
  readonly #driftThreshold: number;
  readonly #pollIntervalMs: number;
  readonly #maxBytesPerRead: number;
  readonly #watch: boolean;
  readonly #now: () => Date;
  readonly #onError: ((error: unknown, sessionId: string) => void) | undefined;
  readonly #onDegraded: TranscriptTailerOptions['onDegraded'];
  readonly #attachments = new Map<string, Attachment>();

  #stopped = false;

  constructor(options: TranscriptTailerOptions) {
    this.#store = options.store;
    this.#sink = options.sink;
    this.#driftThreshold = options.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxBytesPerRead = options.maxBytesPerRead ?? DEFAULT_MAX_BYTES_PER_READ;
    this.#watch = options.watch ?? true;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
    this.#onDegraded = options.onDegraded;
  }

  get attached(): readonly string[] {
    return [...this.#attachments.keys()];
  }

  /**
   * Begin or resume tailing one Session.
   *
   * Returns `null` when the Session is already degraded — A11's sticky flag is checked here, so
   * a redelivered hook carrying a `transcript_path` can never silently re-attach a tailer the
   * drift counter already retired.
   */
  async attach(input: {
    readonly sessionId: string;
    readonly transcriptPath: string;
  }): Promise<TailState | null> {
    if (this.#stopped) return null;

    const existing = this.#attachments.get(input.sessionId);
    if (existing !== undefined) {
      if (existing.transcriptPath !== input.transcriptPath) {
        // The runtime moved the transcript (a `--resume` into another directory re-encodes the
        // path). Follow it through the store, so the move is persisted and the cursor resets:
        // a byte offset is meaningless against a different file.
        try {
          const moved = await this.#store.attach(input);
          if (moved.degraded) {
            this.#drop(input.sessionId);
            return null;
          }
          existing.transcriptPath = moved.transcriptPath;
          existing.byteOffset = moved.byteOffset;
          existing.lineNo = moved.lineNo;
          this.#rewatch(existing);
        } catch (error) {
          this.#onError?.(error, input.sessionId);
          return null;
        }
      }
      this.#schedule(existing);
      return null;
    }

    try {
      const state = await this.#store.attach(input);
      if (state.degraded) return null;

      const attachment: Attachment = {
        sessionId: input.sessionId,
        transcriptPath: state.transcriptPath,
        byteOffset: state.byteOffset,
        lineNo: state.lineNo,
        driftCount: state.driftCount,
        watcher: null,
        timer: null,
        debounce: null,
        chain: Promise.resolve(),
        closed: false,
      };

      this.#attachments.set(input.sessionId, attachment);
      this.#rewatch(attachment);
      this.#schedule(attachment);
      return state;
    } catch (error) {
      this.#onError?.(error, input.sessionId);
      return null;
    }
  }

  async detach(sessionId: string): Promise<void> {
    const attachment = this.#drop(sessionId);
    if (attachment === null) return;
    // Let an in-flight burst finish rather than tearing its transaction in half.
    await attachment.chain.catch(() => undefined);
  }

  /**
   * Stop tailing, synchronously and without waiting.
   *
   * Separate from `detach` because the two internal callers — an ended Session and a degraded
   * one — are running **inside** the burst chain, and awaiting that chain from within it is a
   * deadlock rather than a wait.
   */
  #drop(sessionId: string): Attachment | null {
    const attachment = this.#attachments.get(sessionId);
    if (attachment === undefined) return null;
    this.#attachments.delete(sessionId);
    this.#release(attachment);
    return attachment;
  }

  /** Read whatever is on disk right now. Public so tests need no timers and no watchers. */
  async drain(sessionId: string): Promise<TailBurst | null> {
    const attachment = this.#attachments.get(sessionId);
    if (attachment === undefined) return null;
    return this.#enqueue(attachment);
  }

  /**
   * Reattach every observed Session that still has a live cursor (TDS 03 §3.15: *"on boot the
   * tailer registry reloads rows for non-terminal observed sessions and reattaches at the
   * persisted byte offset instead of re-ingesting from byte 0"*).
   */
  async resume(): Promise<number> {
    if (this.#stopped) return 0;

    let attached = 0;
    try {
      for (const state of await this.#store.listResumable()) {
        const result = await this.attach({
          sessionId: state.sessionId,
          transcriptPath: state.transcriptPath,
        });
        if (result !== null) attached += 1;
      }
    } catch (error) {
      this.#onError?.(error, 'resume');
    }
    return attached;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const attachments = [...this.#attachments.values()];
    this.#attachments.clear();
    for (const attachment of attachments) this.#release(attachment);
    await Promise.all(attachments.map(async (a) => a.chain.catch(() => undefined)));
  }

  // ------------------------------------------------------------------------- internals

  /** One burst at a time per Session — the "exactly one writer per Session" rule (TDS 03 §3.11). */
  #enqueue(attachment: Attachment): Promise<TailBurst | null> {
    const next = attachment.chain.then(async () => this.#burst(attachment));
    attachment.chain = next.catch(() => undefined);
    return next;
  }

  #schedule(attachment: Attachment): void {
    if (attachment.debounce !== null) return;
    attachment.debounce = setTimeout(() => {
      attachment.debounce = null;
      void this.#enqueue(attachment);
    }, WATCH_DEBOUNCE_MS);
    attachment.debounce.unref?.();
  }

  async #burst(attachment: Attachment): Promise<TailBurst | null> {
    if (attachment.closed) return null;

    try {
      if (!(await this.#sink.isObservable(attachment.sessionId))) {
        // The Session ended (or "stop observing" detached it). Let go without a word: `end`
        // must never look like a failure, and it must never touch the operator's process.
        this.#drop(attachment.sessionId);
        return null;
      }

      return await this.#readAndIngest(attachment);
    } catch (error) {
      // Deliberately swallowed. A read error is not a Session failure (TDS 02 §5.2: ingest
      // hard-failure requires hooks to have stopped too), and a throw here would escape into
      // a timer callback with nothing to catch it.
      this.#onError?.(error, attachment.sessionId);
      return null;
    }
  }

  async #readAndIngest(attachment: Attachment): Promise<TailBurst | null> {
    const handle = await open(attachment.transcriptPath, 'r').catch(() => null);
    if (handle === null) {
      // Not yet written, or already cleaned up by the runtime's retention. Neither is drift and
      // neither is an error: the next burst will find it, or the Session will end without one.
      return null;
    }

    let complete = '';
    let consumedBytes = 0;

    try {
      const stats = await handle.stat();

      if (stats.size < attachment.byteOffset) {
        // Shorter than our cursor: the file was replaced, not appended to. Restart from 0 and
        // let `(session_id, runtime_message_id)` absorb whatever we re-read (TDS 03 §3.11).
        attachment.byteOffset = 0;
        attachment.lineNo = 0;
      }
      if (stats.size === attachment.byteOffset) return null;

      const length = Math.min(stats.size - attachment.byteOffset, this.#maxBytesPerRead);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, attachment.byteOffset);
      if (bytesRead <= 0) return null;

      const chunk = buffer.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);

      if (lastNewline < 0) {
        if (bytesRead < this.#maxBytesPerRead) return null; // partial trailing line; wait.
        // A "line" longer than one whole burst. Skip it as drift rather than stalling forever
        // on a file that will never produce another newline.
        attachment.byteOffset += bytesRead;
        attachment.driftCount += 1;
        await this.#persist(attachment, 'transcript line exceeds the maximum read size');
        return this.#afterBurst(attachment, 0, 0, 1);
      }

      consumedBytes = lastNewline + 1;
      complete = chunk.subarray(0, consumedBytes).toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }

    return this.#ingestLines(attachment, complete, consumedBytes);
  }

  async #ingestLines(
    attachment: Attachment,
    complete: string,
    consumedBytes: number,
  ): Promise<TailBurst> {
    const lines = complete.split('\n');
    // The trailing element after the final '\n' is always the empty string; drop it.
    if (lines[lines.length - 1] === '') lines.pop();

    let appended = 0;
    let drifted = 0;
    let lastReason: string | null = null;

    for (const line of lines) {
      const parsed = parseTranscriptLine(line);

      if (parsed.kind === 'drift') {
        drifted += 1;
        lastReason = parsed.reason;
        continue;
      }
      if (parsed.kind === 'ignored') continue;

      try {
        await this.#sink.append(attachment.sessionId, parsed.record);
        appended += 1;
      } catch (error) {
        // A persistence failure is ours, not the format's — it must not inflate the drift
        // counter and degrade a session over a transient database blip.
        this.#onError?.(error, attachment.sessionId);
      }
    }

    attachment.byteOffset += consumedBytes;
    attachment.lineNo += lines.length;
    attachment.driftCount += drifted;

    await this.#persist(attachment, lastReason);
    return this.#afterBurst(attachment, lines.length, appended, drifted);
  }

  async #persist(attachment: Attachment, lastError: string | null): Promise<void> {
    await this.#store.advance(attachment.sessionId, {
      byteOffset: attachment.byteOffset,
      lineNo: attachment.lineNo,
      driftCount: attachment.driftCount,
      lastReadAt: this.#now(),
      ...(lastError === null ? {} : { lastError }),
    });
  }

  /** The degradation decision, applied after the cursor has been persisted. */
  async #afterBurst(
    attachment: Attachment,
    linesRead: number,
    appended: number,
    drifted: number,
  ): Promise<TailBurst> {
    const burst: TailBurst = {
      sessionId: attachment.sessionId,
      linesRead,
      appended,
      drifted,
      byteOffset: attachment.byteOffset,
      degraded: false,
    };

    if (attachment.driftCount < this.#driftThreshold) return burst;

    const reason =
      `transcript parse drift exceeded the threshold ` +
      `(${attachment.driftCount}/${this.#driftThreshold} unparseable or unknown lines)`;

    // Whatever the store reports, this tailer is done with the Session: A11 makes degradation
    // terminal, so there is no path back and nothing to re-arm.
    this.#drop(attachment.sessionId);
    const flipped = await this.#store.degrade(attachment.sessionId, reason, attachment.driftCount);

    if (flipped) {
      this.#onDegraded?.({
        sessionId: attachment.sessionId,
        reason,
        driftCount: attachment.driftCount,
      });
    }

    return { ...burst, degraded: true };
  }

  #rewatch(attachment: Attachment): void {
    this.#releaseWatchers(attachment);
    if (!this.#watch || this.#stopped) return;

    try {
      // Per-FILE watch (spike §8). If the file does not exist yet this throws, and the interval
      // below is what picks the session up once the runtime creates it.
      const watcher = watch(attachment.transcriptPath, { persistent: false }, () => {
        this.#schedule(attachment);
      });
      watcher.on('error', () => {
        // Watchers die when a file is replaced or a volume goes away. The interval covers it;
        // an unhandled 'error' event would not.
        this.#releaseWatcher(attachment);
      });
      attachment.watcher = watcher;
    } catch {
      attachment.watcher = null;
    }

    const timer = setInterval(() => {
      this.#schedule(attachment);
    }, this.#pollIntervalMs);
    timer.unref?.();
    attachment.timer = timer;
  }

  #release(attachment: Attachment): void {
    attachment.closed = true;
    this.#releaseWatchers(attachment);
  }

  #releaseWatchers(attachment: Attachment): void {
    this.#releaseWatcher(attachment);
    if (attachment.timer !== null) {
      clearInterval(attachment.timer);
      attachment.timer = null;
    }
    if (attachment.debounce !== null) {
      clearTimeout(attachment.debounce);
      attachment.debounce = null;
    }
  }

  #releaseWatcher(attachment: Attachment): void {
    if (attachment.watcher === null) return;
    attachment.watcher.close();
    attachment.watcher = null;
  }
}
