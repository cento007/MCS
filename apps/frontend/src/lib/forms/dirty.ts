/**
 * The dirty-state contract, as pure functions (TDS 06 §5.7 "Dirty-state contract (uniform
 * across every Settings panel)", §4.4).
 *
 * Settings is the one screen where a silently-lost edit is expensive — half of it is
 * credentials and integration wiring whose failure surfaces later, somewhere else, as a broken
 * integration. So the contract is stated rather than implied, and it is stated *here*, with no
 * DOM, so the wording and the counting are directly assertable:
 *
 *  - the Save bar names the **count** of changed fields (`1 change` singular);
 *  - a secret in Replace mode with typed content counts as one change and is called out
 *    (`3 changes (incl. 1 secret)`), because a secret is the one field whose value the
 *    operator cannot verify by looking at it;
 *  - each changed field is individually marked, so the number is verifiable rather than
 *    trusted.
 *
 * ## Why this lives in `lib/` and not in `features/settings/`
 *
 * It was written for Settings and moved here unchanged when the **Agent Builder** (Phase 4)
 * became the second editable surface a person can navigate away from mid-edit. TDS 05 §2.1
 * forbids cross-feature imports — a feature slice may only reach `components/`, `lib/` and
 * `stores/` — so the alternatives were a second implementation of the same contract or this
 * move, and two implementations of "how many unsaved changes are there" is exactly how the
 * Agent Builder ends up warning about 2 changes while Settings would have said 3.
 *
 * The secret-field vocabulary stays in the shared file even though only Settings has secrets:
 * `summarizeDirty` is the one function both surfaces call, and splitting it into a
 * secret-aware and a secret-blind copy would recreate the divergence this move prevents.
 */

/** Everything a Settings control can hold. Nested API objects are flattened into dotted paths. */
export type DraftValue = string | number | boolean | readonly string[];

export type Draft = Readonly<Record<string, DraftValue>>;

/**
 * A secret field's editor state.
 *
 * `replacing` is the `[Replace]` unlock. It is **not** itself a change: unlocking an empty
 * input and typing nothing has altered nothing, and counting it would make `[Discard]` claim
 * to be discarding something. Only typed content is a change.
 */
export interface SecretDraft {
  readonly replacing: boolean;
  readonly value: string;
}

export const IDLE_SECRET: SecretDraft = Object.freeze({ replacing: false, value: '' });

export type SecretDrafts = Readonly<Record<string, SecretDraft>>;

export interface DirtySummary {
  /** Dotted field paths whose value differs from the persisted baseline, in field order. */
  readonly changedFields: readonly string[];
  /** Secret field names carrying typed replacement content. */
  readonly changedSecrets: readonly string[];
  readonly count: number;
  readonly secretCount: number;
  readonly isDirty: boolean;
}

export const CLEAN: DirtySummary = Object.freeze({
  changedFields: [],
  changedSecrets: [],
  count: 0,
  secretCount: 0,
  isDirty: false,
});

/**
 * Value equality for a settings field.
 *
 * Arrays compare element-wise and **order-sensitively**: `discoveryRoots` and
 * `organizations` are ordered lists the operator arranged, so a reorder is a real change the
 * Save bar must report. Numbers compare with `Object.is` so `NaN` (a half-typed number input)
 * is stable rather than reporting itself changed on every keystroke.
 */
export function isSameValue(a: DraftValue | undefined, b: DraftValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => item === b[index]);
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  return Object.is(a, b);
}

/**
 * Fields whose draft value differs from the baseline.
 *
 * Iterates the union of both key sets so a field the server stopped returning is still
 * reported rather than silently dropping out of the count.
 */
export function changedFieldNames(baseline: Draft, draft: Draft): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const key of [...Object.keys(draft), ...Object.keys(baseline)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isSameValue(draft[key], baseline[key])) names.push(key);
  }
  return names;
}

/** Secret fields carrying typed replacement content. `[Clear]` is never counted — see below. */
export function changedSecretNames(secrets: SecretDrafts): readonly string[] {
  return Object.keys(secrets).filter((name) => {
    const draft = secrets[name];
    if (draft === undefined) return false;
    return draft.replacing && draft.value.length > 0;
  });
}

export function summarizeDirty(
  baseline: Draft,
  draft: Draft,
  secrets: SecretDrafts = {},
): DirtySummary {
  const changedFields = changedFieldNames(baseline, draft);
  const changedSecrets = changedSecretNames(secrets);
  const count = changedFields.length + changedSecrets.length;

  return {
    changedFields,
    changedSecrets,
    count,
    secretCount: changedSecrets.length,
    isDirty: count > 0,
  };
}

/**
 * The Save bar's count line (TDS 06 §5.7, §4.4).
 *
 * "A bare `[Save changes]` tells the operator that *something* is unsaved without telling them
 * how much they are about to lose by discarding." The secret parenthetical exists because a
 * discarded secret is the one edit that cannot be reconstructed by looking at the screen.
 */
export function changeCountLabel(summary: DirtySummary): string {
  if (summary.count === 0) return '';
  const base = summary.count === 1 ? '1 change' : `${summary.count} changes`;
  if (summary.secretCount === 0) return base;
  const secrets = summary.secretCount === 1 ? '1 secret' : `${summary.secretCount} secrets`;
  return `${base} (incl. ${secrets})`;
}

/** One dirty panel, as the guard modal and the route blocker see it. */
export interface DirtyPanel {
  readonly panelId: string;
  /** Breadcrumb the guard modal quotes verbatim, e.g. `Integrations → GitHub`. */
  readonly label: string;
  readonly count: number;
  readonly secretCount: number;
}

/**
 * The guard modal's body (TDS 06 §5.7): *"Unsaved changes — you have 3 unsaved changes in
 * Integrations → GitHub."*
 *
 * The multi-panel wording is not in the wireframe because the wireframe assumes one panel at a
 * time — but the Integrations category renders six independently-savable cards, so two of them
 * can be dirty at once and the modal must not name only one of them. Naming every dirty panel
 * keeps the promise the single-panel sentence makes: the operator can see exactly what they
 * are about to lose.
 */
export function unsavedChangesMessage(panels: readonly DirtyPanel[]): string {
  const total = panels.reduce((sum, panel) => sum + panel.count, 0);
  const changes = total === 1 ? '1 unsaved change' : `${total} unsaved changes`;

  if (panels.length === 0) return 'You have no unsaved changes.';
  if (panels.length === 1) {
    return `You have ${changes} in ${(panels[0] as DirtyPanel).label}.`;
  }
  return `You have ${changes} across ${panels.length} panels: ${panels
    .map((panel) => panel.label)
    .join(', ')}.`;
}
