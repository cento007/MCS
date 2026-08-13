import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { Modal } from '../../components/Modal.js';
import { unsavedChangesMessage } from './dirty.js';
import { useSettingsDirty } from './registry.js';

/**
 * The unsaved-changes guard (TDS 06 §5.7).
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
 * Renders nothing until a blocked navigation happens. Mounted once, by `SettingsPage`.
 *
 * `useBlocker` requires a data router (`createBrowserRouter`), which is what `app/router.tsx`
 * builds — and what the Settings tests therefore also build, rather than a `MemoryRouter`. A
 * test harness that used the non-data router could not exercise this guard at all, which would
 * leave the highest-consequence behaviour on the screen uncovered.
 */
export function UnsavedChangesGuard() {
  const { panels, isDirty, saveAll, discardAll } = useSettingsDirty();
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

  useEffect(() => {
    if (!open) return;
    // Default focus on the non-destructive choice. `Modal` focuses its own container, so this
    // runs after and moves focus onward.
    const id = window.setTimeout(() => keepEditingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!open) return null;

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
      <p className="mt-2 text-2xs text-text-muted leading-150">
        Leaving now discards them. Secrets in particular cannot be recovered from the screen.
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
