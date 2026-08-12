import { describe, expect, it, vi } from 'vitest';
import { chordOf, isTextEntryTarget, KeyboardRegistry, SEQUENCE_TIMEOUT_MS } from './registry.js';

/**
 * Keyboard dispatch (TDS 05 §9.4, TDS 06 §4.6/§7.3).
 *
 * The suppression rule is the one with teeth: without it, typing "generate the docs" into a
 * composer navigates to ADRs on the `g`, and typing "n" into a filter box opens a New
 * Session modal. It is asserted here for single keys, for sequences and for chords.
 */

interface FakeKeyInit {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly target?: unknown;
}

function keyEvent(init: FakeKeyInit): KeyboardEvent {
  const preventDefault = vi.fn();
  return {
    key: init.key,
    code: init.code ?? (init.key.length === 1 ? `Key${init.key.toUpperCase()}` : init.key),
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: init.target ?? { tagName: 'DIV' },
    preventDefault,
  } as unknown as KeyboardEvent;
}

const TEXT_INPUT = { tagName: 'INPUT', isContentEditable: false, getAttribute: () => null };
const TEXTAREA = { tagName: 'TEXTAREA', isContentEditable: false, getAttribute: () => null };
const EDITABLE = { tagName: 'DIV', isContentEditable: true, getAttribute: () => null };

describe('chordOf', () => {
  it('folds Cmd into Ctrl so one registration covers both platforms', () => {
    expect(chordOf(keyEvent({ key: 'k', ctrlKey: true }))).toBe('Ctrl+K');
    expect(chordOf(keyEvent({ key: 'k', metaKey: true }))).toBe('Ctrl+K');
  });

  it('reads Alt+digit and Alt+bracket from event.code, not event.key', () => {
    // With Alt held, several layouts rewrite `key` into a symbol. `code` is the physical
    // key and is the only thing that makes Alt+1…9 work outside a US keyboard.
    expect(chordOf(keyEvent({ key: '¡', code: 'Digit1', altKey: true }))).toBe('Alt+1');
    expect(chordOf(keyEvent({ key: '“', code: 'BracketLeft', altKey: true }))).toBe('Alt+[');
    expect(chordOf(keyEvent({ key: '‘', code: 'BracketRight', altKey: true }))).toBe('Alt+]');
  });

  it('keeps bare punctuation as itself', () => {
    expect(chordOf(keyEvent({ key: '/', code: 'Slash' }))).toBe('/');
    expect(chordOf(keyEvent({ key: '?', code: 'Slash', shiftKey: true }))).toBe('?');
    expect(chordOf(keyEvent({ key: 'Escape' }))).toBe('Escape');
  });

  it('ignores bare modifier presses', () => {
    expect(chordOf(keyEvent({ key: 'Control', ctrlKey: true }))).toBe('');
  });
});

describe('isTextEntryTarget', () => {
  it('recognises inputs, textareas, selects, contenteditable and ARIA text roles', () => {
    expect(isTextEntryTarget(TEXT_INPUT as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget(TEXTAREA as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget(EDITABLE as unknown as EventTarget)).toBe(true);
    expect(
      isTextEntryTarget({
        tagName: 'DIV',
        getAttribute: () => 'textbox',
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isTextEntryTarget({ tagName: 'DIV', getAttribute: () => null } as unknown as EventTarget),
    ).toBe(false);
  });
});

describe('dispatch', () => {
  it('fires a matching chord and preventDefaults by default', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({ id: 'palette', keys: 'Ctrl+K', label: 'Palette', scope: 'global', run });

    const event = keyEvent({ key: 'k', ctrlKey: true });
    const result = registry.handle(event);

    expect(result.handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('honours an availability predicate', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({
      id: 'stop',
      keys: 'Escape',
      label: 'Stop turn',
      scope: 'conversation',
      when: () => false,
      run,
    });
    expect(registry.handle(keyEvent({ key: 'Escape' })).handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('unregisters on release, so bindings die with their route', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    const release = registry.register({ id: 'n', keys: 'n', label: 'New', scope: 'lists', run });
    release();
    expect(registry.handle(keyEvent({ key: 'n' })).handled).toBe(false);
  });
});

describe('two-key sequences (`g d`)', () => {
  it('arms on the prefix and fires on completion', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({ id: 'gd', keys: 'g d', label: 'Go to Dashboard', scope: 'global', run });

    expect(registry.handle(keyEvent({ key: 'g' })).handled).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(registry.handle(keyEvent({ key: 'd' })).handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('consumes a dead sequence rather than replaying the second key on its own', () => {
    const registry = new KeyboardRegistry();
    const goDashboard = vi.fn();
    const newItem = vi.fn();
    registry.register({
      id: 'gd',
      keys: 'g d',
      label: 'Dashboard',
      scope: 'global',
      run: goDashboard,
    });
    registry.register({ id: 'n', keys: 'n', label: 'New', scope: 'lists', run: newItem });

    registry.handle(keyEvent({ key: 'g' }));
    registry.handle(keyEvent({ key: 'n' }));

    expect(goDashboard).not.toHaveBeenCalled();
    // `g` then `n` must not mean "new"; the operator was mid-sequence.
    expect(newItem).not.toHaveBeenCalled();
  });

  it('forgets the prefix after the timeout', () => {
    let now = 0;
    const registry = new KeyboardRegistry(() => now);
    const run = vi.fn();
    registry.register({ id: 'gd', keys: 'g d', label: 'Dashboard', scope: 'global', run });

    registry.handle(keyEvent({ key: 'g' }));
    now += SEQUENCE_TIMEOUT_MS + 1;
    registry.handle(keyEvent({ key: 'd' }));

    expect(run).not.toHaveBeenCalled();
  });
});

describe('text-entry suppression (§9.4 — the rule with teeth)', () => {
  it('suppresses single-key shortcuts inside an input', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({ id: 'search', keys: '/', label: 'Search', scope: 'global', run });

    const result = registry.handle(keyEvent({ key: '/', code: 'Slash', target: TEXT_INPUT }));

    expect(run).not.toHaveBeenCalled();
    expect(result.handled).toBe(false);
    expect(result.suppressed).toBe(true);
  });

  it('suppresses chords inside a textarea — a modifier does not make it safe', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({ id: 'palette', keys: 'Ctrl+K', label: 'Palette', scope: 'global', run });

    registry.handle(keyEvent({ key: 'k', ctrlKey: true, target: TEXTAREA }));
    expect(run).not.toHaveBeenCalled();
  });

  it('never arms a `g …` sequence inside a composer', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({ id: 'gd', keys: 'g d', label: 'Dashboard', scope: 'global', run });

    registry.handle(keyEvent({ key: 'g', target: TEXTAREA }));
    // The `d` is typed, not dispatched — the sequence was never armed.
    registry.handle(keyEvent({ key: 'd', target: TEXTAREA }));
    expect(run).not.toHaveBeenCalled();
  });

  it('suppresses inside contenteditable too', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({ id: 'n', keys: 'n', label: 'New', scope: 'lists', run });
    registry.handle(keyEvent({ key: 'n', target: EDITABLE }));
    expect(run).not.toHaveBeenCalled();
  });

  it('lets Escape through — one of exactly two exceptions', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({
      id: 'escape',
      keys: 'Escape',
      label: 'Step out',
      scope: 'global',
      allowInTextEntry: true,
      run,
    });
    expect(registry.handle(keyEvent({ key: 'Escape', target: TEXTAREA })).handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lets Ctrl+Enter through — the send binding, the other exception', () => {
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({
      id: 'send',
      keys: 'Ctrl+Enter',
      label: 'Send prompt',
      scope: 'composer',
      allowInTextEntry: true,
      run,
    });
    expect(
      registry.handle(keyEvent({ key: 'Enter', ctrlKey: true, target: TEXTAREA })).handled,
    ).toBe(true);
  });

  it('refuses to honour allowInTextEntry on anything outside the two-binding allowlist', () => {
    // A binding cannot opt itself out of the rule: the allowlist is the rule.
    const registry = new KeyboardRegistry();
    const run = vi.fn();
    registry.register({
      id: 'sneaky',
      keys: 'Ctrl+K',
      label: 'Palette',
      scope: 'global',
      allowInTextEntry: true,
      run,
    });
    registry.handle(keyEvent({ key: 'k', ctrlKey: true, target: TEXT_INPUT }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('list()', () => {
  it('enumerates available bindings for the cheat sheet and hides unavailable ones', () => {
    const registry = new KeyboardRegistry();
    registry.register({
      id: 'a',
      keys: 'Ctrl+K',
      label: 'Palette',
      scope: 'global',
      run: () => {},
    });
    registry.register({
      id: 'b',
      keys: 'Escape',
      label: 'Stop turn',
      scope: 'conversation',
      when: () => false,
      run: () => {},
    });
    expect(registry.list().map((binding) => binding.id)).toEqual(['a']);
  });
});
