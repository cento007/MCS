import { describe, expect, it } from 'vitest';
import {
  adjacentOpenSession,
  MAX_OPEN_SESSIONS,
  openSessionAt,
  uiPersistStorage,
  useUiStore,
} from './ui-store.js';

/**
 * The open session set (TDS 05 §6.5, TDS 06 §3.4).
 *
 * One ordered list, two switcher surfaces, `localStorage`-persisted so it survives reload.
 * The rules that carry risk are the cap, the eviction choice, and the guarantee that
 * closing an entry is a statement about attention and never about Session state.
 */

function open(
  id: string,
  options?: Parameters<ReturnType<typeof useUiStore.getState>['openSession']>[1],
) {
  return useUiStore.getState().openSession(id, options);
}

describe('open session set', () => {
  it('appends in open order and focuses the newest', () => {
    open('a');
    open('b');
    const state = useUiStore.getState();
    expect(state.openSessionIds).toEqual(['a', 'b']);
    expect(state.focusedSessionId).toBe('b');
  });

  it('re-opening an already-open Session focuses it without duplicating the entry', () => {
    open('a');
    open('b');
    const result = open('a');
    expect(result.alreadyOpen).toBe(true);
    expect(useUiStore.getState().openSessionIds).toEqual(['a', 'b']);
    expect(useUiStore.getState().focusedSessionId).toBe('a');
  });

  it('caps at 6 and evicts the least-recently-focused entry', () => {
    for (let index = 0; index < MAX_OPEN_SESSIONS; index += 1) {
      open(`s${index}`, { now: 1_000 + index });
    }
    const result = open('overflow', { now: 9_999 });

    expect(result.evictedSessionId).toBe('s0');
    expect(useUiStore.getState().openSessionIds).toHaveLength(MAX_OPEN_SESSIONS);
    expect(useUiStore.getState().openSessionIds).not.toContain('s0');
  });

  it('never evicts a protected (running) entry while an unprotected one exists', () => {
    // TDS 06 §3.4 refines §6.5: "never a `running` one". F7 state is server state, so the
    // shell supplies the protected set rather than the store guessing at it.
    for (let index = 0; index < MAX_OPEN_SESSIONS; index += 1) {
      open(`s${index}`, { now: 1_000 + index });
    }
    const result = open('overflow', { now: 9_999, protectedIds: ['s0', 's1'] });

    expect(result.evictedSessionId).toBe('s2');
    expect(useUiStore.getState().openSessionIds).toContain('s0');
  });

  it('falls back to least-recently-focused when every candidate is protected', () => {
    // Refusing to open the Session the operator just asked for would be worse than evicting
    // a running tab from a *switcher*, which stops no process.
    const all: string[] = [];
    for (let index = 0; index < MAX_OPEN_SESSIONS; index += 1) {
      open(`s${index}`, { now: 1_000 + index });
      all.push(`s${index}`);
    }
    const result = open('overflow', { now: 9_999, protectedIds: all });
    expect(result.evictedSessionId).toBe('s0');
  });

  it('closing an entry removes it and moves focus, touching no Session state', () => {
    open('a');
    open('b');
    useUiStore.getState().closeSession('b');
    expect(useUiStore.getState().openSessionIds).toEqual(['a']);
    expect(useUiStore.getState().focusedSessionId).toBe('a');
  });

  it('drops persisted ids whose Session no longer exists', () => {
    open('a');
    open('b');
    open('c');
    useUiStore.getState().retainSessions(['a', 'c']);
    expect(useUiStore.getState().openSessionIds).toEqual(['a', 'c']);
    expect(useUiStore.getState().focusedSessionId).toBe('c');
  });

  it('discards a draft along with its Session', () => {
    open('a');
    useUiStore.getState().setDraft('a', 'half a prompt');
    useUiStore.getState().closeSession('a');
    expect(useUiStore.getState().composerDrafts['a']).toBeUndefined();
  });
});

describe('persistence (§6.5 — survives reload)', () => {
  it('writes the open set, focus and theme to storage', () => {
    open('a');
    useUiStore.getState().setTheme('light');

    const raw = uiPersistStorage.getItem('mc.ui');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as {
      state: { openSessionIds: string[]; focusedSessionId: string; theme: string };
    };
    expect(persisted.state.openSessionIds).toEqual(['a']);
    expect(persisted.state.focusedSessionId).toBe('a');
    expect(persisted.state.theme).toBe('light');
  });

  it('rehydrates the set from storage', async () => {
    uiPersistStorage.setItem(
      'mc.ui',
      JSON.stringify({
        state: { openSessionIds: ['x', 'y'], focusedSessionId: 'y', theme: 'dark' },
        version: 1,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().openSessionIds).toEqual(['x', 'y']);
    expect(useUiStore.getState().focusedSessionId).toBe('y');
  });
});

describe('positional selectors for Alt+1…9 and Alt+[ / Alt+]', () => {
  it('resolves the nth entry, 1-based', () => {
    open('a');
    open('b');
    open('c');
    const state = useUiStore.getState();
    expect(openSessionAt(state, 1)).toBe('a');
    expect(openSessionAt(state, 3)).toBe('c');
    expect(openSessionAt(state, 4)).toBeNull();
  });

  it('wraps around for previous/next', () => {
    open('a');
    open('b');
    open('c');
    useUiStore.getState().focusSession('a');

    expect(adjacentOpenSession(useUiStore.getState(), -1)).toBe('c');
    expect(adjacentOpenSession(useUiStore.getState(), 1)).toBe('b');
  });

  it('returns null when nothing is open', () => {
    expect(adjacentOpenSession(useUiStore.getState(), 1)).toBeNull();
    expect(openSessionAt(useUiStore.getState(), 1)).toBeNull();
  });
});
