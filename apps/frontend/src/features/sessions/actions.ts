import type { Session } from '../../lib/api/index.js';

/**
 * The state-legal action predicate (TDS 05 §6.6, TDS 06 §5.5) — **one implementation**.
 *
 * §9.4 requires the `Ctrl+K` palette to derive its lifecycle candidates "from the cached
 * Session's F7 state using the same predicate as §6.6". The header, the list-row overflow
 * menu and the palette therefore all call into this file; a second copy would inevitably be
 * the one that offers an illegal transition.
 *
 * Two rules are structural rather than cosmetic:
 *
 *  - **`stop` is not a lifecycle action.** It maps to `POST /sessions/{id}/interrupt`
 *    (§6.3.1), performs no F7 transition and emits no `session.state_changed`. It occupies
 *    `pause`'s slot while a turn is in flight and vanishes when the turn ends.
 *  - **Observed Sessions never render Pause or Resume.** Mission Control does not own the
 *    process (WS1 §5.2) and the API answers `OPERATION_NOT_SUPPORTED`. Their one lifecycle
 *    action is `Stop observing`, which is `end` on the wire and stops *recording*, not the
 *    operator's terminal.
 */

export type SessionActionId =
  | 'start'
  | 'pause'
  | 'stop'
  | 'resume'
  | 'resume-new'
  | 'end'
  | 'archive'
  | 'clone'
  | 'stop-observing';

export interface ConfirmCopy {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

export interface SessionActionDescriptor {
  readonly id: SessionActionId;
  readonly label: string;
  /** Tooltip. Present wherever the label alone could be misread as something bigger. */
  readonly hint?: string;
  readonly emphasis: 'primary' | 'secondary' | 'warning';
  /** `undefined` = no confirmation step (§6.8: stopping a turn is cheap and non-destructive). */
  readonly confirm?: ConfirmCopy;
}

/** The wire sub-action for a descriptor — several UI actions share one endpoint. */
export function endpointActionOf(
  id: SessionActionId,
): 'start' | 'pause' | 'resume' | 'end' | 'archive' | 'clone' | 'interrupt' {
  switch (id) {
    case 'stop':
      return 'interrupt';
    case 'stop-observing':
      // §6.3 / WS1 §5.2: `end` **is** supported for observed Sessions and means exactly
      // "stop observing" — it detaches ingest and never signals the operator's process.
      return 'end';
    case 'resume-new':
      return 'resume';
    default:
      return id;
  }
}

const STOP_OBSERVING_CONFIRM: ConfirmCopy = {
  title: 'Stop observing this session?',
  // Verbatim from TDS 06 §5.5. The operator must not be able to read this dialog as an
  // offer to kill their terminal — it is the single most misreadable action in the product.
  body: 'Mission Control will stop recording this session. The Claude Code session in your terminal keeps running.',
  confirmLabel: 'Stop observing',
  destructive: false,
};

const END_CONFIRM: ConfirmCopy = {
  title: 'End this session?',
  body: 'The runtime is disposed and the Session moves to completed. Its transcript, commits and cost are kept.',
  confirmLabel: 'End session',
  destructive: true,
};

const ARCHIVE_CONFIRM: ConfirmCopy = {
  title: 'Archive this session?',
  body: 'Archiving is retention housekeeping. You can still resume it as a new Session or export it afterwards.',
  confirmLabel: 'Archive',
  destructive: false,
};

/**
 * The actions that belong in the header's action row, in render order.
 *
 * `turnInFlight` is the §6.8 replacement switch: one control slot, two meanings, never both
 * visible. `[Stop]` ends the *turn*; `[Pause]` ends the *process*.
 */
export function headerActions(
  session: Pick<Session, 'state' | 'sessionType'>,
  turnInFlight: boolean,
): readonly SessionActionDescriptor[] {
  if (session.sessionType === 'observed') {
    // §5.5: "The single header action is [Stop observing]". Archive stays available from the
    // overflow menu once the Session is terminal.
    return session.state === 'running' || session.state === 'paused'
      ? [
          {
            id: 'stop-observing',
            label: 'Stop observing',
            hint: 'Detach Mission Control · your terminal session keeps running',
            emphasis: 'secondary',
            confirm: STOP_OBSERVING_CONFIRM,
          },
        ]
      : [];
  }

  switch (session.state) {
    case 'created':
      return [
        {
          id: 'start',
          label: 'Start',
          hint: 'Start the runtime with no prompt · you can also just type one below',
          emphasis: 'primary',
        },
      ];

    case 'running':
      return [
        turnInFlight
          ? {
              id: 'stop',
              label: 'Stop',
              // §6.8's tooltip, verbatim in intent: the whole point of the control is that it
              // is NOT the process-level one sitting in the same slot a moment earlier.
              hint: 'Stop the current turn · the session stays running',
              emphasis: 'warning',
            }
          : {
              id: 'pause',
              label: 'Pause',
              hint: 'Pause the session · the runtime is disposed until you resume',
              emphasis: 'secondary',
            },
        { id: 'end', label: 'End', emphasis: 'secondary', confirm: END_CONFIRM },
      ];

    case 'paused':
      return [
        { id: 'resume', label: 'Resume', emphasis: 'primary' },
        { id: 'end', label: 'End', emphasis: 'secondary', confirm: END_CONFIRM },
      ];

    // Terminal states put everything in the overflow menu (§5.5's composer table: "[⋯] menu
    // only") — the completion / failure bar carries the primary affordance instead.
    default:
      return [];
  }
}

/**
 * The `⋯` overflow menu, and the palette's candidate list.
 *
 * `Export` and `Generate Context Package` are named by §5.5 and are **deliberately absent**:
 * `POST /sessions/{id}/export` and `/context-package` are not served by this Backend yet, and
 * a menu entry that 404s is worse than one that is honestly missing.
 */
export function overflowActions(
  session: Pick<Session, 'state' | 'sessionType' | 'runtime'>,
): readonly SessionActionDescriptor[] {
  const actions: SessionActionDescriptor[] = [];

  // F7 permits resume from completed / failed / archived, and it always creates a NEW Session
  // linked by `resumedFromSessionId` — hence the label. The old record never reopens.
  if (session.state === 'completed' || session.state === 'failed' || session.state === 'archived') {
    actions.push({
      id: 'resume-new',
      label: 'Resume as new session',
      hint: 'Creates a new Session linked to this one · this record stays as it is',
      emphasis: 'primary',
    });
  }

  // §6.3: clone needs a `runtimeSessionId` and is refused from `archived`.
  if (session.state !== 'archived' && session.runtime.runtimeSessionId !== null) {
    actions.push({ id: 'clone', label: 'Clone', emphasis: 'secondary' });
  }

  if (session.state === 'completed' || session.state === 'failed') {
    actions.push({
      id: 'archive',
      label: 'Archive',
      emphasis: 'secondary',
      confirm: ARCHIVE_CONFIRM,
    });
  }

  return actions;
}

/** Header + overflow, for surfaces with one flat list (the list row menu, the palette). */
export function allSessionActions(
  session: Pick<Session, 'state' | 'sessionType' | 'runtime'>,
  turnInFlight = false,
): readonly SessionActionDescriptor[] {
  return [...headerActions(session, turnInFlight), ...overflowActions(session)];
}

// -------------------------------------------------------------------------- composer (§6.6)

/**
 * What occupies the composer slot. Derived **strictly** from canonical Session state (F7)
 * plus session type — never from a local flag, so a `running → failed` crash flips the
 * composer to the failure banner with no user action (§6.6).
 */
export type ComposerMode =
  /** `created` — enabled; submitting is start-with-prompt. */
  | 'start-with-prompt'
  /** `running` — enabled; typing stays allowed while a turn streams (§6.8). */
  | 'prompt'
  /** `paused` — disabled with a hint; no client-side queueing. */
  | 'paused'
  | 'completed'
  | 'failed'
  | 'archived'
  /** Observed Sessions are monitor-only in V1: the bar replaces the composer entirely. */
  | 'observed';

export function composerMode(session: Pick<Session, 'state' | 'sessionType'>): ComposerMode {
  if (session.sessionType === 'observed') return 'observed';
  switch (session.state) {
    case 'created':
      return 'start-with-prompt';
    case 'running':
      return 'prompt';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'archived':
      return 'archived';
  }
}

/** True only where the operator may type. `paused` is disabled *by policy*, not by accident. */
export function isComposerEnabled(mode: ComposerMode): boolean {
  return mode === 'start-with-prompt' || mode === 'prompt';
}

export function composerPlaceholder(mode: ComposerMode): string {
  return mode === 'start-with-prompt'
    ? 'Send a prompt to start this session'
    : 'Type a prompt… Ctrl+Enter to send';
}
