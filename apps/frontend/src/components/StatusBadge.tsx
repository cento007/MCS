import type { SessionState } from '@mc/shared/types';
import { sessionStatePresentation } from '../lib/session-state.js';

/**
 * The canonical F7 state badge (TDS 06 §2.5 Badge, §2.1.6).
 *
 * Recipe, one for all six states: subtle ground + full-strength colour as text and dot,
 * the state glyph, and the verbatim F7 state name as visible text AND as `aria-label` /
 * `title`. Colour is never the only channel.
 */
export function StatusBadge({ state, muted = false }: { state: SessionState; muted?: boolean }) {
  const { label, glyph, colorVar, subtleVar, pulses } = sessionStatePresentation(state);

  return (
    <span
      title={label}
      className="inline-flex items-center gap-1 rounded-xs px-2 py-05 font-medium text-2xs"
      style={{
        backgroundColor: `var(${subtleVar})`,
        color: `var(${colorVar})`,
        // TDS 06 §3.3: while the socket is not `live`, state marks drop to reduced emphasis
        // rather than continuing to assert a condition nobody can currently verify.
        opacity: muted ? 0.6 : 1,
      }}
    >
      {/* The glyph is hidden from assistive tech HERE because the verbatim state name is
          already visible text beside it. In the glyph-only contexts (session tabs, mobile
          chips, the sidebar strip) the dot itself carries role="img" plus an aria-label
          holding the same verbatim F7 name — TDS 06 §2.1.6. */}
      <span aria-hidden="true">{glyph}</span>
      {label}
      {pulses ? <span className="sr-only"> (active)</span> : null}
    </span>
  );
}
