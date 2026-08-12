import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * `uiStore` — ephemeral operator preferences, `localStorage`-persisted (TDS 05 §3, §6.5).
 *
 * The important tenant here is the **open session set**. TDS 05 §6.5 and TDS 06 §3.4 agree
 * on one rule and it is the reason this lives in a store rather than in a component: there
 * is ONE ordered list, and both switcher surfaces — the shell's OpenSessionsStrip and the
 * Live Session tab bar — are projections of it. They cannot diverge because there is
 * nothing to diverge from.
 *
 * Closing an entry removes it from the open set (releasing its `session:{id}` subscription)
 * and **never** touches Session state: no F7 transition is implied, and the Backend is not
 * told. "Close" is a statement about the operator's attention, not about the process.
 */

/** §6.5 / §3.4 — the cap is a constant, not a setting, in V1. */
export const MAX_OPEN_SESSIONS = 6;

export type ThemeName = 'dark' | 'light';

/** §6.7 — the Session detail right panel's tabs. */
export const SESSION_PANEL_TABS = ['commits', 'files', 'timeline', 'notes'] as const;
export type SessionPanelTab = (typeof SESSION_PANEL_TABS)[number];

export interface UiStoreState {
  readonly navCollapsed: boolean;
  /** PRD §4.4.1 defaults to dark; no light palette is designed in V1 (TDS 06 §2.6.2). */
  readonly theme: ThemeName;
  /** Ordered open session set — the single source for both switcher surfaces. */
  readonly openSessionIds: readonly string[];
  readonly focusedSessionId: string | null;
  /** Epoch ms per Session id; drives least-recently-focused eviction. */
  readonly focusedAt: Readonly<Record<string, number>>;
  readonly panelCollapsed: boolean;
  readonly panelTab: SessionPanelTab;
  /** Composer drafts survive re-login (§8) — they are the operator's unsent words. */
  readonly composerDrafts: Readonly<Record<string, string>>;

  setNavCollapsed(collapsed: boolean): void;
  toggleNav(): void;
  setTheme(theme: ThemeName): void;
  toggleTheme(): void;

  openSession(sessionId: string, options?: OpenSessionOptions): OpenSessionResult;
  closeSession(sessionId: string): void;
  focusSession(sessionId: string): void;
  /** Drop persisted ids whose Session no longer exists (§6.5, validated on reload). */
  retainSessions(validIds: readonly string[]): void;
  reorderSessions(orderedIds: readonly string[]): void;

  setPanelCollapsed(collapsed: boolean): void;
  setPanelTab(tab: SessionPanelTab): void;

  setDraft(sessionId: string, text: string): void;
  clearDraft(sessionId: string): void;

  reset(): void;
}

export interface OpenSessionOptions {
  /**
   * Ids that must not be evicted to make room.
   *
   * TDS 05 §6.5 says the 7th open Session evicts the "least-recently-focused" entry;
   * TDS 06 §3.4 refines that to the least-recently-viewed **non-`running`** entry, "never a
   * `running` one". F7 state is *server* state and does not belong in `uiStore`, so the
   * refinement is expressed as a caller-supplied protected set: the shell passes the ids it
   * knows are `running` from the query cache. When every candidate is protected the store
   * falls back to WS4's plain least-recently-focused rule, because refusing to open the
   * Session the operator just asked for would be worse than evicting a running tab from a
   * *switcher* (which, again, stops no process).
   */
  readonly protectedIds?: readonly string[];
  /** Default true — opening a Session focuses it. */
  readonly focus?: boolean;
  readonly now?: number;
}

export interface OpenSessionResult {
  /** The id evicted to make room, for the undo toast (§6.5 / §3.4). */
  readonly evictedSessionId: string | null;
  readonly alreadyOpen: boolean;
}

const INITIAL = {
  navCollapsed: false,
  theme: 'dark' as ThemeName,
  openSessionIds: [] as readonly string[],
  focusedSessionId: null as string | null,
  focusedAt: {} as Readonly<Record<string, number>>,
  panelCollapsed: false,
  panelTab: 'timeline' as SessionPanelTab,
  composerDrafts: {} as Readonly<Record<string, string>>,
};

/** The eviction candidate: oldest `focusedAt`, preferring unprotected entries. */
function evictionCandidate(
  openSessionIds: readonly string[],
  focusedAt: Readonly<Record<string, number>>,
  protectedIds: readonly string[],
): string | null {
  const protectedSet = new Set(protectedIds);
  const rank = (id: string): number => focusedAt[id] ?? 0;

  const unprotected = openSessionIds.filter((id) => !protectedSet.has(id));
  const pool = unprotected.length > 0 ? unprotected : openSessionIds;
  if (pool.length === 0) return null;

  return pool.reduce((oldest, id) => (rank(id) < rank(oldest) ? id : oldest), pool[0] as string);
}

/**
 * The backing store for persistence, resolved once.
 *
 * `localStorage` is not a given even in a browser: Safari's private mode throws on write,
 * an operator can disable site data, and — as this repository's own test environment
 * demonstrates — `window.localStorage` can simply be absent. A store that assumes it exists
 * takes the whole SPA down on load, so availability is *probed* (a real write and delete,
 * not a truthiness check) and an in-memory implementation is used when the probe fails.
 * The operator then loses persistence across reload, which is a degraded feature rather
 * than a blank page.
 *
 * Exported so tests can assert what was persisted without reaching into a global.
 */
export const uiPersistStorage: Storage = resolveStorage();

function resolveStorage(): Storage {
  const probeKey = '__mc_probe__';
  try {
    const candidate: Storage | undefined =
      typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
    if (candidate !== undefined) {
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    }
  } catch {
    // Fall through to memory.
  }
  return memoryStorage();
}

/** In-memory fallback so the store works with no usable Web Storage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

export const useUiStore = create<UiStoreState>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      setNavCollapsed: (collapsed) => set({ navCollapsed: collapsed }),
      toggleNav: () => set((previous) => ({ navCollapsed: !previous.navCollapsed })),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () =>
        set((previous) => ({ theme: previous.theme === 'dark' ? 'light' : 'dark' })),

      openSession: (sessionId, options = {}) => {
        const now = options.now ?? Date.now();
        const focus = options.focus ?? true;
        const state = get();

        if (state.openSessionIds.includes(sessionId)) {
          if (focus) state.focusSession(sessionId);
          return { evictedSessionId: null, alreadyOpen: true };
        }

        let openSessionIds = [...state.openSessionIds];
        let evictedSessionId: string | null = null;

        if (openSessionIds.length >= MAX_OPEN_SESSIONS) {
          evictedSessionId = evictionCandidate(
            openSessionIds,
            state.focusedAt,
            options.protectedIds ?? [],
          );
          if (evictedSessionId !== null) {
            openSessionIds = openSessionIds.filter((id) => id !== evictedSessionId);
          }
        }

        openSessionIds.push(sessionId);
        const focusedAt = { ...state.focusedAt, [sessionId]: now };
        if (evictedSessionId !== null) delete focusedAt[evictedSessionId];

        set({
          openSessionIds,
          focusedAt,
          ...(focus ? { focusedSessionId: sessionId } : {}),
        });
        return { evictedSessionId, alreadyOpen: false };
      },

      closeSession: (sessionId) =>
        set((previous) => {
          const openSessionIds = previous.openSessionIds.filter((id) => id !== sessionId);
          const focusedAt = { ...previous.focusedAt };
          delete focusedAt[sessionId];
          const composerDrafts = { ...previous.composerDrafts };
          delete composerDrafts[sessionId];
          return {
            openSessionIds,
            focusedAt,
            composerDrafts,
            focusedSessionId:
              previous.focusedSessionId === sessionId
                ? (openSessionIds[openSessionIds.length - 1] ?? null)
                : previous.focusedSessionId,
          };
        }),

      focusSession: (sessionId) =>
        set((previous) => ({
          focusedSessionId: sessionId,
          focusedAt: { ...previous.focusedAt, [sessionId]: Date.now() },
        })),

      retainSessions: (validIds) =>
        set((previous) => {
          const valid = new Set(validIds);
          const openSessionIds = previous.openSessionIds.filter((id) => valid.has(id));
          if (openSessionIds.length === previous.openSessionIds.length) return previous;
          const focusedAt: Record<string, number> = {};
          for (const id of openSessionIds) {
            const at = previous.focusedAt[id];
            if (at !== undefined) focusedAt[id] = at;
          }
          return {
            openSessionIds,
            focusedAt,
            focusedSessionId:
              previous.focusedSessionId !== null && valid.has(previous.focusedSessionId)
                ? previous.focusedSessionId
                : (openSessionIds[openSessionIds.length - 1] ?? null),
          };
        }),

      reorderSessions: (orderedIds) =>
        set((previous) => {
          const known = new Set(previous.openSessionIds);
          const next = orderedIds.filter((id) => known.has(id));
          for (const id of previous.openSessionIds) {
            if (!next.includes(id)) next.push(id);
          }
          return { openSessionIds: next };
        }),

      setPanelCollapsed: (collapsed) => set({ panelCollapsed: collapsed }),
      setPanelTab: (tab) => set({ panelTab: tab }),

      setDraft: (sessionId, text) =>
        set((previous) => ({
          composerDrafts: { ...previous.composerDrafts, [sessionId]: text },
        })),

      clearDraft: (sessionId) =>
        set((previous) => {
          const composerDrafts = { ...previous.composerDrafts };
          delete composerDrafts[sessionId];
          return { composerDrafts };
        }),

      reset: () => set({ ...INITIAL }),
    }),
    {
      name: 'mc.ui',
      version: 1,
      storage: createJSONStorage(() => uiPersistStorage),
      // Actions are not state; persisting them would serialise functions to `undefined` and
      // then rehydrate a store with no behaviour.
      partialize: (state) => ({
        navCollapsed: state.navCollapsed,
        theme: state.theme,
        openSessionIds: state.openSessionIds,
        focusedSessionId: state.focusedSessionId,
        focusedAt: state.focusedAt,
        panelCollapsed: state.panelCollapsed,
        panelTab: state.panelTab,
        composerDrafts: state.composerDrafts,
      }),
    },
  ),
);

/** The nth entry of the open set, for `Alt+1…9` (§9.4). 1-based, `null` when absent. */
export function openSessionAt(state: UiStoreState, position: number): string | null {
  return state.openSessionIds[position - 1] ?? null;
}

/** Previous/next open Session relative to the focused one, for `Alt+[` / `Alt+]` (§9.4). */
export function adjacentOpenSession(state: UiStoreState, direction: -1 | 1): string | null {
  const { openSessionIds, focusedSessionId } = state;
  if (openSessionIds.length === 0) return null;
  const index = focusedSessionId === null ? -1 : openSessionIds.indexOf(focusedSessionId);
  if (index === -1) {
    return (
      (direction === 1 ? openSessionIds[0] : openSessionIds[openSessionIds.length - 1]) ?? null
    );
  }
  const next = (index + direction + openSessionIds.length) % openSessionIds.length;
  return openSessionIds[next] ?? null;
}
