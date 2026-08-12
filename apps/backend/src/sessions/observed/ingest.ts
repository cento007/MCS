import type { Db } from '@mc/shared';
import type { Outbox, OutboxTransaction } from '../../events/index.js';
import type { MessageService } from '../messages.js';
import { findSessionById, updateSession } from '../repository.js';
import type { SessionStateMachine } from '../state-machine.js';
import { bindObservedSession } from './binding.js';
import { type HookEvent, hookMessageFor, runtimeMessageIdFor } from './hook-events.js';
import { isObservationClosed } from './observability.js';
import { computeTranscriptPath } from './paths.js';
import type { TranscriptRecord, TranscriptSink, TranscriptTailerPort } from './ports.js';

/**
 * `ObservedIngestService` — the push channel of observed observation (TDS 02 §6.1, TDS 04 §6.8).
 *
 * One hook POST is one transaction: bind the runtime session id to a Session (creating it on
 * first sight), confirm the attach as a **system**-triggered `created -> running` transition,
 * append whatever Message the event carries, and enqueue the resulting F6 events on the same
 * transaction through the outbox. Crash before commit and nothing happened; crash after and the
 * events are durably queued.
 *
 * Three rules this service exists to keep:
 *
 *   - **It never blocks the operator's terminal.** The transaction is bounded — a row lock, an
 *     insert and two enqueues — and nothing in the request path touches the filesystem. The
 *     transcript tailer is *scheduled*, never awaited: reading and parsing a JSONL file is
 *     exactly the unbounded work that would show up as a stall in somebody's own CLI session.
 *   - **All state changes go through `state-machine.ts`.** Ingest is one of its six writers, not
 *     an exception to it (TDS 02 §2).
 *   - **"End" means stop observing.** A Session in a terminal state ignores further hook traffic
 *     and detaches the tailer. Mission Control does not own the external process and never
 *     signals it — the operator's `claude` may keep running, unobserved (TDS 02 §5.2).
 */

export interface IngestOutcome {
  readonly sessionId: string;
  /** `true` when this event created the Session record (first sight of the runtime id). */
  readonly created: boolean;
  /** `true` when the attach was confirmed here — the `created -> running` transition. */
  readonly attached: boolean;
  readonly messageId: string | null;
  /** `true` when a redelivered hook collapsed into an existing Message (§6.8 idempotency). */
  readonly deduplicated: boolean;
  /** `true` when the Session is terminal and the event was deliberately ignored. */
  readonly ignored: boolean;
}

export interface ObservedIngestServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly messages: MessageService;
  readonly stateMachine: SessionStateMachine;
  readonly tailer?: TranscriptTailerPort;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, sessionId: string) => void;
}

export class ObservedIngestService implements TranscriptSink {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #messages: MessageService;
  readonly #stateMachine: SessionStateMachine;
  readonly #now: () => Date;
  readonly #onError: ((error: unknown, sessionId: string) => void) | undefined;

  #tailer: TranscriptTailerPort | null;

  /**
   * One in-flight ingest per runtime session id.
   *
   * TDS 03 §3.11 assigns `ordinal` on the assumption that *"each Session has exactly one writer
   * at any moment — the observation ingester (hooks + tailer) is serialized per session"*. The
   * row lock inside the transaction already makes ordinals correct; this chain keeps two
   * redelivered hooks from queueing up behind that lock in the first place.
   */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(options: ObservedIngestServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#messages = options.messages;
    this.#stateMachine = options.stateMachine;
    this.#tailer = options.tailer ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
  }

  /** Wired after construction because the tailer's sink is this object (a deliberate cycle). */
  setTailer(tailer: TranscriptTailerPort): void {
    this.#tailer = tailer;
  }

  /** `POST /api/v1/hook-events` (§6.8). */
  async ingest(event: HookEvent): Promise<IngestOutcome> {
    return this.#serialize(event.runtimeSessionId, async () => this.#ingest(event));
  }

  async #ingest(event: HookEvent): Promise<IngestOutcome> {
    const at = event.occurredAt ?? this.#now();
    const transcriptPath = this.#transcriptPathFor(event);

    const outcome = await this.#outbox.run<IngestOutcome>(async (ctx) => {
      const bound = await bindObservedSession(ctx.tx, {
        runtimeSessionId: event.runtimeSessionId,
        workingDirectory: event.cwd,
        transcriptPath,
      });

      if (isObservationClosed(bound.session.state)) {
        // "Stop observing" already happened (user `end`, a `SessionEnd`, or archival). Accept
        // the POST and do nothing — a 4xx here would surface as a hook failure in the
        // operator's own terminal for a condition that is entirely normal.
        return {
          sessionId: bound.session.id,
          created: false,
          attached: false,
          messageId: null,
          deduplicated: false,
          ignored: true,
        };
      }

      let attached = false;
      if (bound.session.state === 'created') {
        // TDS 02 §5.2: `created -> running` for an observed Session is **system-only** — there
        // is no user `start`, and "confirmed attach" means the ingest pipeline is bound.
        await this.#stateMachine.transition(
          {
            sessionId: bound.session.id,
            to: 'running',
            trigger: 'system',
            action: 'system',
            at,
            runtime: {
              runtimeSessionId: event.runtimeSessionId,
              ...(transcriptPath === null ? {} : { transcriptPath }),
            },
          },
          ctx,
        );
        attached = true;
      } else if (transcriptPath !== null && bound.session.transcriptPath !== transcriptPath) {
        await updateSession(ctx.tx, bound.session.id, { transcriptPath });
      }

      const appended = await this.#appendHookMessage(event, bound.session.id, at, ctx);

      if (event.hookEventName === 'SessionEnd') {
        // §5.2: `running -> completed` (system) on the `SessionEnd` hook. The staleness
        // fallback for a session that dies without one is a separate sweep, not this path.
        await this.#stateMachine.transition(
          {
            sessionId: bound.session.id,
            to: 'completed',
            trigger: 'system',
            action: 'end',
            at,
          },
          ctx,
        );
      }

      return {
        sessionId: bound.session.id,
        created: bound.created,
        attached,
        messageId: appended.messageId,
        deduplicated: appended.deduplicated,
        ignored: false,
      };
    });

    this.#scheduleTail(outcome, event.hookEventName, transcriptPath);
    return outcome;
  }

  async #appendHookMessage(
    event: HookEvent,
    sessionId: string,
    at: Date,
    ctx: OutboxTransaction,
  ): Promise<{ messageId: string | null; deduplicated: boolean }> {
    const message = hookMessageFor(event);
    if (message === null) return { messageId: null, deduplicated: false };

    const result = await this.#messages.append(
      {
        sessionId,
        role: message.role,
        content: message.content,
        toolName: message.toolName,
        toolUseId: message.toolUseId,
        toolPayload: message.toolPayload,
        toolFilePath: message.toolFilePath,
        // The synthesized `hook:…` key is a pure function of the request body, so a retried
        // POST produces the identical key and collapses (TDS 03 §3.11).
        runtimeMessageId: runtimeMessageIdFor(event),
        occurredAt: at,
      },
      ctx,
    );

    return {
      messageId: result.message?.id ?? null,
      deduplicated: result.deduplicated,
    };
  }

  /**
   * Hand the transcript path to the tailer — **after** the transaction, and without awaiting.
   *
   * This is the whole of the fast-ACK promise (§6.1's < 50 ms budget): the hook response does
   * not wait on a file open, a stat, a read or a parse, and a transcript that is missing,
   * locked or gibberish cannot delay somebody's terminal by a millisecond.
   */
  #scheduleTail(
    outcome: IngestOutcome,
    hookEventName: HookEvent['hookEventName'],
    transcriptPath: string | null,
  ): void {
    const tailer = this.#tailer;
    if (tailer === null) return;

    if (outcome.ignored || hookEventName === 'SessionEnd') {
      void tailer.detach(outcome.sessionId).catch((error: unknown) => {
        this.#onError?.(error, outcome.sessionId);
      });
      return;
    }

    if (transcriptPath === null) return;

    void tailer.attach({ sessionId: outcome.sessionId, transcriptPath }).catch((error: unknown) => {
      this.#onError?.(error, outcome.sessionId);
    });
  }

  /**
   * The hook payload's own `transcript_path`, falling back to the computed encoded-cwd path
   * (TDS 02 §6.3). The fallback is what keeps the fidelity channel alive for a runtime version
   * that stops sending the field.
   */
  #transcriptPathFor(event: HookEvent): string | null {
    if (event.transcriptPath !== null) return event.transcriptPath;
    if (event.cwd === null) return null;
    return computeTranscriptPath(event.cwd, event.runtimeSessionId);
  }

  // ------------------------------------------------------------- TranscriptSink (§6.3)

  /**
   * Persist one transcript record.
   *
   * Serialized on the same per-session chain as hook events, so the two observation channels
   * never contend for the Session row lock. Both converge on `MessageService.append`, which
   * means both converge on one row through `(session_id, runtime_message_id)` — exactly one
   * transaction derives the A13 title and the loser of the race is a no-op (§6.8).
   */
  async append(sessionId: string, record: TranscriptRecord): Promise<void> {
    await this.#serialize(sessionId, async () => {
      await this.#messages.append({
        sessionId,
        role: record.role,
        content: record.content,
        contentBlocks: record.contentBlocks,
        model: record.model,
        toolName: record.toolName,
        toolUseId: record.toolUseId,
        toolPayload: record.toolPayload,
        toolFilePath: record.toolFilePath,
        runtimeMessageId: record.runtimeMessageId,
        ...(record.occurredAt === null ? {} : { occurredAt: record.occurredAt }),
      });
    });
  }

  async isObservable(sessionId: string): Promise<boolean> {
    const session = await findSessionById(this.#db, sessionId);
    if (session === null) return false;
    return !isObservationClosed(session.state);
  }

  /**
   * Resolve once every ingest accepted so far has finished.
   *
   * Called on shutdown: a hook POST that has already been answered `204` still owes its
   * transaction, and letting the pool close underneath it would turn a clean stop into a lost
   * Message. Not a lock — work accepted after this call is not waited for.
   */
  async drain(): Promise<void> {
    await Promise.all(
      [...this.#chains.values()].map(async (chain) => chain.catch(() => undefined)),
    );
  }

  #serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    // `then(work, work)` rather than `then(work)`: a failed ingest must not poison the chain
    // and strand every later event for that session behind a rejected promise.
    const result = previous.then(work, work);

    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(key, settled);

    // Drop the entry once it is the tail, so the map does not grow one key per runtime session
    // id for the lifetime of the process.
    void settled.then(() => {
      if (this.#chains.get(key) === settled) this.#chains.delete(key);
    });

    return result;
  }
}
