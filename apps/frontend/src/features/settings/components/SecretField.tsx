import { useId, useState } from 'react';
import { ConfirmDialog } from '../../../components/Modal.js';
import { formatDateTime } from '../../../lib/format/index.js';
import type { PanelForm } from '../form.js';
import type { SecretFieldRead } from '../types.js';

/**
 * `SecretField` — write-only credentials, end to end (PRD §4.4, TDS 05 §7.3, TDS 06 §4.4).
 *
 * The API never returns a secret value; the client never holds one outside the request body it
 * is being written in. What is on screen is therefore a *state machine over presence*, not a
 * value:
 *
 *   not set   →  empty password input, placeholder "Not set"
 *   set       →  `•••••••••••• (saved ‹timestamp›)` + [Replace] [Clear]
 *   replacing →  fresh EMPTY password input + [Cancel]        (never pre-filled)
 *
 * **`[Replace]` unlocks the input and nothing else.** There is no `[Save]` here — the panel's
 * sticky `[Save changes]` bar is the single commit path. §4.4 spells out why in the strongest
 * terms available: a save button inside a field that sits above a panel-level save bar creates
 * the worst failure mode on this screen — the operator pastes a token, clicks the nearer
 * button, sees *something* confirm, navigates away, and cannot tell whether the credential
 * persisted, because the one value the UI is forbidden to read back is a secret. One commit
 * path removes the ambiguity structurally rather than by convention.
 *
 * **`[Clear]` is the sole exception, and it is not an edit.** Destroying a credential is a
 * destructive action with its own confirm modal, committed on its own (§4.4: "not batched
 * behind `[Save changes]` — destroying a credential is not an edit, and pairing it with a
 * batched save invites clearing-by-accident").
 *
 * Label vocabulary is canonical and closed: `Replace` / `Clear`. Never `Remove`, never
 * `Delete` (TDS 05 §7.3).
 */

export interface SecretFieldProps<TDoc> {
  readonly form: PanelForm<TDoc>;
  /** Dotted field path, e.g. `token` or `apiKey`. */
  readonly name: string;
  readonly label: string;
  /** The §7.1 read shape from the persisted document. */
  readonly current: SecretFieldRead | null;
  /** Body of the `[Clear]` confirm, naming what stops working (§4.4). */
  readonly clearConsequence: string;
  readonly autoComplete?: string;
}

export function SecretField<TDoc>({
  form,
  name,
  label,
  current,
  clearConsequence,
  autoComplete = 'off',
}: SecretFieldProps<TDoc>) {
  const inputId = useId();
  const secret = form.secretOf(name);
  const [visible, setVisible] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const isSet = current?.isSet === true;
  const savedAt = current?.updatedAt ?? null;
  const changed = secret.replacing && secret.value.length > 0;

  const controlStyle = {
    height: 'var(--mc-control-md)',
    borderColor: 'var(--color-border-control)',
    backgroundColor: 'var(--color-surface-inset)',
  } as const;

  return (
    <div
      data-testid={`secret-${name}`}
      data-changed={changed ? 'true' : 'false'}
      data-state={secret.replacing ? 'replacing' : isSet ? 'set' : 'unset'}
      className="pl-3"
      style={{ borderLeft: `2px solid ${changed ? 'var(--color-accent)' : 'transparent'}` }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-text-secondary text-xs">
          {label}
        </label>
        {changed ? (
          <span className="font-medium text-2xs" style={{ color: 'var(--color-accent)' }}>
            changed
          </span>
        ) : null}
      </div>

      {secret.replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={inputId}
            // Toggleable to visible while typing (§7.3) — a pasted credential the operator
            // cannot read back is a credential they cannot check before committing.
            type={visible ? 'text' : 'password'}
            value={secret.value}
            autoComplete={autoComplete}
            spellCheck={false}
            disabled={form.disabled}
            placeholder={`New ${label.toLowerCase()}`}
            onChange={(event) => form.setSecretValue(name, event.target.value)}
            className="min-w-0 flex-1 rounded-sm border bg-transparent px-2 font-mono text-sm text-text disabled:opacity-50"
            style={controlStyle}
          />
          <button
            type="button"
            onClick={() => setVisible((shown) => !shown)}
            className="rounded-sm border border-border-control px-2 text-text-secondary text-xs"
            style={{ height: 'var(--mc-control-sm)', minHeight: 24, minWidth: 24 }}
          >
            {visible ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={() => {
              setVisible(false);
              form.cancelReplace(name);
            }}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-sm)', minHeight: 24 }}
          >
            Cancel
          </button>
        </div>
      ) : isSet ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            id={inputId}
            data-testid={`secret-mask-${name}`}
            className="font-mono text-sm text-text-secondary"
          >
            ••••••••••••
          </span>
          <span data-testid={`secret-saved-${name}`} className="text-2xs text-text-muted">
            {savedAt === null ? '(saved)' : `(saved ${formatDateTime(savedAt)})`}
          </span>
          <button
            type="button"
            disabled={form.disabled}
            onClick={() => form.beginReplace(name)}
            className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
            style={{ height: 'var(--mc-control-sm)', minHeight: 24 }}
          >
            Replace
          </button>
          <button
            type="button"
            disabled={form.disabled}
            onClick={() => setConfirmingClear(true)}
            className="rounded-sm px-3 text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-sm)',
              minHeight: 24,
              color: 'var(--color-danger)',
            }}
          >
            Clear
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={inputId}
            type="password"
            value=""
            readOnly
            disabled
            placeholder="Not set"
            className="min-w-0 flex-1 rounded-sm border bg-transparent px-2 font-mono text-sm text-text disabled:opacity-50"
            style={controlStyle}
          />
          <button
            type="button"
            disabled={form.disabled}
            onClick={() => form.beginReplace(name)}
            className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
            style={{ height: 'var(--mc-control-sm)', minHeight: 24 }}
          >
            Set
          </button>
        </div>
      )}

      <p className="mt-1 text-2xs text-text-muted leading-150">
        Secrets are encrypted at rest and cannot be viewed after saving.
      </p>

      <ConfirmDialog
        open={confirmingClear}
        title={`Clear ${label.toLowerCase()}?`}
        body={clearConsequence}
        confirmLabel="Clear"
        destructive
        pending={clearing}
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setClearing(true);
          void form.clearSecret(name).finally(() => {
            setClearing(false);
            setConfirmingClear(false);
          });
        }}
      />
    </div>
  );
}
