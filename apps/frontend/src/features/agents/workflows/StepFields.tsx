import type { AgentView } from '../../../lib/agents/index.js';
import { agentScopeLabel } from '../../../lib/agents/index.js';
import { SelectControl, TextAreaControl } from '../fields.js';
import { capabilitiesOf } from './consequences.js';
import {
  MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  MAX_AGENT_WORKFLOW_STEPS,
  type StepAgentChoices,
  type StepAgentExclusion,
  type StepDraft,
} from './shape.js';

/**
 * The chain editor — an **ordered** list, which is the one thing a team's roster is not.
 *
 * `agent_team_members` refused an ordinal on the grounds that "order belongs to the workflow"; this
 * is that workflow, and `agent_workflow_steps.ordinal` is the column. So this control has what the
 * roster deliberately lacks: position numbers and move controls.
 *
 * ## Why each row states what its agent may do
 *
 * The same disclosure the pre-run dialog makes, in the place where the chain is *designed*. An
 * operator choosing `Developer → QA → Security` is deciding, without being told, whether three
 * sessions may write to their working tree and run `git push` — and the answer comes from the
 * agents' permissions, which are on a different screen. Putting it here means the dangerous chain
 * is visible while it is being built rather than only in the dialog that starts it.
 *
 * Buttons rather than drag handles for reordering: a chain is at most ten rows, `↑`/`↓` are
 * keyboard-operable for free, and drag-and-drop would need its own accessible fallback anyway.
 */

export interface StepFieldsProps {
  readonly steps: readonly StepDraft[];
  readonly choices: StepAgentChoices;
  readonly agentOf: (agentId: string) => AgentView | null;
  readonly disabled: boolean;
  readonly agentsUnavailable: boolean;
  readonly onChange: (index: number, next: StepDraft) => void;
  readonly onMove: (index: number, direction: -1 | 1) => void;
  readonly onRemove: (index: number) => void;
  readonly onAdd: () => void;
}

export function StepFields({
  steps,
  choices,
  agentOf,
  disabled,
  agentsUnavailable,
  onChange,
  onMove,
  onRemove,
  onAdd,
}: StepFieldsProps) {
  const options = choices.eligible.map((agent) => ({
    value: agent.id,
    label: `${agent.name}${agent.scope.length === 0 ? '' : ` · ${agentScopeLabel(agent.scope)}`}`,
  }));

  return (
    <div data-testid="step-fields">
      {agentsUnavailable ? (
        <p className="text-2xs leading-150" style={{ color: 'var(--color-warning)' }}>
          <span aria-hidden="true">▲</span> The agents list could not be read, so steps cannot be
          chosen here. Everything else on this page still saves.
        </p>
      ) : null}

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.key}>
            <StepRow
              step={step}
              index={index}
              total={steps.length}
              options={options}
              agent={step.agentId.length === 0 ? null : agentOf(step.agentId)}
              disabled={disabled}
              onChange={(next) => onChange(index, next)}
              onMove={(direction) => onMove(index, direction)}
              onRemove={() => onRemove(index)}
            />
          </li>
        ))}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="step-add"
          onClick={onAdd}
          disabled={disabled || steps.length >= MAX_AGENT_WORKFLOW_STEPS}
          className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
          style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
        >
          + Add step
        </button>
        <span className="text-2xs text-text-muted leading-150">
          {steps.length} of {MAX_AGENT_WORKFLOW_STEPS} steps. The ceiling is a database constraint
          rather than a preference: every step is a Session that spends money with no person between
          it and the previous one.
        </span>
      </div>

      <Excluded exclusions={choices.excluded} />
    </div>
  );
}

function StepRow({
  step,
  index,
  total,
  options,
  agent,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  step: StepDraft;
  index: number;
  total: number;
  options: readonly { value: string; label: string }[];
  agent: AgentView | null;
  disabled: boolean;
  onChange: (next: StepDraft) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const position = index + 1;
  const selectId = `step-agent-${step.key}`;
  const taskId = `step-task-${step.key}`;

  return (
    <div
      className="rounded-md border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface-inset)' }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <span
          aria-hidden="true"
          className="flex items-center justify-center rounded-full font-medium text-2xs"
          style={{
            width: 24,
            height: 24,
            backgroundColor: 'var(--color-surface-raised)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {position}
        </span>

        <div className="min-w-0 flex-1">
          <label htmlFor={selectId} className="mb-1 block text-text-secondary text-xs">
            Step {position} runs as
          </label>
          <SelectControl
            id={selectId}
            value={step.agentId}
            disabled={disabled}
            options={options}
            unsetLabel="— choose an agent"
            onChange={(value) => onChange({ ...step, agentId: value })}
          />
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            label={`Move step ${position} earlier`}
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </IconButton>
          <IconButton
            label={`Move step ${position} later`}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </IconButton>
          <IconButton
            label={`Remove step ${position}`}
            disabled={disabled}
            danger
            onClick={onRemove}
          >
            ✕
          </IconButton>
        </div>
      </div>

      <div className="mt-2">
        <label htmlFor={taskId} className="mb-1 block text-text-secondary text-xs">
          What this position is for
        </label>
        <TextAreaControl
          id={taskId}
          rows={2}
          value={step.instructions}
          disabled={disabled}
          placeholder="Review the previous step’s diff for missing tests."
          onChange={(value) => onChange({ ...step, instructions: value })}
        />
        <p className="mt-1 text-2xs text-text-muted leading-150">
          Optional, and it is not the persona — that is the agent’s own instructions. This is the
          standing brief for this position in the chain; the run’s task is what you actually want
          done. All three reach the runtime.
          {step.instructions.trim().length > MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH
            ? ` ${step.instructions.trim().length} characters — the limit is ${MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH}.`
            : ''}
        </p>
      </div>

      <StepCapability agent={agent} chosen={step.agentId.length > 0} />
    </div>
  );
}

/**
 * What this step's agent would be allowed to do — stated while the chain is being designed.
 *
 * Derived by the same function the pre-run dialog uses, so the sentence an operator reads here and
 * the sentence they acknowledge before starting are the same sentence.
 */
function StepCapability({ agent, chosen }: { agent: AgentView | null; chosen: boolean }) {
  if (!chosen) return null;

  if (agent === null) {
    return (
      <p
        data-testid="step-agent-unresolved"
        className="mt-2 text-2xs leading-150"
        style={{ color: 'var(--color-warning)' }}
      >
        <span aria-hidden="true">▲</span> This agent could not be read from this instance, so what
        the step may do cannot be shown here.
      </p>
    );
  }

  const capabilities = capabilitiesOf(agent);

  return (
    <>
      <p
        data-testid="step-capability"
        className="mt-2 text-2xs leading-150"
        style={{
          color: capabilities.canShell ? 'var(--color-warning)' : 'var(--color-text-muted)',
        }}
      >
        <span aria-hidden="true">{capabilities.canShell ? '▲' : 'ⓘ'}</span> {capabilities.summary}
      </p>
      {agent.archivedAt === null ? null : (
        <p
          data-testid="step-agent-archived"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> This agent is archived. A run refuses to start while a
          step names one — un-archive it on the Agents screen, or choose another agent here.
        </p>
      )}
    </>
  );
}

function IconButton({
  label,
  disabled,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-sm border text-sm disabled:opacity-50"
      style={{
        // 28×28 rather than a Tailwind size utility: the numeric spacing ladder in `theme.css` is
        // closed, so `w-7`/`h-7` would emit nothing at all and these would collapse to their text.
        width: 28,
        height: 28,
        minWidth: 24,
        minHeight: 24,
        borderColor: danger ? 'var(--color-danger)' : 'var(--color-border-control)',
        color: danger ? 'var(--color-danger)' : 'var(--color-text)',
      }}
    >
      {children}
    </button>
  );
}

/** Every agent that exists and cannot be a step here, with the rule that excluded it. */
function Excluded({ exclusions }: { exclusions: readonly StepAgentExclusion[] }) {
  if (exclusions.length === 0) return null;

  return (
    <details data-testid="step-exclusions" className="mt-3 text-2xs text-text-muted">
      <summary className="cursor-pointer" style={{ minHeight: 24 }}>
        {exclusions.length} {exclusions.length === 1 ? 'agent is' : 'agents are'} not eligible for
        this workflow.
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {exclusions.map((exclusion) => (
          <li key={exclusion.agent.id} data-testid={`step-excluded-${exclusion.reason}`}>
            <span className="text-text-secondary">{exclusion.agent.name}</span> —{' '}
            {exclusion.explanation}
          </li>
        ))}
      </ul>
    </details>
  );
}
