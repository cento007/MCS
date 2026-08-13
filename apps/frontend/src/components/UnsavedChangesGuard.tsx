import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBlocker } from 'react-router';
import { type DirtyPanel, unsavedChangesMessage } from '../lib/forms/dirty.js';
import { Modal } from './Modal.js';

/**
 * The unsaved-changes guard and the registry it reads (TDS 06 §5.7).
 *
 * Two editable surfaces in this product can be navigated away from mid-edit — **Settings** and
 * the **Agent Builder** — and TDS 05 §2.1 forbids one feature slice importing another, so this
 * lives in `components/` where both may reach it. One implementation is the point: two would
 * disagree about the count in the sentence ("you have 3 unsaved changes in …"), and the one in
 * front of the operator would be the one they believe.
 *
 * ## The registry
 *
 * The guard has to answer three questions from *outside* any single panel — "is anything
 * unsaved?", "what and where?", "save or discard it" — and the Integrations category renders
 * six independently-savable cards, so no one panel can answer them. Panels publish a summary of
 * themselves here while dirty and withdraw when clean; the guard reads the list. The Agent
 * Builder is a single form and publishes exactly one entry, which is the degenerate case of the
 * same mechanism rather than a different one.
 *
 * The panel's `save`/`discard` closures are held in a ref rather than in state on purpose: they
 * change identity on every render (they close over draft values), and putting them in state
 * would re-render every consumer of this context on every keystroke in any field.
 *
 * ## The guard
 *
 * Two complementary mechanisms, because neither covers the other's ground:
 *
 *  - **The router blocker** covers *in-app* navigation, where `beforeunload` never fires: the
 *    category rail, the main nav, the command palette, and browser back/forward. Category
 *    changes are route changes (`/settings/:category`), so one blocker covers both the rail
 *    and the nav — a separate interception path for the rail would be a second implementation
 *    of the same rule, and the two would drift.
 *  - **`beforeunload`** covers leaving the app entirely: tab close, reload, external link. The
 *    browser owns that dialog and it cannot be styled or replaced.
 *
 * `[Keep editing]` takes focus and is the safe default; `[Discard]` is danger-styled. A save
 * that fails does **not** proceed — the operator stays on the panel with their edits intact,
 * which is the whole point of guarding in the first place.
 */

export interface DirtyPanelActions {
  /** Resolves `true` when the save landed; `false` when the server rejected it. */
  save(): Promise<boolean>;
  discard(): void;
}

export interface DirtyFormsValue {
  readonly panels: readonly DirtyPanel[];
  readonly isDirty: boolean;
  readonly totalCount: number;
  publish(panel: DirtyPanel, actions: DirtyPanelActions): void;
  withdraw(panelId: string): void;
  /** Saves every dirty panel. Resolves `false` if any save failed — navigation must not proceed. */
  saveAll(): Promise<boolean>;
  discardAll(): void;
}

const EMPTY: DirtyFormsValue = {
  panels: [],
  isDirty: false,
  totalCount: 0,
  publish: () => {},
  withdraw: () => {},
  saveAll: async () => true,
  discardAll: () => {},
};

const DirtyFormsContext = createContext<DirtyFormsValue>(EMPTY);

export function DirtyFormProvider({ children }: { children: ReactNode }) {
  const [panels, setPanels] = useState<readonly DirtyPanel[]>([]);
  const actions = useRef(new Map<string, DirtyPanelActions>());

  const publish = useCallback((panel: DirtyPanel, panelActions: DirtyPanelActions) => {
    actions.current.set(panel.panelId, panelActions);
    setPanels((previous) => {
      const existing = previous.find((entry) => entry.panelId === panel.panelId);
      if (
        existing !== undefined &&
        existing.count === panel.count &&
        existing.secretCount === panel.secretCount &&
        existing.label === panel.label
      ) {
        // Identical summary — returning the same array keeps the guard from re-rendering on
        // every keystroke once a panel is already known to be dirty.
        return previous;
      }
      const others = previous.filter((entry) => entry.panelId !== panel.panelId);
      return [...others, panel];
    });
  }, []);

  const withdraw = useCallback((panelId: string) => {
    actions.current.delete(panelId);
    setPanels((previous) =>
      previous.some((entry) => entry.panelId === panelId)
        ? previous.filter((entry) => entry.panelId !== panelId)
        : previous,
    );
  }, []);

  const saveAll = useCallback(async (): Promise<boolean> => {
    let allSaved = true;
    // Sequential: two PUTs to the same category racing each other is a last-write-wins
    // problem the operator cannot see, and there are at most six panels.
    for (const entry of [...actions.current.values()]) {
      const saved = await entry.save();
      if (!saved) allSaved = false;
    }
    return allSaved;
  }, []);

  const discardAll = useCallback(() => {
    for (const entry of [...actions.current.values()]) entry.discard();
  }, []);

  const value = useMemo<DirtyFormsValue>(
    () => ({
      panels,
      isDirty: panels.length > 0,
      totalCount: panels.reduce((sum, panel) => sum + panel.count, 0),
      publish,
      withdraw,
      saveAll,
      discardAll,
    }),
    [panels, publish, withdraw, saveAll, discardAll],
  );

  return <DirtyFormsContext value={value}>{children}</DirtyFormsContext>;
}

export function useDirtyForms(): DirtyFormsValue {
  return useContext(DirtyFormsContext);
}

export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: BeforeUnloadEvent): void => {
      // Both forms are required across browsers; `preventDefault` is the modern one and
      // `returnValue` is what older Chromium still reads.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}

/**
 * Renders nothing until a blocked navigation happens. Mounted once per guarded subtree —
 * `SettingsPage` and the Agents route both do so.
 *
 * `useBlocker` requires a data router (`createBrowserRouter`), which is what `app/router.tsx`
 * builds — and what the Settings and Agents tests therefore also build, rather than a
 * `MemoryRouter`. A harness using the non-data router could not exercise this guard at all,
 * which would leave the highest-consequence behaviour on those screens untestable.
 */
export function UnsavedChangesGuard() {
  const { panels, isDirty, saveAll, discardAll } = useDirtyForms();
  const [saving, setSaving] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  useBeforeUnloadGuard(isDirty);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );

  const open = blocker.state === 'blocked';

  /**
   * A blocked navigation with nothing unsaved must not stay blocked.
   *
   * `useBlocker` re-registers its predicate from an **effect**, so the router can still be holding
   * the previous render's answer when a navigation is fired from another component's effect in the
   * same commit. The case that exposed it: the Agent Builder saves a new agent — which drops the
   * form to clean and withdraws it from this registry — and then navigates to the created agent.
   * The router judged that navigation against "dirty", blocked it, and offered to save the changes
   * it had just saved.
   *
   * Rather than making every caller order its own state updates against a React-internal detail,
   * the guard states the invariant it actually means: **there is nothing to guard when nothing is
   * dirty.** Proceeding here is not a workaround for one screen; a modal asking about unsaved work
   * that does not exist is wrong on any screen, however it got on the page.
   */
  useEffect(() => {
    if (blocker.state === 'blocked' && !isDirty) blocker.proceed?.();
  }, [blocker, isDirty]);

  useEffect(() => {
    if (!open) return;
    // Default focus on the non-destructive choice. `Modal` focuses its own container, so this
    // runs after and moves focus onward.
    const id = window.setTimeout(() => keepEditingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // `!isDirty` is the effect above, mid-flight: render nothing rather than flash a dialog that is
  // one commit away from dismissing itself.
  if (!open || !isDirty) return null;

  const keepEditing = (): void => blocker.reset?.();

  const discard = (): void => {
    discardAll();
    blocker.proceed?.();
  };

  const save = (): void => {
    setSaving(true);
    void saveAll()
      .then((allSaved) => {
        // A failed save must not navigate away — that would discard the edits the guard was
        // protecting, under a button labelled "Save".
        if (allSaved) blocker.proceed?.();
        else blocker.reset?.();
      })
      .finally(() => setSaving(false));
  };

  return (
    <Modal open onClose={keepEditing} title="Unsaved changes">
      <p data-testid="unsaved-message" className="text-sm text-text leading-150">
        {unsavedChangesMessage(panels)}
      </p>
      {/*
        The secrets sentence is conditional now that this guard serves more than Settings. An agent
        form has no secrets, and telling its operator that "secrets cannot be recovered" is a
        warning about a risk that is not on their screen — which is how a warning becomes wallpaper.
      */}
      <p className="mt-2 text-2xs text-text-muted leading-150">
        Leaving now discards them.
        {panels.some((panel) => panel.secretCount > 0)
          ? ' Secrets in particular cannot be recovered from the screen.'
          : ''}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={discard}
          disabled={saving}
          className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
          style={{
            height: 'var(--mc-control-md)',
            minHeight: 24,
            backgroundColor: 'var(--color-danger)',
            color: 'var(--color-text-inverse)',
          }}
        >
          Discard
        </button>
        <button
          ref={keepEditingRef}
          type="button"
          onClick={keepEditing}
          className="rounded-sm border border-border-control px-3 text-sm text-text"
          style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
          style={{
            height: 'var(--mc-control-md)',
            minHeight: 24,
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
