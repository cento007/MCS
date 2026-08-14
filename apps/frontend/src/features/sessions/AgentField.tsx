import {
  type AgentBindingExclusion,
  type AgentView,
  agentOptionLabel,
  bindingConsequence,
} from '../../lib/agents/index.js';
import { endpoints } from '../../lib/api/index.js';
import type { BindableAgentsRead, ProjectTeamRead } from './agents.js';

/** Stable identity, so the grouping memo below never rebuilds because a default was re-minted. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * The Agent picker (PRD §5.1 `Runtime → Agent → Task`, read right to left).
 *
 * ## None is the default, and stays effortless
 *
 * Most sessions will not use an agent, so `None` is the first option, the initial value, and needs
 * no interaction at all. The field is therefore additive to the Launch dialog rather than another
 * decision standing between the operator and `[Create]`: nothing here is required and nothing here
 * blocks.
 *
 * ## The consequence is shown, not the name
 *
 * Binding an agent does two things, and only one of them is visible in a name. The agent's
 * `instructions` become the runtime's appended system prompt, and its permissions become
 * `disallowedTools` — so **binding an agent removes tools from that session**. That list is served
 * on the Agent resource, derived by the same function the launch path calls, and it is rendered
 * verbatim the moment an agent is selected. An operator who discovers a missing `Bash` tool from
 * the transcript has been taught by the wrong teacher.
 *
 * ## Nothing is missing silently
 *
 * The Backend refuses four kinds of binding (`lib/agents/binding.ts`), so an agent an operator can
 * see on the Agents screen can be absent from this dropdown. Every one of those is listed under
 * the field with the rule that excluded it — because "where did my agent go" is the question this
 * control would otherwise generate, and the answer is never "it does not exist".
 *
 * ## The Project's team leads
 *
 * `GET /projects/{id}/available-agents` says which of the offerable agents are on the Project's
 * assigned team, and they are grouped first under the team's name. That is PRD §5.7's entire
 * payoff: the operator picked five personas to work with, so those five come before the other
 * twenty. It is emphasis only — everything bindable is still in the list, in the same control.
 */

export interface AgentFieldProps {
  readonly read: BindableAgentsRead;
  readonly value: string;
  readonly onChange: (agentId: string) => void;
  /** Set when the Project changed underneath a chosen agent and the choice was withdrawn. */
  readonly withdrawn: AgentBindingExclusion | null;
  /**
   * Why the control is inert, or `null` when it is live. Rendered as a sentence rather than
   * expressed only as a greyed-out select: a disabled control with no reason invites the operator
   * to hunt for the thing that would enable it.
   */
  readonly disabledReason: string | null;
  /** Field label — `Agent` at launch, and the same word on an existing session. */
  readonly label?: string;
  /** The Project's assigned team, for emphasis. Absent is normal and costs nothing. */
  readonly team?: ProjectTeamRead;
}

export function AgentField({
  read,
  value,
  onChange,
  withdrawn,
  disabledReason,
  label = 'Agent',
  team,
}: AgentFieldProps) {
  const selected = read.choices.offerable.find((option) => option.agent.id === value) ?? null;
  const disabled = disabledReason !== null || read.unavailable || read.isError;

  const onTeam = team?.onTeam ?? EMPTY_SET;
  const teamOptions = read.choices.offerable.filter((option) => onTeam.has(option.agent.id));
  const otherOptions = read.choices.offerable.filter((option) => !onTeam.has(option.agent.id));
  const grouped = teamOptions.length > 0 && team?.teamName !== null && team !== undefined;

  return (
    <div data-testid="agent-field">
      <p className="mb-1 text-text-secondary text-xs">{label}</p>

      <select
        value={selected === null ? '' : value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-sm border bg-transparent px-2 text-sm text-text disabled:opacity-50"
        style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
      >
        {/* First, selected by default, and named as a real choice rather than as a blank. */}
        <option value="">None — run without an agent</option>
        {grouped ? (
          <>
            <optgroup label={`${team.teamName} (this project’s team)`}>
              {teamOptions.map((option) => (
                <option key={option.agent.id} value={option.agent.id}>
                  {agentOptionLabel(option.agent)}
                </option>
              ))}
            </optgroup>
            {otherOptions.length === 0 ? null : (
              <optgroup label="Other agents available here">
                {otherOptions.map((option) => (
                  <option key={option.agent.id} value={option.agent.id}>
                    {agentOptionLabel(option.agent)}
                  </option>
                ))}
              </optgroup>
            )}
          </>
        ) : (
          read.choices.offerable.map((option) => (
            <option key={option.agent.id} value={option.agent.id}>
              {agentOptionLabel(option.agent)}
            </option>
          ))
        )}
      </select>

      {team === undefined || team.archivedMemberCount === 0 ? null : (
        <p data-testid="agent-team-archived" className="mt-1 text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> {team.archivedMemberCount} of{' '}
          {team.teamName ?? 'this team'}’s seats {team.archivedMemberCount === 1 ? 'is' : 'are'}{' '}
          held by an archived agent and {team.archivedMemberCount === 1 ? 'is' : 'are'} not offered
          here — which is why the group is shorter than the team.
        </p>
      )}

      {disabledReason === null ? null : (
        <p data-testid="agent-field-disabled" className="mt-1 text-2xs text-text-muted leading-150">
          {disabledReason}
        </p>
      )}

      {read.unavailable ? <RouteMissing /> : null}

      {read.isError ? (
        <p
          data-testid="agent-field-error"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> The agents list could not be read, so none can be
          offered. The session can still be created without one.
        </p>
      ) : null}

      {withdrawn === null ? null : (
        <p
          role="alert"
          data-testid="agent-withdrawn"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> <strong>{withdrawn.agent.name}</strong> was cleared.{' '}
          {withdrawn.explanation}
        </p>
      )}

      {selected === null ? (
        <NoAgentNote offerCount={read.choices.offerable.length} />
      ) : (
        <>
          <Consequence agent={selected.agent} />
          {selected.caveat === null ? null : (
            <p
              data-testid="agent-caveat"
              className="mt-1 text-2xs leading-150"
              style={{ color: 'var(--color-warning)' }}
            >
              <span aria-hidden="true">▲</span> {selected.caveat}
            </p>
          )}
        </>
      )}

      <Excluded exclusions={read.choices.excluded} unreadable={read.unreadable} />
    </div>
  );
}

/**
 * What `None` means, said once.
 *
 * Not decoration: the permission model is subtractive, so "no agent" is the *most* capable session
 * this instance can launch, not the least. That is the opposite of what a dropdown reading `None`
 * usually implies, and it is the sentence that keeps an operator from thinking they have opted out
 * of a restriction by opting out of a persona.
 */
function NoAgentNote({ offerCount }: { offerCount: number }) {
  return (
    <p data-testid="agent-none-note" className="mt-1 text-2xs text-text-muted leading-150">
      <span aria-hidden="true">ⓘ</span> No persona and no tool restrictions — the runtime behaves
      exactly as it does outside Mission Control, governed by this machine’s own Claude Code
      settings.
      {offerCount === 0
        ? ' No agent is offered for this session; the list below says why.'
        : ' Binding an agent adds a system prompt and takes tools away.'}
    </p>
  );
}

/** The chosen agent's effect on the session, in the runtime's own vocabulary. */
function Consequence({ agent }: { agent: AgentView }) {
  const consequence = bindingConsequence(agent);

  return (
    <div
      data-testid="agent-consequence"
      className="mt-2 rounded-sm border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface-inset)' }}
    >
      <p className="text-2xs text-text-secondary leading-150">
        This session will run as <strong className="text-text">{agent.name}</strong>.{' '}
        {consequence.hasPrompt
          ? 'Its instructions are appended to Claude Code’s own system prompt.'
          : 'It carries no prompt, so it changes nothing about how the model is briefed.'}
      </p>

      {consequence.kind === 'not_stated' ? (
        <p
          data-testid="agent-consequence-unknown"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> This Backend does not say which tools this agent
          removes, so the effect on the session cannot be shown here. It is still applied at launch.
        </p>
      ) : consequence.kind === 'removes_nothing' ? (
        <p className="mt-1 text-2xs text-text-muted leading-150">
          It removes no tools, so the session is exactly as capable as one launched with no agent —
          and it keeps this machine’s own MCP servers, which a restricted agent does not.
        </p>
      ) : (
        <>
          <p className="mt-2 text-2xs text-text-secondary leading-150">
            <strong>Removed from the runtime for this session:</strong>
          </p>
          <p className="mt-1 flex flex-wrap gap-1">
            {consequence.tools.map((tool) => (
              <code
                key={tool}
                data-testid="agent-removed-tool"
                className="rounded-xs px-2 py-05 font-mono text-2xs text-text-secondary"
                style={{ backgroundColor: 'var(--color-surface)' }}
              >
                {tool}
              </code>
            ))}
          </p>
          <p className="mt-1 text-2xs text-text-muted leading-150">
            The list is the Backend’s, derived from the agent’s permissions by the same function the
            launch path calls — it is not recomputed here, so the two cannot disagree.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Every agent that exists and is not offered, with the rule that excluded it.
 *
 * A `<details>` rather than an always-open list: on an instance with a few projects this is the
 * longest thing in the dialog and it is not what the operator came for. It is *present*, closed,
 * with the count in the summary — which is the difference between a screen that hid something and
 * a screen that filed it.
 */
function Excluded({
  exclusions,
  unreadable,
}: {
  exclusions: readonly AgentBindingExclusion[];
  unreadable: number;
}) {
  if (exclusions.length === 0 && unreadable === 0) return null;

  return (
    <details data-testid="agent-exclusions" className="mt-2 text-2xs text-text-muted">
      <summary className="cursor-pointer" style={{ minHeight: 24 }}>
        {exclusions.length === 0
          ? 'Some agents could not be read.'
          : `${exclusions.length} ${exclusions.length === 1 ? 'agent is' : 'agents are'} not offered here.`}
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {exclusions.map((exclusion) => (
          <li key={exclusion.agent.id} data-testid={`agent-excluded-${exclusion.reason}`}>
            <span className="text-text-secondary">{exclusion.agent.name}</span> —{' '}
            {exclusion.explanation}
          </li>
        ))}
        {unreadable === 0 ? null : (
          <li data-testid="agent-unreadable">
            {unreadable} {unreadable === 1 ? 'row was' : 'rows were'} served without an id or a name
            and {unreadable === 1 ? 'is' : 'are'} not offered. The count is here rather than
            nowhere: a list that is quietly short looks exactly like one that is genuinely short.
          </li>
        )}
      </ul>
    </details>
  );
}

function RouteMissing() {
  return (
    <p data-testid="agent-route-missing" className="mt-1 text-2xs text-text-muted leading-150">
      <span aria-hidden="true">ⓘ</span> This Backend does not serve{' '}
      <code className="font-mono">/api/v1{endpoints.agents.list}</code>, so no agent can be chosen.
      That is a different fact from having no agents, and only one of them is fixed by creating one.
    </p>
  );
}
