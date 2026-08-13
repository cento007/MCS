import type { UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, QueryKey } from '../../lib/api/index.js';
import {
  CLEAN,
  type DirtySummary,
  type Draft,
  type DraftValue,
  IDLE_SECRET,
  type SecretDraft,
  type SecretDrafts,
  summarizeDirty,
} from './dirty.js';
import { type SaveSettingsOptions, useSaveSettings } from './mutations.js';
import { isEndpointMissing } from './queries.js';
import { useSettingsDirty } from './registry.js';
import type { SecretFieldWrite } from './types.js';

/**
 * The one form engine every Settings panel uses (TDS 05 §7.2, TDS 06 §5.7).
 *
 * §7.2 calls for "a React Hook Form form driven by a Zod schema + field-metadata map" whose
 * schemas "live beside (or are derived from) the shared settings types in `packages/shared`,
 * so frontend validation and Backend validation cannot drift". **That shared source does not
 * exist yet** — WS2 §7.6's key registry has not landed — so writing a parallel Zod schema in
 * the SPA today would institutionalise precisely the drift that sentence exists to prevent,
 * and would add two dependencies to validate documents no route yet accepts. This hook is the
 * seam instead: it owns draft/baseline/dirty/save, and the field-metadata map lives beside each
 * panel. When the registry ships, its schemas plug in here and no panel moves.
 *
 * What this file makes structurally impossible:
 *
 *  - **A per-field save.** There is one `save()`, on the panel. `[Clear]` is the single
 *    exception and it is a *destroy*, not an edit (§4.4).
 *  - **A test against unsaved input.** `summary.isDirty` is the only gate Test Connection
 *    reads, and it is computed from the same baseline the save writes against.
 *  - **A secret round-trip.** Secret values live in `secrets` (component state), are written
 *    only into a request body, and are dropped on save, on discard and on unmount. `baseline`
 *    never contains one.
 */

export interface PanelFormOptions<TDoc> {
  /** Stable id for the dirty registry. */
  readonly panelId: string;
  /** Breadcrumb the guard modal quotes, e.g. `Integrations → GitHub`. */
  readonly label: string;
  /** REST path for the full-category (or per-integration) replace. */
  readonly path: string;
  /** Cache slot holding the masked document. */
  readonly queryKey: QueryKey;
  readonly query: UseQueryResult<TDoc, ApiError>;
  /** Flatten the API document into editable primitives (nested objects become dotted paths). */
  readonly toDraft: (document: TDoc) => Draft;
  /** Rebuild the full replacement document. Secrets appear only when written (§7.1). */
  readonly toBody: (input: {
    readonly draft: Draft;
    readonly secrets: Readonly<Record<string, SecretFieldWrite>>;
    readonly document: TDoc;
  }) => unknown;
  /** See `SaveSettingsOptions.applyResult` — the Integrations cards need a slice merge. */
  readonly applyResult?: SaveSettingsOptions<TDoc>['applyResult'];
  /**
   * Ask the operator before the write leaves the browser. Resolving `false` cancels it and
   * leaves the panel dirty, exactly as a rejected save does.
   *
   * It belongs in the engine rather than on a `[Save changes]` click handler because there are
   * **four** ways a save starts and only one of them is that button: `Ctrl+S` inside a field,
   * submitting the form, and the unsaved-changes guard's own `[Save]`, which calls this panel
   * through the dirty registry. A confirmation wired to the button alone would be silently
   * bypassed by the navigation guard — i.e. by the exact path an operator takes when they are
   * already distracted and leaving.
   *
   * Only Settings → Memory uses it so far: retention is the only setting in the product whose
   * save deletes data (PRD §4.4 item 4). `[Clear]` on a secret is deliberately **not** routed
   * through here — it has its own confirm at the call site and is not part of a panel save.
   */
  readonly confirmSave?: () => Promise<boolean>;
}

export interface PanelForm<TDoc> {
  readonly document: TDoc | null;
  readonly draft: Draft;
  readonly baseline: Draft;
  readonly summary: DirtySummary;
  /** False when the Backend does not serve this route yet — fields render disabled. */
  readonly available: boolean;
  readonly isPending: boolean;
  /** Set only for failures that are *not* "route missing"; those are reported as unavailable. */
  readonly error: ApiError | null;
  readonly isSaving: boolean;
  /** Epoch ms of the last successful save — the "Saved HH:MM:SS" confirmation. */
  readonly savedAt: number | null;
  /** True when no control on this panel may be edited. */
  readonly disabled: boolean;

  value(name: string): DraftValue | undefined;
  isChanged(name: string): boolean;
  set(name: string, value: DraftValue): void;

  secretOf(name: string): SecretDraft;
  beginReplace(name: string): void;
  cancelReplace(name: string): void;
  setSecretValue(name: string, value: string): void;
  /** Commits `{ field: null }` immediately (§4.4) — never batched behind `[Save changes]`. */
  clearSecret(name: string): Promise<boolean>;

  discard(): void;
  save(): Promise<boolean>;
}

const EMPTY_DRAFT: Draft = Object.freeze({});

export function usePanelForm<TDoc>(options: PanelFormOptions<TDoc>): PanelForm<TDoc> {
  const { panelId, label, path, queryKey, query, toDraft, toBody } = options;
  const registry = useSettingsDirty();

  const document = query.data ?? null;
  // `toDraft` is a module-level pure function per panel; depending on its identity would
  // recompute the baseline on every render and defeat the comparison it exists to support.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `document` is the real dependency; see above
  const baseline = useMemo(() => (document === null ? EMPTY_DRAFT : toDraft(document)), [document]);

  /**
   * `null` means **"follow the baseline"** — the editor has been touched by nobody.
   *
   * This is a sentinel rather than a copy of the baseline, and the distinction is not
   * cosmetic. Seeding state from `baseline` at mount would capture the *empty* draft that
   * exists before the query resolves, and every field would then read as changed the moment
   * the document arrived: a freshly-loaded panel would open with "5 changes" and a Test
   * Connection button disabled for edits nobody made. Following the baseline until the first
   * edit makes "clean" the default state instead of a state that has to be restored.
   */
  const [editedDraft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState<SecretDrafts>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const confirmRef = useRef(options.confirmSave);
  confirmRef.current = options.confirmSave;

  const draft = editedDraft ?? baseline;

  const summary = useMemo(
    () => (document === null ? CLEAN : summarizeDirty(baseline, draft, secrets)),
    [document, baseline, draft, secrets],
  );

  /**
   * A refetch landing mid-edit must not overwrite the operator's typing.
   *
   * `setting.updated` from another tab invalidates this query (§7.2). If the operator has
   * unsaved edits the draft is kept and only the baseline moves, so the change marks and the
   * count immediately re-describe the edit against the new server truth. If they had no edits
   * — including the case where they typed something and then typed it back — the editor drops
   * to following the baseline again.
   *
   * Dirtiness is measured against the **previous** baseline, because measuring it against the
   * new one would call every field changed and thereby refuse to adopt any server update.
   */
  const baselineRef = useRef(baseline);
  const draftRef = useRef<Draft | null>(editedDraft);
  draftRef.current = editedDraft;
  const secretsRef = useRef(secrets);
  secretsRef.current = secrets;

  useEffect(() => {
    const previousBaseline = baselineRef.current;
    baselineRef.current = baseline;
    if (previousBaseline === baseline) return;
    const current = draftRef.current;
    const wasDirty =
      current !== null && summarizeDirty(previousBaseline, current, secretsRef.current).isDirty;
    if (!wasDirty) setDraft(null);
  }, [baseline]);

  const mutation = useSaveSettings<TDoc>({
    path,
    queryKey,
    label,
    ...(options.applyResult === undefined ? {} : { applyResult: options.applyResult }),
    onSaved: () => {
      // Back to following the baseline, which the mutation has just replaced with the server's
      // masked answer — that is what makes a replaced secret return as `{ isSet: true }` with a
      // fresh timestamp rather than as the string the operator typed.
      setDraft(null);
      setSecrets({});
      setSavedAt(Date.now());
    },
  });

  const value = useCallback((name: string): DraftValue | undefined => draft[name], [draft]);

  const isChanged = useCallback(
    (name: string): boolean =>
      summary.changedFields.includes(name) || summary.changedSecrets.includes(name),
    [summary],
  );

  const set = useCallback((name: string, next: DraftValue) => {
    setDraft((previous) => ({ ...(previous ?? baselineRef.current), [name]: next }));
  }, []);

  const secretOf = useCallback(
    (name: string): SecretDraft => secrets[name] ?? IDLE_SECRET,
    [secrets],
  );

  const beginReplace = useCallback((name: string) => {
    // Always an EMPTY input. A pre-filled one would imply the client can read the stored
    // value, which is the single thing the write-only contract forbids.
    setSecrets((previous) => ({ ...previous, [name]: { replacing: true, value: '' } }));
  }, []);

  const cancelReplace = useCallback((name: string) => {
    setSecrets((previous) => {
      const next = { ...previous };
      delete next[name];
      return next;
    });
  }, []);

  const setSecretValue = useCallback((name: string, next: string) => {
    setSecrets((previous) => ({ ...previous, [name]: { replacing: true, value: next } }));
  }, []);

  const discard = useCallback(() => {
    // Back to following the baseline, and every typed secret leaves memory here.
    setDraft(null);
    setSecrets({});
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (document === null) return false;
    // Held in a ref, like `save`/`discard` below: the panel's confirmation closes over its own
    // draft and so changes identity on every keystroke, and depending on it here would rebuild
    // `save` — and republish the panel to the dirty registry — on every character typed.
    const confirm = confirmRef.current;
    if (confirm !== undefined && !(await confirm())) return false;
    const written: Record<string, SecretFieldWrite> = {};
    for (const name of summary.changedSecrets) {
      written[name] = secretOf(name).value;
    }
    try {
      await mutation.mutateAsync({ body: toBody({ draft, secrets: written, document }) });
      return true;
    } catch {
      // The toast in `useSaveSettings` already named the failure with its requestId; the
      // panel stays dirty so nothing is lost, and the guard refuses to navigate away.
      return false;
    }
  }, [document, draft, summary.changedSecrets, secretOf, mutation, toBody]);

  const clearSecret = useCallback(
    async (name: string): Promise<boolean> => {
      if (document === null) return false;
      try {
        // The BASELINE, not the draft: `[Clear]` destroys one credential and must not smuggle
        // the operator's other unsaved edits into the same commit (§4.4).
        await mutation.mutateAsync({
          body: toBody({ draft: baseline, secrets: { [name]: null }, document }),
        });
        setSecrets((previous) => {
          const next = { ...previous };
          delete next[name];
          return next;
        });
        return true;
      } catch {
        return false;
      }
    },
    [document, baseline, mutation, toBody],
  );

  // Publish to the page-level guard while dirty; withdraw when clean or unmounted.
  const saveRef = useRef(save);
  saveRef.current = save;
  const discardRef = useRef(discard);
  discardRef.current = discard;

  const { publish, withdraw } = registry;
  const { isDirty, count, secretCount } = summary;

  useEffect(() => {
    if (!isDirty) {
      withdraw(panelId);
      return;
    }
    publish(
      { panelId, label, count, secretCount },
      { save: () => saveRef.current(), discard: () => discardRef.current() },
    );
    return () => withdraw(panelId);
  }, [isDirty, count, secretCount, panelId, label, publish, withdraw]);

  const missing = query.isError && isEndpointMissing(query.error);
  const available = !missing;

  return {
    document,
    draft,
    baseline,
    summary,
    available,
    isPending: query.isPending,
    error: missing ? null : (query.error as ApiError | null),
    isSaving: mutation.isPending,
    savedAt,
    disabled: !available || query.isPending || mutation.isPending,
    value,
    isChanged,
    set,
    secretOf,
    beginReplace,
    cancelReplace,
    setSecretValue,
    clearSecret,
    discard,
    save,
  };
}
