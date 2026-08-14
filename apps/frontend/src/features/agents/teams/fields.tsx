import { type ReactNode, useId } from 'react';
import type { TeamFormIssue } from './shape.js';

/**
 * The team form's controls.
 *
 * Deliberately a small local set rather than an import of `features/agents/fields.tsx`: those are
 * built around `AgentFormIssue` and the Builder's seven-section layout, and threading a second
 * issue type through them to serve a two-field dialog would make the Builder's field component
 * generic for the sake of one caller. TDS 05 §7.2 asks for "real components that compose shared
 * tokens", not a form framework — the *tokens* are shared, and the markup is three elements.
 *
 * `--color-border-control` for the boundary, never the fill: on this canvas no darker fill reaches
 * WCAG SC 1.4.11's 3:1 identification floor (TDS 06 §2.1.2).
 */

const CONTROL_CLASS =
  'w-full rounded-sm border bg-transparent px-2 text-sm text-text disabled:opacity-50';

const CONTROL_STYLE = {
  height: 'var(--mc-control-md)',
  borderColor: 'var(--color-border-control)',
  backgroundColor: 'var(--color-surface-inset)',
} as const;

export function TeamField({
  label,
  children,
  description,
  required = false,
  changed = false,
  issue,
}: {
  label: string;
  children: (props: { readonly id: string; readonly describedBy?: string }) => ReactNode;
  description?: ReactNode;
  required?: boolean;
  changed?: boolean;
  issue?: TeamFormIssue | undefined;
}) {
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
          data-testid={`team-issue-${issue.field}`}
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

export function TeamTextControl({
  id,
  describedBy,
  value,
  onChange,
  disabled = false,
  maxLength,
  placeholder,
}: {
  id: string;
  describedBy?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={CONTROL_CLASS}
      style={CONTROL_STYLE}
    />
  );
}

export function TeamTextArea({
  id,
  describedBy,
  value,
  onChange,
  disabled = false,
  rows = 3,
}: {
  id: string;
  describedBy?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  rows?: number;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className="w-full resize-y rounded-sm border bg-transparent p-2 text-sm text-text leading-150 disabled:opacity-50"
      style={{
        borderColor: 'var(--color-border-control)',
        backgroundColor: 'var(--color-surface-inset)',
      }}
    />
  );
}
