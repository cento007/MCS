import type { AgentPermissions } from '@mc/shared/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDirtyForms } from '../../components/UnsavedChangesGuard.js';
import {
  CLEAN,
  type DirtySummary,
  type Draft,
  type DraftValue,
  summarizeDirty,
} from '../../lib/forms/dirty.js';
import { agentIdOf, useCreateAgent, useUpdateAgent } from './mutations.js';
import {
  AGENT_FIELDS,
  type AgentFormIssue,
  type AgentView,
  agentIssues,
  applyPermissionChange,
  applyScopeChange,
  blockingIssues,
  draftString,
  newAgentDraft,
  toAgentDraft,
  toCreateBody,
  toPatchBody,
} from './shape.js';

/**
 * The Agent Builder's form engine (PRD §5.8).
 *
 * ## Why this is not `usePanelForm`
 *
 * The parts that are genuinely shared *are* shared: the dirty contract (`lib/forms/dirty.ts`), the
 * registry and the navigation guard (`components/UnsavedChangesGuard.tsx`) were promoted out of
 * `features/settings/` so there is one implementation of each, and this engine publishes to the
 * same registry the Settings panels do. What is not shared is the write, and the difference is
 * structural rather than cosmetic:
 *
 *  - A Settings save is a **full-category `PUT`** where an omitted field resets to its default
 *    (arbitration A14), so `usePanelForm` must always send the whole document. An agent save is
 *    `POST` once and **`PATCH`** thereafter, where an omitted field is left alone — and where
 *    sending three specific fields (`scope`, `projectId`, `sessionId`) is a `400` rather than a
 *    no-op, because the update schema is `additionalProperties: false` and scope is immutable.
 *  - Settings has secrets, a per-integration test-connection, and a `[Clear]` that commits on its
 *    own. An agent has none of those.
 *  - An agent form can be **invalid in ways a settings panel cannot**: two cross-field invariants
 *    the Backend enforces in the database. `usePanelForm` has no validation axis at all.
 *
 * Threading a `mode` flag through a hook whose whole job is deciding what to send is how a `PUT`
 * body eventually reaches a `PATCH` route.
 *
 * ## Create and edit are one engine
 *
 * The only differences are the baseline and the verb. Two components would drift on the thing that
 * matters most — the validation — and create is the path where an operator can most easily build
 * an agent that cannot exist.
 */

export interface AgentFormOptions {
  readonly mode: 'create' | 'edit';
  /** `null` in create mode, and while the detail read is in flight. */
  readonly agent: AgentView | null;
  /** `settings.agents.defaultPermissionTemplate`, resolved. Seeds a new agent's switches. */
  readonly defaultPermissions: AgentPermissions;
  /** False when `GET /projects` failed — the project picker cannot be populated. */
  readonly projectsAvailable: boolean;
  /** Disables every control: the route is missing, or the read failed. */
  readonly readOnly?: boolean;
}

export interface AgentForm {
  readonly mode: 'create' | 'edit';
  readonly draft: Draft;
  readonly baseline: Draft;
  readonly summary: DirtySummary;
  readonly issues: readonly AgentFormIssue[];
  /** Blocking issues only — advisory ones are shown and do not stop a save. */
  readonly blocking: readonly AgentFormIssue[];
  readonly canSubmit: boolean;
  readonly isSaving: boolean;
  readonly savedAt: number | null;
  readonly disabled: boolean;
  /** Set once a create has landed, so the page can navigate to the new agent. */
  readonly createdId: string | null;

  value(name: string): DraftValue | undefined;
  text(name: string): string;
  isChanged(name: string): boolean;
  set(name: string, value: DraftValue): void;
  /** Scope and project move together — see `applyScopeChange`. */
  setScope(scope: string): void;
  /** `shell` drags `read` and `write` with it — see `applyPermissionChange`. */
  setPermission(path: string, granted: boolean): void;
  discard(): void;
  save(): Promise<boolean>;
}

const PANEL_ID = 'agent-builder';

export function useAgentForm(options: AgentFormOptions): AgentForm {
  const { mode, agent, defaultPermissions, projectsAvailable, readOnly = false } = options;
  const registry = useDirtyForms();

  const create = useCreateAgent();
  const update = useUpdateAgent();

  const [editedDraft, setDraft] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  /**
   * The draft a successful create was built from.
   *
   * It becomes the baseline the moment the create lands, dropping the form to clean *before* the
   * page navigates to the new agent. Without it the guard would block the navigation the save
   * itself caused, and offer to save the changes it had just saved.
   */
  const [createdBaseline, setCreatedBaseline] = useState<Draft | null>(null);

  /**
   * `settings.agents.defaultPermissionTemplate` arrives asynchronously, so the create baseline is
   * recomputed when it lands and the effect below adopts it — provided the operator has typed
   * nothing. `useDefaultAgentPermissions` memoises its `permissions` on the template name, so the
   * identity here is stable and this does not rebuild on every render.
   */
  const baseline = useMemo<Draft>(() => {
    if (mode === 'create') {
      return createdBaseline ?? newAgentDraft({ permissions: defaultPermissions });
    }
    return agent === null
      ? newAgentDraft({ permissions: defaultPermissions })
      : toAgentDraft(agent);
  }, [mode, agent, createdBaseline, defaultPermissions]);

  const draft = editedDraft ?? baseline;

  const summary = useMemo<DirtySummary>(() => {
    // An edit form with nothing loaded yet has nothing to be dirty against.
    if (mode === 'edit' && agent === null) return CLEAN;
    return summarizeDirty(baseline, draft);
  }, [mode, agent, baseline, draft]);

  /**
   * A refetch landing mid-edit must not overwrite the operator's typing.
   *
   * `agent.updated` from another tab invalidates this query. If there are unsaved edits the draft
   * is kept and only the baseline moves, so the change marks immediately re-describe the edit
   * against the new server truth; if there were none, the editor drops back to following the
   * baseline. Dirtiness is measured against the **previous** baseline — measuring against the new
   * one would call every field changed and thereby refuse every server update.
   */
  const baselineRef = useRef(baseline);
  const draftRef = useRef<Draft | null>(editedDraft);
  draftRef.current = editedDraft;

  useEffect(() => {
    const previous = baselineRef.current;
    baselineRef.current = baseline;
    if (previous === baseline) return;
    const current = draftRef.current;
    const wasDirty = current !== null && summarizeDirty(previous, current).isDirty;
    if (!wasDirty) setDraft(null);
  }, [baseline]);

  const allIssues = useMemo(
    () => agentIssues(draft, { projectsAvailable, mode }),
    [draft, projectsAvailable, mode],
  );

  /**
   * **A form nobody has touched does not shout.**
   *
   * `/agents/new` opens with an empty name, so the validation is already failing before the
   * operator has done anything at all. Rendering that as a red `✕ An agent needs a name` on an
   * untouched field accuses someone of a mistake they have not made yet, and — worse — it teaches
   * them that the red text on this screen is decoration, which is exactly what must not happen on
   * the page where two of the messages explain constraints they cannot otherwise discover.
   *
   * So issues are *computed* always (`canSubmit` reads them, and the button is correctly disabled
   * from the first frame) and *shown* only once there is something to be wrong about: the operator
   * has edited something, or they have pressed Save and are owed an explanation.
   */
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const showIssues = submitAttempted || summary.isDirty;

  const issues = useMemo(() => (showIssues ? allIssues : []), [showIssues, allIssues]);
  const blocking = useMemo(() => blockingIssues(issues), [issues]);
  /** Always the real set — the submit gate must not depend on what is on screen. */
  const blockingAll = useMemo(() => blockingIssues(allIssues), [allIssues]);

  const isSaving = create.isPending || update.isPending;
  const disabled = readOnly || isSaving || (mode === 'edit' && agent === null);

  const value = useCallback((name: string): DraftValue | undefined => draft[name], [draft]);
  const text = useCallback((name: string): string => draftString(draft, name), [draft]);

  const isChanged = useCallback(
    (name: string): boolean => summary.changedFields.includes(name),
    [summary],
  );

  const set = useCallback((name: string, next: DraftValue) => {
    setDraft((previous) => ({ ...(previous ?? baselineRef.current), [name]: next }));
  }, []);

  const setScope = useCallback((scope: string) => {
    setDraft((previous) => applyScopeChange(previous ?? baselineRef.current, scope));
  }, []);

  const setPermission = useCallback((path: string, granted: boolean) => {
    setDraft((previous) => applyPermissionChange(previous ?? baselineRef.current, path, granted));
  }, []);

  const discard = useCallback(() => setDraft(null), []);

  const save = useCallback(async (): Promise<boolean> => {
    if (disabled) return false;
    // Whatever happens next, the operator has now asked — so they are owed every message.
    setSubmitAttempted(true);
    // Enforced here as well as on the button, because there are three ways a save starts — the
    // button, `Ctrl+S`, and the navigation guard's own `[Save]` — and only one of them is the
    // button. A guard that could save an unrepresentable agent would walk around the validation by
    // the exact path an operator takes when they are already leaving. `blockingAll`, not
    // `blocking`: the gate must never depend on what happens to be rendered.
    if (blockingAll.length > 0) return false;

    try {
      if (mode === 'create') {
        const submitted = draft;
        const created = await create.mutateAsync({ body: toCreateBody(submitted) });
        setCreatedBaseline(submitted);
        setDraft(null);
        setSavedAt(Date.now());
        setCreatedId(agentIdOf(created));
        return true;
      }

      if (agent === null) return false;
      const body = toPatchBody(baseline, draft);
      // An empty PATCH is not an error and not a request: nothing changed. It happens when the
      // guard's `[Save]` fires on a form whose only "change" was typing a value and typing it
      // back, and issuing it would write an audit entry and an `agent.updated` event for a no-op.
      if (Object.keys(body).length > 0) {
        await update.mutateAsync({ agentId: agent.id, body });
      }
      setDraft(null);
      setSavedAt(Date.now());
      return true;
    } catch {
      // The toast in `mutations.ts` already named the failure with its requestId; the form stays
      // dirty so nothing typed is lost, and the guard refuses to navigate away.
      return false;
    }
  }, [disabled, blockingAll, mode, draft, baseline, agent, create, update]);

  // Publish to the guard while dirty; withdraw when clean or unmounted.
  const saveRef = useRef(save);
  saveRef.current = save;
  const discardRef = useRef(discard);
  discardRef.current = discard;

  const { publish, withdraw } = registry;
  const { isDirty, count } = summary;
  const label =
    mode === 'create'
      ? 'Agent → New agent'
      : `Agent → ${draftString(baseline, AGENT_FIELDS.name) || 'untitled'}`;

  useEffect(() => {
    if (!isDirty) {
      withdraw(PANEL_ID);
      return;
    }
    publish(
      { panelId: PANEL_ID, label, count, secretCount: 0 },
      { save: () => saveRef.current(), discard: () => discardRef.current() },
    );
    return () => withdraw(PANEL_ID);
  }, [isDirty, count, label, publish, withdraw]);

  return {
    mode,
    draft,
    baseline,
    summary,
    issues,
    blocking,
    canSubmit: !disabled && blockingAll.length === 0 && (mode === 'create' || summary.isDirty),
    isSaving,
    savedAt,
    disabled,
    createdId,
    value,
    text,
    isChanged,
    set,
    setScope,
    setPermission,
    discard,
    save,
  };
}
