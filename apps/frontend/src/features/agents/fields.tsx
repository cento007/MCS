import { type ReactNode, useId } from 'react';
import type { AgentFormIssue } from './shape.js';

/**
 * The Agent Builder's field set (TDS 06 §2.5 Input, §5.7).
 *
 * Local to this slice on purpose, and that is the house pattern rather than an exception: TDS 05
 * §7.2 calls for "schema-driven rendering, not a generic runtime form generator — each panel is a
 * real component that composes shared fields, so bespoke needs don't fight a framework", and
 * `features/projects/CreateProjectModal.tsx` writes its own controls the same way. The *tokens*
 * are shared and the *contract* (`lib/forms/dirty.ts`) is shared; the markup is three elements.
 *
 * Two rules are structural rather than reviewed:
 *
 *  - **Control boundaries come from `--color-border-control`**, never from the fill: on this
 *    near-black canvas no darker fill reaches WCAG SC 1.4.11's 3:1 identification floor (TDS 06
 *    §2.1.2).
 *  - **A changed field marks itself** with an accent left rule and a `changed` micro-label, so
 *    the Save bar's count is verifiable at a glance rather than trusted.
 */

const CONTROL_CLASS =
  'w-full rounded-sm border bg-transparent px-2 text-sm text-text disabled:opacity-50';

const CONTROL_STYLE = {
  height: 'var(--mc-control-md)',
  borderColor: 'var(--color-border-control)',
  backgroundColor: 'var(--color-surface-inset)',
} as const;

export interface AgentFieldProps {
  readonly label: string;
  readonly children: (props: { readonly id: string; readonly describedBy?: string }) => ReactNode;
  readonly changed?: boolean;
  readonly description?: ReactNode;
  /** Required-ness stated in the label, because a bare red border after the fact is not a hint. */
  readonly required?: boolean;
  /** The one issue attached to this field, blocking or advisory. */
  readonly issue?: AgentFormIssue | undefined;
}

/**
 * One labelled field, with its issue attached.
 *
 * The issue renders **both halves**: what is wrong and why it cannot be saved. A form that only
 * says "required" tells an operator that the software wants something; it does not tell them that
 * a project-scoped agent without a project is a row the database will not hold, or that the way
 * out is the Global scope rather than a project they do not want to pick.
 */
export function AgentField({
  label,
  children,
  changed = false,
  description,
  required = false,
  issue,
}: AgentFieldProps) {
  const id = useId();
  const issueId = `${id}-issue`;
  const blocking = issue?.severity === 'blocking';

  return (
    <div
      data-changed={changed ? 'true' : 'false'}
      className="pl-3"
      style={{ borderLeft: `2px solid ${changed ? 'var(--color-accent)' : 'transparent'}` }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-text-secondary text-xs">
          {label}
          {required ? (
            <span className="ml-1 text-text-muted" title="Required">
              *
            </span>
          ) : null}
        </label>
        {changed ? (
          <span className="font-medium text-2xs" style={{ color: 'var(--color-accent)' }}>
            changed
          </span>
        ) : null}
      </div>

      {children({ id, ...(issue === undefined ? {} : { describedBy: issueId }) })}

      {description === undefined ? null : (
        <div className="mt-1 text-2xs text-text-muted leading-150">{description}</div>
      )}

      {issue === undefined ? null : (
        <p
          id={issueId}
          data-testid={`issue-${issue.field}`}
          // `alert` only for the blocking kind: an advisory note read aloud the instant a field is
          // cleared would interrupt an operator who is still typing.
          role={blocking ? 'alert' : 'note'}
          className="mt-1 text-2xs leading-150"
          style={{ color: blocking ? 'var(--color-danger)' : 'var(--color-warning)' }}
        >
          <span aria-hidden="true">{blocking ? '✕' : '▲'}</span> <strong>{issue.message}</strong>{' '}
          <span className="text-text-muted">{issue.why}</span>
        </p>
      )}
    </div>
  );
}

export function TextControl({
  id,
  describedBy,
  value,
  onChange,
  disabled = false,
  placeholder,
  invalid = false,
  mono = false,
  maxLength,
}: {
  id: string;
  describedBy?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  mono?: boolean;
  /**
   * The Backend's own ceiling, so a `400` becomes an input that stops accepting characters.
   * Deliberately **not** applied to the prompt: silently truncating a pasted persona at 20 000
   * characters would lose the end of it with no visible event, so that one is validated and
   * counted instead.
   */
  maxLength?: number;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_CLASS}${mono ? ' font-mono' : ''}`}
      style={{
        ...CONTROL_STYLE,
        ...(invalid ? { borderColor: 'var(--color-danger)' } : {}),
      }}
    />
  );
}

export function TextAreaControl({
  id,
  describedBy,
  value,
  onChange,
  disabled = false,
  placeholder,
  rows = 3,
  tall = false,
  mono = false,
}: {
  id: string;
  describedBy?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  /**
   * The Prompt. `minHeight` comes from `--mc-prompt-min-h` rather than a `min-h-*` utility:
   * `theme.css` closes the arbitrary spacing ladder, so any numeric spacing utility outside
   * `0 05 1 2 3 4 6 8 16` is resolved to an invalid declaration and dropped **silently** — the
   * control would simply stay at its default height with nothing to see in the class list.
   */
  tall?: boolean;
  mono?: boolean;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`w-full resize-y rounded-sm border bg-transparent p-2 text-sm text-text leading-150 disabled:opacity-50${
        mono ? ' font-mono' : ''
      }`}
      style={{
        borderColor: 'var(--color-border-control)',
        backgroundColor: 'var(--color-surface-inset)',
        ...(tall ? { minHeight: 'var(--mc-prompt-min-h)' } : {}),
      }}
    />
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A `<select>` whose value is not in its option list renders an explicit placeholder rather than
 * silently selecting its first option — the same rule Settings enforces, and for the same reason:
 * a select is the control most likely to be believed, because it always looks answered.
 */
export function SelectControl({
  id,
  describedBy,
  value,
  onChange,
  options,
  disabled = false,
  unsetLabel = '— choose',
  invalid = false,
}: {
  id: string;
  describedBy?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  unsetLabel?: string;
  invalid?: boolean;
}) {
  const known = options.some((option) => option.value === value);

  return (
    <select
      id={id}
      value={known ? value : ''}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={CONTROL_CLASS}
      style={{
        ...CONTROL_STYLE,
        ...(invalid ? { borderColor: 'var(--color-danger)' } : {}),
      }}
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
 * Checkbox-backed toggle — a native `input[type=checkbox]`, not a styled `div` with
 * `role="switch"`: keyboard-operable, form-associable and screen-reader-correct for free.
 */
export function ToggleControl({
  id,
  describedBy,
  checked,
  onChange,
  disabled = false,
  label,
}: {
  id: string;
  describedBy?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-2 text-sm text-text"
      style={{ minHeight: 24 }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.checked)}
        style={{ width: 16, height: 16, minWidth: 16, accentColor: 'var(--color-accent)' }}
      />
      <span>{label}</span>
    </label>
  );
}

/** A titled section of the Builder — the PRD §5.8 section list, in PRD order. */
export function BuilderSection({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      className="rounded-md border border-border"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b px-4 py-3">
        <h2 className="font-medium text-2xs text-text-secondary uppercase">{title}</h2>
        {action}
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        {description === undefined ? null : (
          <div className="text-sm text-text-secondary leading-150">{description}</div>
        )}
        {children}
      </div>
    </section>
  );
}
