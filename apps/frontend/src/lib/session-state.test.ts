import { SESSION_STATES } from '@mc/shared/types';
import { describe, expect, it } from 'vitest';
import { sessionStatePresentation } from './session-state.js';

describe('session state presentation (TDS 05 §9.1 / TDS 06 §2.1.6)', () => {
  it('covers every F7 state — no state can render without a mapping', () => {
    for (const state of SESSION_STATES) {
      expect(() => sessionStatePresentation(state), state).not.toThrow();
      expect(sessionStatePresentation(state)).toBeDefined();
    }
  });

  it('labels each state with its verbatim F7 name, never a synonym', () => {
    for (const state of SESSION_STATES) {
      expect(sessionStatePresentation(state).label).toBe(state);
    }
  });

  it('points every state at its own colour token pair', () => {
    for (const state of SESSION_STATES) {
      const presentation = sessionStatePresentation(state);
      expect(presentation.colorVar).toBe(`--color-state-${state}`);
      expect(presentation.subtleVar).toBe(`--color-state-${state}-subtle`);
    }
  });

  it('gives every state a distinct non-empty glyph — shape is the second channel', () => {
    const glyphs = SESSION_STATES.map((state) => sessionStatePresentation(state).glyph);

    for (const glyph of glyphs) expect(glyph.length).toBeGreaterThan(0);
    expect(new Set(glyphs).size).toBe(SESSION_STATES.length);
  });

  it('pulses `running` and nothing else', () => {
    const pulsing = SESSION_STATES.filter((state) => sessionStatePresentation(state).pulses);
    expect(pulsing).toEqual(['running']);
  });
});
