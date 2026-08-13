import type { SessionState } from '@mc/shared/types';
import { describe, expect, it } from 'vitest';
import {
  allSessionActions,
  composerMode,
  endpointActionOf,
  headerActions,
  isComposerEnabled,
  isDocumentAction,
  isLifecycleAction,
  overflowActions,
} from './actions.js';
import { makeSession } from './test-support.js';

/**
 * The §6.6 composer × F7 matrix and the §5.5 action sets.
 *
 * Every F7 state is enumerated explicitly rather than sampled: the whole value of a single
 * predicate is that it can be exhaustively checked, and "which states may type" is precisely
 * the question a regression here would answer wrongly and silently.
 */

const ALL_STATES: readonly SessionState[] = [
  'created',
  'running',
  'paused',
  'completed',
  'failed',
  'archived',
];

describe('composerMode — every F7 state (§6.6)', () => {
  it.each([
    ['created', 'start-with-prompt', true],
    ['running', 'prompt', true],
    ['paused', 'paused', false],
    ['completed', 'completed', false],
    ['failed', 'failed', false],
    ['archived', 'archived', false],
  ] as const)('managed %s → %s (enabled: %s)', (state, expected, enabled) => {
    const mode = composerMode(makeSession({ state, sessionType: 'managed' }));
    expect(mode).toBe(expected);
    expect(isComposerEnabled(mode)).toBe(enabled);
  });

  it('observed sessions are monitor-only in every state', () => {
    for (const state of ALL_STATES) {
      const mode = composerMode(makeSession({ state, sessionType: 'observed' }));
      expect(mode).toBe('observed');
      expect(isComposerEnabled(mode)).toBe(false);
    }
  });
});

describe('headerActions — [Stop] replaces [Pause] only in flight (§6.8)', () => {
  it('offers Pause while running with no turn in flight', () => {
    const actions = headerActions(makeSession({ state: 'running' }), false);
    expect(actions.map((action) => action.id)).toEqual(['pause', 'end']);
  });

  it('replaces Pause with Stop while a turn is in flight — one slot, never both', () => {
    const actions = headerActions(makeSession({ state: 'running' }), true);
    expect(actions.map((action) => action.id)).toEqual(['stop', 'end']);
    expect(actions.map((action) => action.id)).not.toContain('pause');
  });

  it('never offers Stop outside `running`', () => {
    for (const state of ALL_STATES) {
      if (state === 'running') continue;
      const actions = headerActions(makeSession({ state }), true);
      expect(actions.map((action) => action.id)).not.toContain('stop');
    }
  });

  it('Stop carries no confirmation — stopping is cheap and speed is the point', () => {
    const stop = headerActions(makeSession({ state: 'running' }), true)[0];
    expect(stop?.id).toBe('stop');
    expect(stop?.confirm).toBeUndefined();
    expect(stop?.hint).toContain('the session stays running');
  });

  it('maps Stop to the interrupt endpoint, which performs no F7 transition', () => {
    expect(endpointActionOf('stop')).toBe('interrupt');
  });

  it('offers Start from `created` and no Archive (F7 has no created → archived edge)', () => {
    const actions = allSessionActions(
      makeSession({
        state: 'created',
        runtime: { ...makeSession().runtime, runtimeSessionId: null },
      }),
    );
    expect(actions.map((action) => action.id)).toEqual(['start']);
  });

  it('puts terminal-state actions in the overflow, not the header', () => {
    expect(headerActions(makeSession({ state: 'completed' }), false)).toEqual([]);
    expect(overflowActions(makeSession({ state: 'completed' })).map((a) => a.id)).toEqual([
      'resume-new',
      'clone',
      'archive',
      'export',
      'context-package',
    ]);
  });

  it('does not offer Clone from `archived` — WS2 restricts it', () => {
    const actions = overflowActions(makeSession({ state: 'archived' })).map((a) => a.id);
    expect(actions).toContain('resume-new');
    expect(actions).not.toContain('clone');
    expect(actions).not.toContain('archive');
  });

  it('offers Resume as new from `failed` (the restart-recovery path)', () => {
    expect(overflowActions(makeSession({ state: 'failed' })).map((a) => a.id)).toContain(
      'resume-new',
    );
  });
});

describe('the §6.7 documents — gated on `created`, not discovered by failing', () => {
  it('offers neither from `created`, because both answer 409 there', () => {
    // The Backend refuses: a Session that never started has no messages, files or commits, so
    // the document would be a header above nine "nothing recorded" sections. A menu entry that
    // is guaranteed to fail is worse than one that is honestly absent.
    const ids = allSessionActions(
      makeSession({
        state: 'created',
        runtime: { ...makeSession().runtime, runtimeSessionId: null },
      }),
    ).map((action) => action.id);
    expect(ids).not.toContain('export');
    expect(ids).not.toContain('context-package');
    expect(ids).toEqual(['start']);
  });

  it.each(['running', 'paused', 'completed', 'failed', 'archived'] as const)(
    'offers both from `%s`',
    (state) => {
      const ids = overflowActions(makeSession({ state })).map((action) => action.id);
      expect(ids).toContain('export');
      expect(ids).toContain('context-package');
    },
  );

  it('offers both on observed sessions too — the transcript is recorded either way', () => {
    const ids = allSessionActions(makeSession({ sessionType: 'observed', state: 'running' })).map(
      (action) => action.id,
    );
    expect(ids).toContain('export');
    expect(ids).toContain('context-package');
  });

  it('classifies them as documents, so no surface can post them to the lifecycle endpoint', () => {
    expect(isDocumentAction('export')).toBe(true);
    expect(isDocumentAction('context-package')).toBe(true);
    expect(isDocumentAction('archive')).toBe(false);

    const lifecycle = overflowActions(makeSession({ state: 'completed' }))
      .filter(isLifecycleAction)
      .map((action) => action.id);
    expect(lifecycle).toEqual(['resume-new', 'clone', 'archive']);
  });

  it('carries no confirm step — neither mutates anything', () => {
    for (const action of overflowActions(makeSession({ state: 'completed' }))) {
      if (!isDocumentAction(action.id)) continue;
      expect(action.confirm).toBeUndefined();
    }
  });
});

describe('observed sessions — the applicability matrix (WS1 §5.2 / §5.5)', () => {
  it('never renders Pause or Resume in any state', () => {
    for (const state of ALL_STATES) {
      const ids = allSessionActions(makeSession({ state, sessionType: 'observed' }), true).map(
        (action) => action.id,
      );
      expect(ids).not.toContain('pause');
      expect(ids).not.toContain('resume');
      expect(ids).not.toContain('start');
      expect(ids).not.toContain('stop');
    }
  });

  it('offers exactly [Stop observing] in the header while the session is live', () => {
    const actions = headerActions(
      makeSession({ sessionType: 'observed', state: 'running' }),
      false,
    );
    expect(actions.map((action) => action.id)).toEqual(['stop-observing']);
  });

  it('states plainly in the confirm copy that the operator’s terminal keeps running', () => {
    const [action] = headerActions(
      makeSession({ sessionType: 'observed', state: 'running' }),
      false,
    );
    expect(action?.confirm?.body).toBe(
      'Mission Control will stop recording this session. The Claude Code session in your terminal keeps running.',
    );
    expect(action?.confirm?.destructive).toBe(false);
  });

  it('sends `end` on the wire — the API spelling of "stop observing"', () => {
    expect(endpointActionOf('stop-observing')).toBe('end');
  });
});
