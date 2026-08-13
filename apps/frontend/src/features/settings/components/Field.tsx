import { type ReactNode, useId, useState } from 'react';

/**
 * The shared field set every Settings panel composes (TDS 05 §7.2, TDS 06 §2.5 Input).
 *
 * §7.2 is explicit that this is "schema-driven rendering, not a generic runtime form
 * generator — each panel is a real component that composes shared fields, so bespoke needs
 * (e.g. Claude Code's cost-budget alert row) don't fight a framework". So these are plain
 * controls with a shared skeleton, not a `<FormRenderer schema={…}>`.
 *
 * Two rules are enforced structurally rather than by review:
 *
 *  - **Control boundaries come from `--color-border-control`**, never from the fill. On this
 *    near-black canvas no darker fill can reach WCAG SC 1.4.11's 3:1 identification floor —
 *    black on `#202020` tops out at 1.29:1 — so the border is the only element that can carry
 *    it (TDS 06 §2.1.2).
 *  - **A changed field is marked individually** with an accent left rule and a `changed`
 *    micro-label, so the Save bar's "3 changes" is verifiable at a glance rather than a
 *    number to be trusted (TDS 06 §5.7).
 */

const CONTROL_CLASS =
  'w-full rounded-sm border bg-transparent px-2 text-sm text-text disabled:opacity-50';

const CONTROL_STYLE = {
  height: 'var(--mc-control-md)',
  borderColor: 'var(--color-border-control)',
  backgroundColor: 'var(--color-surface-inset)',
} as const;

export interface SettingsFieldProps {
  readonly label: string;
  readonly children: (props: { readonly id: string }) => ReactNode;
  readonly changed?: boolean;
  readonly description?: string;
  /** Right-aligned inline hint, e.g. a path validity note. */
  readonly hint?: ReactNode;
}

export function SettingsField({
  label,
  children,
  changed = false,
  description,
  hint,
}: SettingsFieldProps) {
  const id = useId();

  return (
    <div
      data-changed={changed ? 'true' : 'false'}
      className="pl-3"
      style={{
        borderLeft: `2px solid ${changed ? 'var(--color-accent)' : 'transparent'}`,
      }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-text-secondary text-xs">
          {label}
        </label>
        {changed ? (
          <span className="font-medium text-2xs" style={{ color: 'var(--color-accent)' }}>
            changed
          </span>
        ) : null}
      </div>
      {children({ id })}
      {description === undefined ? null : (
        <p className="mt-1 text-2xs text-text-muted leading-150">{description}</p>
      )}
      {hint === undefined ? null : <div className="mt-1 text-2xs">{hint}</div>}
    </div>
  );
}

export function TextControl({
  id,
  value,
  onChange,
  disabled = false,
  mono = false,
  placeholder,
  type = 'text',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Native absolute paths and identifiers are mono, verbatim (F8.1 path rules). */
  mono?: boolean;
  placeholder?: string;
  type?: 'text' | 'time';
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_CLASS}${mono ? ' font-mono' : ''}`}
      style={CONTROL_STYLE}
    />
  );
}

export function NumberControl({
  id,
  value,
  onChange,
  disabled = false,
  min,
  max,
  step,
  prefix,
  suffix,
}: {
  id: string;
  /** `''` is a legal transient state — a half-cleared number input is not `0`. */
  value: number | '';
  onChange: (value: number | '') => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {prefix === undefined ? null : <span className="text-sm text-text-muted">{prefix}</span>}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={value === '' ? '' : String(value)}
        disabled={disabled}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        {...(step === undefined ? {} : { step })}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? '' : Number(raw));
        }}
        className={`${CONTROL_CLASS} font-mono`}
        style={{ ...CONTROL_STYLE, maxWidth: 160 }}
      />
      {suffix === undefined ? null : <span className="text-sm text-text-muted">{suffix}</span>}
    </div>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A `<select>` whose value is not in its option list — or is `''` — renders an explicit
 * **“—  not loaded”** placeholder instead of silently selecting its first option.
 *
 * Without it, a panel whose endpoint the Backend does not serve yet still *looks* configured:
 * a disabled Timezone select would read `Africa/Abidjan` (alphabetically first), a disabled
 * Theme select would read `Dark (default)`, and an operator would have no way to tell a
 * default-shaped guess from a persisted setting. Text inputs get this for free through their
 * placeholder; selects do not, and they are the controls most likely to be believed.
 */
export function SelectControl({
  id,
  value,
  onChange,
  options,
  disabled = false,
  unsetLabel = '— not loaded',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  unsetLabel?: string;
}) {
  const known = options.some((option) => option.value === value);

  return (
    <select
      id={id}
      value={known ? value : ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={CONTROL_CLASS}
      style={CONTROL_STYLE}
    >
      {known ? null : (
        <option value="" disabled>
          {unsetLabel}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Checkbox-backed toggle. A native `input[type=checkbox]` rather than a styled `div` with
 * `role="switch"`: it is keyboard-operable, form-associable and screen-reader-correct for free,
 * and TDS 06 §2.5's Toggle is a visual variant, not a different control.
 */
export function ToggleControl({
  id,
  checked,
  onChange,
  disabled = false,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        // SC 2.5.8: interactive targets are at least 24×24 CSS px.
        style={{ width: 16, height: 16, minWidth: 16, accentColor: 'var(--color-accent)' }}
      />
      <span>{label}</span>
    </label>
  );
}

export function RadioGroupControl({
  name,
  legend,
  value,
  onChange,
  options,
  disabled = false,
}: {
  name: string;
  legend: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="flex flex-wrap gap-4">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex items-center gap-2 text-sm text-text"
          style={{ minHeight: 24 }}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * An ordered list of strings — GitHub's `organizations` and `discoveryRoots`.
 *
 * Order is preserved and a reorder counts as a change (see `dirty.ts`), because these are
 * lists the operator arranged: discovery roots are scanned in order.
 */
export function StringListControl({
  id,
  label,
  values,
  onChange,
  disabled = false,
  mono = false,
  placeholder,
  addLabel = 'Add',
  rowHint,
}: {
  id: string;
  label: string;
  values: readonly string[];
  onChange: (values: readonly string[]) => void;
  disabled?: boolean;
  mono?: boolean;
  placeholder?: string;
  addLabel?: string;
  /** Per-row inline note, e.g. path validity. */
  rowHint?: (value: string) => ReactNode;
}) {
  /**
   * Row identity, tracked alongside the values.
   *
   * Keying by array index would be wrong in the one case that matters: removing a middle row
   * makes React reuse the removed row's DOM node for its successor, so the caret and any
   * `:focus` land on a different path than the one the operator was editing. Ids are minted
   * here because the values themselves are not unique (two empty rows are legal while typing).
   */
  const [rowIds, setRowIds] = useState<readonly number[]>(() => values.map((_, index) => index));

  if (rowIds.length !== values.length) {
    // A wholesale replacement — Discard, a save response, or the first load. Re-key entirely;
    // there is no partial edit to preserve when the array arrived from outside this control.
    setRowIds(values.map((_, index) => index));
  }

  const mutate = (nextValues: readonly string[], nextIds: readonly number[]): void => {
    setRowIds(nextIds);
    onChange(nextValues);
  };

  return (
    <div className="flex flex-col gap-2">
      {values.map((entry, index) => (
        <div key={rowIds[index] ?? index} className="flex items-center gap-2">
          <input
            aria-label={`${label} ${index + 1}`}
            value={entry}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
            className={`${CONTROL_CLASS}${mono ? ' font-mono' : ''}`}
            style={CONTROL_STYLE}
          />
          {rowHint === undefined ? null : (
            <span className="shrink-0 text-2xs">{rowHint(entry)}</span>
          )}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${label} ${index + 1}`}
            onClick={() =>
              mutate(
                values.filter((_, position) => position !== index),
                rowIds.filter((_, position) => position !== index),
              )
            }
            className="shrink-0 rounded-xs border border-border-control text-sm text-text-secondary disabled:opacity-50"
            style={{ minWidth: 24, minHeight: 24, height: 'var(--mc-control-sm)', width: 28 }}
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          id={id}
          disabled={disabled}
          onClick={() =>
            mutate([...values, ''], [...rowIds, (Math.max(-1, ...rowIds) as number) + 1])
          }
          className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
          style={{ height: 'var(--mc-control-sm)', minHeight: 24 }}
        >
          + {addLabel}
        </button>
      </div>
    </div>
  );
}

/** A group heading inside a panel — `EVENTS`, `QUIET HOURS`, `API TOKENS` (§5.7.8, §5.7.11). */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium text-2xs text-text-secondary uppercase">{title}</h3>
      {children}
    </section>
  );
}
