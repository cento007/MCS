import { describe, expect, it } from 'vitest';
import { projectMemoryConfiguration } from './queries.js';
import { makeBackfillStatus, makeLegacyBackfillStatus } from './test-support.js';

/**
 * "Is memory configured at all", as a pure function of the backfill document.
 *
 * It used to be a projection of `GET /services/health`, because `GET /memory-items/backfill`
 * genuinely could not answer it: `indexedModels: []` and `rowsFromOtherModels: 0` are what an
 * unconfigured instance reports *and* what a configured instance that has never indexed anything
 * reports. The document now carries `configured` for exactly that reason.
 *
 * The tri-state is the substance. `null` is "cannot tell" and must never render as
 * "not configured" — that is the one wrong answer, because it sends an operator to Settings to
 * fix something that is not broken.
 */

describe('projectMemoryConfiguration', () => {
  it('reports what the document says', () => {
    expect(
      projectMemoryConfiguration(makeBackfillStatus({ configured: true }), false).configured,
    ).toBe(true);
    expect(
      projectMemoryConfiguration(makeBackfillStatus({ configured: false }), false).configured,
    ).toBe(false);
  });

  it('answers `null` when the document could not be read at all', () => {
    expect(projectMemoryConfiguration(undefined, true)).toEqual({
      configured: null,
      runtime: null,
      reason: null,
      isPending: true,
    });
  });

  it('answers `null` — not `false` — when the Backend has no A18 fields yet', () => {
    // The two apps ship separately. `undefined` read as falsy would accuse a perfectly
    // configured instance of being switched off, which is the exact failure this tri-state
    // exists to prevent.
    expect(projectMemoryConfiguration(makeLegacyBackfillStatus(), false)).toMatchObject({
      configured: null,
      runtime: null,
      reason: null,
    });
  });

  it('answers `null` for any non-boolean `configured`', () => {
    const odd = { ...makeBackfillStatus(), configured: 'degraded' as unknown as boolean };

    expect(projectMemoryConfiguration(odd, false).configured).toBeNull();
  });

  it('carries the runtime arm and its sentence — three of the four arms are "configured"', () => {
    // `configured: true` with `runtime: 'unavailable'` is the case a bare boolean flattens: the
    // model is set correctly and Ollama is down, so the fix is the service, not the setting.
    const down = makeBackfillStatus({
      configured: true,
      runtime: 'unavailable',
      runtimeReason: 'Ollama did not answer at http://127.0.0.1:11434',
    });

    expect(projectMemoryConfiguration(down, false)).toEqual({
      configured: true,
      runtime: 'unavailable',
      reason: 'Ollama did not answer at http://127.0.0.1:11434',
      isPending: false,
    });
  });

  it('drops a runtime word it does not know rather than rendering an unmapped state', () => {
    const future = {
      ...makeBackfillStatus(),
      runtime: 'quiesced' as unknown as 'ready',
    };

    // `null` = "cannot tell", which is the neutral copy — never a branch keyed on a word this
    // client cannot explain to an operator.
    expect(projectMemoryConfiguration(future, false).runtime).toBeNull();
  });

  it('passes `isPending` straight through, so nothing is asserted before the read lands', () => {
    expect(projectMemoryConfiguration(undefined, true).isPending).toBe(true);
    expect(projectMemoryConfiguration(makeBackfillStatus(), false).isPending).toBe(false);
  });
});
