import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus, Outbox } from '../../events/index.js';
import type { MessageService } from '../messages.js';
import type { SessionStateMachine } from '../state-machine.js';
import { ObservedIngestService } from './ingest.js';
import { isObservationClosed } from './observability.js';
import type { TranscriptTailerPort } from './ports.js';
import { registerObservedRoutes } from './routes.js';
import { DbTailStateStore } from './tail-state.js';
import { TranscriptTailer } from './transcript-tailer.js';

/**
 * `sessions/observed/` — attaching to Claude Code sessions the operator started themselves
 * (F1.5, TDS 02 §6, TDS 04 §6.8–§6.9).
 *
 * Two channels, both Phase 1, and the degradation ladder between them is one-directional:
 *
 *   **hooks + tailer** (full fidelity) -> **hooks only** (lifecycle + tool events, reduced
 *   message detail). There is no third rung back up.
 *
 * Layout:
 *   routes.ts             `POST /api/v1/hook-events` — ingest-scoped bearer, cookie rejected
 *   hook-events.ts        the §6.8 wire format, the dedupe key, hook payload -> Message
 *   ingest.ts             `ObservedIngestService` — bind, attach, append; one transaction
 *   binding.ts            runtime session id -> Session, and who a first-seen Session belongs to
 *   transcript-tailer.ts  `TranscriptTailerPort` — per-file watching, cursor, drift, degradation
 *   transcript-parse.ts   the ONLY module that knows the JSONL format (version-tolerant)
 *   tail-state.ts         `transcript_tail_states` + the degradation transaction
 *   paths.ts              `CLAUDE_CONFIG_DIR`, encoded-cwd transcript paths (both OSes)
 *   tool-files.ts         the five file-naming tools -> `messages.tool_file_path`
 *   hooks-installer.ts    the surgical `.claude/settings.json` writer + backup + state file
 *   observability.ts      when observation is over, derived from F7
 *
 * Three rules the whole directory is arranged around:
 *
 * 1. **Mission Control never owns the process.** `end` means *stop observing* — detach and
 *    close the record. Nothing here signals, kills or throttles the operator's terminal, and
 *    `pause`/`resume`/user-`start` are rejected as `OPERATION_NOT_SUPPORTED` by the domain
 *    (TDS 02 §5.2; enforced in `state-machine.ts` and `service.ts`, tested here).
 * 2. **State changes go through `state-machine.ts`.** Ingest is one of its writers, not an
 *    exception to it. `created -> running` on bind is **system**-triggered.
 * 3. **Degradation is terminal (WS7 arbitration A11).** No re-attach, no
 *    `session.observation_restored`, no retry loop. `transcript_tail_states.degraded` is sticky
 *    across restarts so the badge cannot flap — and because re-attaching cannot recover the
 *    lines already skipped.
 */

export * from './binding.js';
export * from './hook-events.js';
export * from './hooks-installer.js';
export * from './ingest.js';
export * from './observability.js';
export * from './paths.js';
export * from './ports.js';
export * from './routes.js';
export * from './tail-state.js';
export * from './tool-files.js';
export * from './transcript-parse.js';
export * from './transcript-tailer.js';

export interface RegisterObservedIngestOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  /** Subscribed for terminal transitions, so a REST `end` detaches the tailer immediately. */
  readonly bus?: EventBus | undefined;
  readonly messages: MessageService;
  readonly stateMachine: SessionStateMachine;
  readonly driftThreshold?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** `false` disables watchers and timers entirely — the unit tier drives `drain()` itself. */
  readonly watch?: boolean | undefined;
  /** `false` skips the boot reattach sweep (TDS 03 §3.15). */
  readonly resumeOnReady?: boolean | undefined;
  readonly onError?: (error: unknown, sessionId: string) => void;
}

export interface ObservedIngestModule {
  readonly ingest: ObservedIngestService;
  readonly tailer: TranscriptTailerPort;
  readonly tailStates: DbTailStateStore;
}

/**
 * Build the observed-ingest pipeline and register its route.
 *
 * The tailer and the ingest service reference each other on purpose: the service is the
 * tailer's `TranscriptSink` (so both channels converge on `MessageService.append` and therefore
 * on one row per `(session_id, runtime_message_id)`), and the tailer is what the service
 * schedules after a hook arrives.
 */
export function registerObservedIngest(
  app: FastifyInstance,
  options: RegisterObservedIngestOptions,
): ObservedIngestModule {
  const tailStates = new DbTailStateStore({ db: options.db, outbox: options.outbox });

  const ingest = new ObservedIngestService({
    db: options.db,
    outbox: options.outbox,
    messages: options.messages,
    stateMachine: options.stateMachine,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const tailer = new TranscriptTailer({
    store: tailStates,
    sink: ingest,
    ...(options.driftThreshold === undefined ? {} : { driftThreshold: options.driftThreshold }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    onError: (error, sessionId) => {
      options.onError?.(error, sessionId);
      app.log.warn({ err: error, sessionId }, 'transcript tailer error');
    },
    onDegraded: (info) => {
      // Logged at `warn`, not `error`: reduced fidelity is a designed state, not a fault.
      app.log.warn(info, 'observation degraded to hook-only');
    },
  });

  ingest.setTailer(tailer);
  registerObservedRoutes(app, { ingest });

  if (options.bus !== undefined) {
    const unsubscribe = options.bus.on('session.state_changed', (event) => {
      const toState = event.payload['toState'];
      const sessionId = event.payload['sessionId'];
      if (typeof toState !== 'string' || typeof sessionId !== 'string') return;
      if (!isObservationClosed(toState)) return;

      // A REST `end` ("stop observing"), a `SessionEnd` hook, or archival. Let go of the file.
      void tailer.detach(sessionId).catch((error: unknown) => {
        options.onError?.(error, sessionId);
      });
    });
    app.addHook('onClose', async () => {
      unsubscribe();
    });
  }

  if (options.resumeOnReady !== false) {
    app.addHook('onReady', async () => {
      // TDS 03 §3.15: reattach at the persisted byte offset instead of re-ingesting from 0.
      const attached = await tailer.resume();
      if (attached > 0) app.log.info({ attached }, 'resumed transcript tailing');
    });
  }

  app.addHook('onClose', async () => {
    // Stop reading first, then let the transactions already accepted finish: a hook POST that
    // was answered `204` still owes its write, and closing the pool underneath it would turn a
    // clean shutdown into a lost Message.
    await tailer.stop();
    await ingest.drain();
  });

  return { ingest, tailer, tailStates };
}
