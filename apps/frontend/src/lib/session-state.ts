import type { SessionState } from '@mc/shared/types';

/**
 * The single mapping from an F7 Session state to its presentation.
 *
 * TDS 05 §9.1: "StatusBadge maps a Session's state string (F7, lowercase) directly to
 * `--color-state-<state>` — one source of truth for state colour across list rows, the
 * active-sessions strip, the Live Session tab bar, timeline, and dashboard widgets."
 *
 * The glyph is NOT decoration. Colour is never the only channel (TDS 06 §2.1.6): the
 * densest surfaces — session tabs, mobile chips, the sidebar strip — have no room for a
 * state word, so shape carries the meaning wherever the label is absent, and the verbatim
 * F7 state name is exposed through `aria-label` and `title`. Never a synonym: `paused`,
 * never "suspended" (F9.5).
 */
export interface SessionStatePresentation {
  /** Verbatim F7 state name — used as the badge label, `aria-label` and `title`. */
  readonly label: SessionState;
  /** Mandatory in every dot-without-adjacent-label context. */
  readonly glyph: string;
  /** Full-strength colour: badge text, dot fill. */
  readonly colorVar: `--color-state-${SessionState}`;
  /** Tinted ground the badge pairs with the full-strength colour. */
  readonly subtleVar: `--color-state-${SessionState}-subtle`;
  /** `running` is the only pulsing state, and it degrades to static under reduced motion. */
  readonly pulses: boolean;
}

const PRESENTATION: Readonly<Record<SessionState, SessionStatePresentation>> = Object.freeze({
  created: {
    label: 'created',
    glyph: '○',
    colorVar: '--color-state-created',
    subtleVar: '--color-state-created-subtle',
    pulses: false,
  },
  running: {
    label: 'running',
    glyph: '▶',
    colorVar: '--color-state-running',
    subtleVar: '--color-state-running-subtle',
    pulses: true,
  },
  paused: {
    label: 'paused',
    glyph: '‖',
    colorVar: '--color-state-paused',
    subtleVar: '--color-state-paused-subtle',
    pulses: false,
  },
  completed: {
    label: 'completed',
    glyph: '✓',
    colorVar: '--color-state-completed',
    subtleVar: '--color-state-completed-subtle',
    pulses: false,
  },
  failed: {
    label: 'failed',
    glyph: '✕',
    colorVar: '--color-state-failed',
    subtleVar: '--color-state-failed-subtle',
    pulses: false,
  },
  archived: {
    label: 'archived',
    glyph: '▣',
    colorVar: '--color-state-archived',
    subtleVar: '--color-state-archived-subtle',
    pulses: false,
  },
});

export function sessionStatePresentation(state: SessionState): SessionStatePresentation {
  return PRESENTATION[state];
}
