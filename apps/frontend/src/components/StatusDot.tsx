import type { SessionState } from '@mc/shared/types';
import { sessionStatePresentation } from '../lib/session-state.js';

/**
 * The glyph-bearing state dot (TDS 06 §2.5 StatusDot, §2.1.6).
 *
 * **The glyph is mandatory.** A dot may appear without an adjacent text label — session
 * tabs, the open-sessions strip, mobile chips have no room for a state word — but never
 * without its glyph plus an `aria-label` / `title` carrying the verbatim F7 state name.
 * Shape is what carries the meaning where the label is absent, and it is the channel that
 * survives every form of colour blindness alongside the `running` pulse.
 *
 * `muted` implements the §3.3 degraded-liveness rule: when the connection chip is not
 * `live` the pulse is suspended (the glyph is retained) and the mark drops to reduced
 * emphasis, because a pulsing dot on a dead socket is an animation asserting a fact the
 * client cannot check.
 */
export function StatusDot({
  state,
  muted = false,
  size = 10,
}: {
  state: SessionState;
  muted?: boolean;
  size?: number;
}) {
  const { label, glyph, colorVar, subtleVar, pulses } = sessionStatePresentation(state);

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${
        pulses && !muted ? 'mc-pulse' : ''
      }`}
      style={{
        width: size,
        height: size,
        backgroundColor: `var(${subtleVar})`,
        color: `var(${colorVar})`,
        border: `1px solid var(${colorVar})`,
        fontSize: Math.max(7, size - 3),
        lineHeight: 1,
        opacity: muted ? 0.6 : 1,
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </span>
  );
}
