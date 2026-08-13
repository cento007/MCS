import type { GlobalWorkflowModeRead } from './queries.js';

/**
 * The per-Project **Workflow mode override** (PRD §4.3, TDS 04 §4, TDS 06 §5.3.2 / WC13).
 *
 * `Project.workflowMode` is three-valued and the third value is the point: `null` means
 * *inherit* `integrations.github.workflowMode`, so the effective mode is
 * `project.workflowMode ?? global`. A two-valued control could not express "follow the global
 * default", and a Project that had silently been pinned to `manual` at creation would not change
 * when the operator later changed the global setting — the divergence would be invisible.
 *
 * Two rules this control exists to keep:
 *
 *  1. **Inherit is a selectable state, not the absence of a selection.** §5.3.2's wireframe puts
 *     "follow global" behind a `⋯` menu item; it is rendered here as the third radio instead.
 *     The three states are mutually exclusive and equally reachable, which is exactly what a
 *     radio group means — and it puts the escape from an override in the same place, and the
 *     same tab stop, as the override itself rather than behind a menu the operator must guess at.
 *  2. **The global default is named, or admitted to be unknown.** `Follow global default
 *     (Manual)` is only honest when the settings document was actually read; when it was not,
 *     the label says so rather than guessing a value the operator would then rely on.
 */

export type WorkflowModeValue = 'manual' | 'assisted' | null;

export const WORKFLOW_MODE_LABELS: Readonly<Record<'manual' | 'assisted', string>> = {
  manual: 'Manual',
  assisted: 'Assisted',
};

/** The label of the inherit option, including the resolved global default when one is known. */
export function inheritLabel(globalMode: GlobalWorkflowModeRead): string {
  if (globalMode.isPending) return 'Follow global default';
  if (globalMode.mode === null) return 'Follow global default (not readable)';
  return `Follow global default (${WORKFLOW_MODE_LABELS[globalMode.mode]})`;
}

/**
 * The sentence under the control. It states the **effective** mode, because that is the thing
 * the operator actually wants to know and it is never displayed by the radios alone.
 */
export function effectiveModeSentence(
  value: WorkflowModeValue,
  globalMode: GlobalWorkflowModeRead,
): string {
  if (value !== null) {
    return `This project overrides the global default and uses ${WORKFLOW_MODE_LABELS[value]}.`;
  }
  if (globalMode.mode !== null) {
    return `This project follows the global default, currently ${WORKFLOW_MODE_LABELS[globalMode.mode]}.`;
  }
  return 'This project follows the global default. Mission Control could not read the global setting, so the effective mode is unknown.';
}

export interface WorkflowModeRadiosProps {
  /** `name` must be unique per rendered group — two groups sharing it would fight. */
  readonly name: string;
  readonly value: WorkflowModeValue;
  readonly globalMode: GlobalWorkflowModeRead;
  readonly onChange: (value: WorkflowModeValue) => void;
  readonly disabled?: boolean;
}

const INHERIT_TOKEN = '__inherit__';

export function WorkflowModeRadios({
  name,
  value,
  globalMode,
  onChange,
  disabled = false,
}: WorkflowModeRadiosProps) {
  const options: readonly { token: string; label: string; next: WorkflowModeValue }[] = [
    { token: 'manual', label: WORKFLOW_MODE_LABELS.manual, next: 'manual' },
    { token: 'assisted', label: WORKFLOW_MODE_LABELS.assisted, next: 'assisted' },
    { token: INHERIT_TOKEN, label: inheritLabel(globalMode), next: null },
  ];

  const selected = value ?? INHERIT_TOKEN;

  return (
    <fieldset disabled={disabled} className="flex flex-wrap gap-4 border-0 p-0">
      <legend className="sr-only">Workflow mode</legend>
      {options.map((option) => (
        <label
          key={option.token}
          className="flex items-center gap-2 text-sm text-text"
          style={{ minHeight: 24 }}
        >
          <input
            type="radio"
            name={name}
            value={option.token}
            checked={selected === option.token}
            onChange={() => onChange(option.next)}
            style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
          />
          {option.label}
          {/* The `(global)` chip of §5.3.2: it marks the option that *matches* the global
              default, so an operator can see at a glance when an explicit override is saying
              the same thing the inherited default already said. */}
          {option.next !== null && globalMode.mode === option.next ? (
            <span
              className="rounded-xs border border-border px-1 text-2xs text-text-muted"
              title="This is also the current global default."
            >
              global
            </span>
          ) : null}
        </label>
      ))}
    </fieldset>
  );
}
