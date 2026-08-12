/**
 * Keyboard dispatch (TDS 05 §9.4; vocabulary from TDS 06 §4.6).
 *
 * One document-level `keydown` listener lives in `AppShell`; every binding registers here
 * with metadata (label, scope, availability), so the `?` cheat sheet and the `Ctrl+K`
 * palette can *enumerate* bindings rather than duplicating a hard-coded list, and there is
 * exactly one place to audit conflicts.
 *
 * Two corrections from §9.4 are implemented literally, because both are cases where the
 * obvious binding is silently dead or actively harmful:
 *
 *  - **`Ctrl+1…9` is browser-reserved.** Chrome and Edge consume it for tab switching at
 *    the browser-chrome level and never deliver the event to page JavaScript. Session
 *    switching therefore binds **`Alt+1…9`**, plus `Alt+[` / `Alt+]`.
 *  - **Text-entry suppression.** While focus is inside an `input`, `textarea`, `select` or
 *    `contenteditable`, *all* single-key and chord shortcuts are suppressed, with exactly
 *    two exceptions: `Escape` (blur / step-out) and `Ctrl+Enter` (send). This is what stops
 *    an operator typing "generate the docs" into a composer from teleporting to another
 *    page.
 */

export type KeyScope = 'global' | 'lists' | 'tables' | 'composer' | 'conversation' | 'settings';

export interface KeyBinding {
  /** Stable id; re-registering the same id replaces the previous binding. */
  readonly id: string;
  /** Normalised chord or two-key sequence: `Ctrl+K`, `Alt+1`, `g d`, `/`, `?`, `Escape`. */
  readonly keys: string;
  /** Human label for the cheat sheet and the palette. */
  readonly label: string;
  readonly scope: KeyScope;
  readonly run: (event: KeyboardEvent) => void;
  /** Availability predicate — an unavailable binding is neither fired nor advertised. */
  readonly when?: () => boolean;
  /**
   * Escape hatch from the suppression rule. Only `Escape` and the send binding may set it
   * (§9.4); anything else that does is a review failure.
   */
  readonly allowInTextEntry?: boolean;
  /** Default true. `Ctrl+K` in particular must preventDefault to stop the address bar. */
  readonly preventDefault?: boolean;
}

/** How long a `g …` sequence prefix stays armed before it is forgotten. */
export const SEQUENCE_TIMEOUT_MS = 1_500;

/** The two bindings that survive text entry (§9.4). */
const TEXT_ENTRY_ALLOWLIST = new Set(['Escape', 'Ctrl+Enter']);

/**
 * True when the event originated inside a text-entry surface.
 *
 * `select` is included beyond §9.4's literal list of input/textarea/contenteditable: a
 * native select consumes letter keys to jump between options, so a global `n` firing there
 * would be the same class of bug. Adding it only ever suppresses more, so it cannot
 * violate the rule it extends.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || !(typeof target === 'object')) return false;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
  };

  if (element.isContentEditable === true) return true;

  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;

  const role = element.getAttribute?.('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/**
 * Normalise a keyboard event to a chord string.
 *
 * Digits and brackets are read from `event.code`, not `event.key`: with Alt held, several
 * layouts (and macOS in general) rewrite `key` into a symbol, so `Alt+1` would arrive as
 * `Alt+¡`. `code` is the physical key and is layout-stable, which is the only way an
 * `Alt+1…9` binding works outside a US keyboard.
 */
export function chordOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  // Cmd on macOS is folded into Ctrl so a single `Ctrl+K` registration covers both.
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');

  const base = baseKeyOf(event);
  if (base === null) return '';

  // Shift is only meaningful when it did not already change the character (`?` is Shift+/).
  if (event.shiftKey && (parts.length > 0 || base.length > 1)) parts.push('Shift');

  parts.push(base);
  return parts.join('+');
}

function baseKeyOf(event: KeyboardEvent): string | null {
  const code = event.code;
  if (/^Digit[1-9]$/.test(code)) return code.slice(5);
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';

  const key = event.key;
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null;
  if (key === ' ') return 'Space';
  if (key.length === 1) {
    // Letters normalise to upper case so `Ctrl+K` and `Ctrl+k` are one binding, while a
    // bare letter stays lower case so `g` and `G` remain distinguishable in sequences.
    return event.ctrlKey || event.metaKey || event.altKey ? key.toUpperCase() : key;
  }
  return key;
}

export interface DispatchResult {
  readonly handled: boolean;
  /** The chord/sequence that matched, for diagnostics and tests. */
  readonly matched: string | null;
  /** True when the event was dropped by the text-entry rule. */
  readonly suppressed: boolean;
}

export class KeyboardRegistry {
  readonly #bindings = new Map<string, KeyBinding>();
  #pendingPrefix: string | null = null;
  #pendingSince = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  register(binding: KeyBinding): () => void {
    this.#bindings.set(binding.id, binding);
    return () => {
      if (this.#bindings.get(binding.id) === binding) this.#bindings.delete(binding.id);
    };
  }

  /** All currently-available bindings, for the cheat sheet and the palette. */
  list(): readonly KeyBinding[] {
    return [...this.#bindings.values()].filter((binding) => binding.when?.() !== false);
  }

  clear(): void {
    this.#bindings.clear();
    this.#pendingPrefix = null;
  }

  /**
   * Dispatch one event. Returns what happened rather than a bare boolean so the suppression
   * rule is directly assertable in a test — "did nothing" and "was deliberately ignored"
   * are different outcomes and only one of them is correct inside a composer.
   */
  handle(event: KeyboardEvent): DispatchResult {
    const chord = chordOf(event);
    if (chord === '') return { handled: false, matched: null, suppressed: false };

    const inTextEntry = isTextEntryTarget(event.target);

    // Sequence continuation, e.g. `g` then `d`.
    if (this.#pendingPrefix !== null) {
      if (this.#now() - this.#pendingSince > SEQUENCE_TIMEOUT_MS) {
        this.#pendingPrefix = null;
      } else {
        const sequence = `${this.#pendingPrefix} ${chord}`;
        this.#pendingPrefix = null;
        const binding = this.#find(sequence, inTextEntry);
        if (binding !== null) return this.#fire(binding, event, sequence);
        // A sequence that went nowhere is consumed, not replayed as a fresh single key —
        // `g` then `x` must not trigger whatever `x` does on its own.
        return { handled: false, matched: null, suppressed: inTextEntry };
      }
    }

    const binding = this.#find(chord, inTextEntry);
    if (binding !== null) return this.#fire(binding, event, chord);

    if (!inTextEntry && this.#isSequencePrefix(chord)) {
      this.#pendingPrefix = chord;
      this.#pendingSince = this.#now();
      event.preventDefault();
      return { handled: true, matched: null, suppressed: false };
    }

    return { handled: false, matched: null, suppressed: inTextEntry && this.#exists(chord) };
  }

  #find(keys: string, inTextEntry: boolean): KeyBinding | null {
    for (const binding of this.#bindings.values()) {
      if (binding.keys !== keys) continue;
      if (binding.when?.() === false) continue;
      if (inTextEntry && !(binding.allowInTextEntry === true && TEXT_ENTRY_ALLOWLIST.has(keys))) {
        continue;
      }
      return binding;
    }
    return null;
  }

  #exists(keys: string): boolean {
    for (const binding of this.#bindings.values()) {
      if (binding.keys === keys) return true;
    }
    return false;
  }

  #isSequencePrefix(chord: string): boolean {
    const prefix = `${chord} `;
    for (const binding of this.#bindings.values()) {
      if (binding.keys.startsWith(prefix) && binding.when?.() !== false) return true;
    }
    return false;
  }

  #fire(binding: KeyBinding, event: KeyboardEvent, matched: string): DispatchResult {
    if (binding.preventDefault !== false) event.preventDefault();
    binding.run(event);
    return { handled: true, matched, suppressed: false };
  }
}

/** Render a binding's keys for the cheat sheet: `Ctrl+K`, `g d`, `Alt+1`. */
export function formatKeys(keys: string): string {
  return keys;
}
