import { type ReactNode, useId } from 'react';
import type { WorkflowFormIssue } from './shape.js';

/**
 * One labelled field of the workflow forms, with **all** of its issues attached.
 *
 * The plural is the reason this exists rather than reusing `teams/fields.tsx`: a team field carries
 * at most one issue, while the `steps` field of a chain can carry several at once — a row with no
 * agent, an eleventh step, and an archived agent are three independent problems with three
 * different fixes, and collapsing them to "the chain is invalid" would send the operator hunting.
 *
 * The controls themselves come from `features/agents/fields.tsx` (`TextControl`, `TextAreaControl`,
 * `SelectControl`), which are already in this feature slice and already carry the token rules —
 * `--color-border-control` for the boundary, never the fill, because on this canvas no darker fill
 * reaches WCAG SC 1.4.11's 3:1 floor.
 */
export function WorkflowField({
  label,
  children,
  description,
  required = false,
  changed = false,
  issues = [],
}: {
  label: string;
  children: (props: { readonly id: string; readonly describedBy?: string }) => ReactNode;
  description?: ReactNode;
  required?: boolean;
  changed?: boolean;
  issues?: readonly WorkflowFormIssue[];
}) {
  const id = useId();
  const issuesId = `${id}-issues`;

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

      {children({ id, ...(issues.length === 0 ? {} : { describedBy: issuesId }) })}

      {description === undefined ? null : (
        <div className="mt-1 text-2xs text-text-muted leading-150">{description}</div>
      )}

      {issues.length === 0 ? null : (
        <ul id={issuesId} className="mt-1 flex flex-col gap-1">
          {issues.map((issue) => (
            <li
              key={`${issue.field}-${issue.message}`}
              data-testid={`workflow-issue-${issue.field}`}
              // `alert` only for the blocking kind: an advisory read aloud the instant a field is
              // cleared would interrupt an operator who is still typing.
              role={issue.severity === 'blocking' ? 'alert' : 'note'}
              className="text-2xs leading-150"
              style={{
                color:
                  issue.severity === 'blocking' ? 'var(--color-danger)' : 'var(--color-warning)',
              }}
            >
              <span aria-hidden="true">{issue.severity === 'blocking' ? '✕' : '▲'}</span>{' '}
              <strong>{issue.message}</strong> <span className="text-text-muted">{issue.why}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
