import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DirtyPanel } from './dirty.js';

/**
 * The Settings dirty registry (TDS 06 §5.7).
 *
 * The guard has to answer three questions from *outside* any single panel — "is anything
 * unsaved?", "what and where?", "save or discard it" — and the Integrations category renders
 * six independently-savable cards, so no one panel can answer them. Panels publish a summary
 * of themselves here while dirty and withdraw when clean; the page-level guard reads the list.
 *
 * The panel's `save`/`discard` closures are held in a ref rather than in state on purpose:
 * they change identity on every render (they close over draft values), and putting them in
 * state would re-render every consumer of this context on every keystroke in any field.
 */

export interface DirtyPanelActions {
  /** Resolves `true` when the save landed; `false` when the server rejected it. */
  save(): Promise<boolean>;
  discard(): void;
}

export interface SettingsDirtyValue {
  readonly panels: readonly DirtyPanel[];
  readonly isDirty: boolean;
  readonly totalCount: number;
  publish(panel: DirtyPanel, actions: DirtyPanelActions): void;
  withdraw(panelId: string): void;
  /** Saves every dirty panel. Resolves `false` if any save failed — navigation must not proceed. */
  saveAll(): Promise<boolean>;
  discardAll(): void;
}

const EMPTY: SettingsDirtyValue = {
  panels: [],
  isDirty: false,
  totalCount: 0,
  publish: () => {},
  withdraw: () => {},
  saveAll: async () => true,
  discardAll: () => {},
};

const SettingsDirtyContext = createContext<SettingsDirtyValue>(EMPTY);

export function SettingsDirtyProvider({ children }: { children: ReactNode }) {
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

  const value = useMemo<SettingsDirtyValue>(
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

  return <SettingsDirtyContext value={value}>{children}</SettingsDirtyContext>;
}

export function useSettingsDirty(): SettingsDirtyValue {
  return useContext(SettingsDirtyContext);
}
