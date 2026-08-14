import {
  type AgentView,
  agentOptionLabel,
  bindingConsequence,
  REFUSAL_PENDING_SESSION,
  type RefusedAgentView,
} from '../../lib/agents/index.js';
import { endpoints } from '../../lib/api/index.js';
import type { AgentAvailabilityRead } from './agents.js';

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
 * ## Nothing is missing silently, and nothing here decides what is missing
 *
 * `GET /projects/{id}/available-agents` returns both halves of the answer: the agents that may be
 * bound in this Project, and every agent that may not with the Backend's own sentence attached.
 * This component renders those sentences verbatim. It contains **no rule about bindability** — the
 * client-side transcription that used to live in `lib/agents/binding.ts` is deleted, because a
 * refusal added server-side would have left this dropdown offering an agent the API then rejects.
 *
 * ## Where the answer runs out, it says so
 *
 * Four different silences, rendered four different ways, because *not offered* and *cannot tell
 * whether it would be offered* are different facts: no Project chosen (nothing was asked), the
 * route absent, the read failed, and — the quiet one — a Backend that serves the document without
 * a `refused` array, which offers a trustworthy set with unaccountable absences behind it.
 *
 * ## The Project's team leads
 *
 * The same document flags which of the offered agents are on the Project's assigned team, and they
 * are grouped first under the team's name. That is PRD §5.7's entire payoff: the operator picked
 * five personas to work with, so those five come before the other twenty. It is emphasis only —
 * everything bindable is still in the list, in the same control.
 */

export interface AgentFieldProps {
  readonly read: AgentAvailabilityRead;
  readonly value: string;
  readonly onChange: (agentId: string) => void;
  /** Set when the Project changed underneath a chosen agent and the choice was withdrawn. */
  readonly withdrawn: WithdrawnAgent | null;
  /**
   * Why the control is inert, or `null` when it is live. Rendered as a sentence rather than
   * expressed only as a greyed-out select: a disabled control with no reason invites the operator
   * to hunt for the thing that would enable it.
   */
  readonly disabledReason: string | null;
  /** Field label — `Agent` at launch, and the same word on an existing session. */
  readonly label?: string;
  /**
   * True on the surface that binds an agent to a Session that **already exists**
   * (`PATCH /sessions/{id}`).
   *
   * The availability document is computed with `sessionId: null` — the create-time question — so
   * its `session_not_yet` refusals say "that session does not exist yet", which is untrue here.
   * Rather than reprint a sentence the operator can see is wrong, those rows are re-stated as what
   * they actually are on this screen: something this Backend cannot answer, because it was not
   * asked about this Session.
   */
  readonly sessionExists?: boolean;
}

/** A selection the server would no longer accept, cleared and named. */
export interface WithdrawnAgent {
  readonly name: string;
  /** The server's sentence, or `null` when it did not give one for this agent. */
  readonly explanation: string | null;
}

export function AgentField({
  read,
  value,
  onChange,
  withdrawn,
  disabledReason,
  label = 'Agent',
  sessionExists = false,
}: AgentFieldProps) {
  const selected = read.offered.find((option) => option.agent.id === value) ?? null;
  const disabled = disabledReason !== null || read.status !== 'ready';

  const teamOptions = read.offered.filter((option) => option.onTeam);
  const otherOptions = read.offered.filter((option) => !option.onTeam);
  const teamName = read.team?.name ?? null;
  const grouped = teamOptions.length > 0 && teamName !== null;

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
            <optgroup label={`${teamName} (this project’s team)`}>
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
          read.offered.map((option) => (
            <option key={option.agent.id} value={option.agent.id}>
              {agentOptionLabel(option.agent)}
            </option>
          ))
        )}
      </select>

      {read.team === null || read.team.archivedMemberCount === 0 ? null : (
        <p data-testid="agent-team-archived" className="mt-1 text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> {read.team.archivedMemberCount} of{' '}
          {teamName ?? 'this team'}’s seats {read.team.archivedMemberCount === 1 ? 'is' : 'are'}{' '}
          held by an archived agent and {read.team.archivedMemberCount === 1 ? 'is' : 'are'} not
          offered here —{' '}
          {/* Only claim a short *group* when one is actually rendered; when every seat is retired
              there is no group at all, and pointing at one would be the small kind of lie this
              note exists to prevent. */}
          {grouped
            ? 'which is why the group is shorter than the team.'
            : 'which is why this team leads nothing here.'}
        </p>
      )}

      {disabledReason === null ? null : (
        <p data-testid="agent-field-disabled" className="mt-1 text-2xs text-text-muted leading-150">
          {disabledReason}
        </p>
      )}

      <CannotTell read={read} suppressed={disabledReason !== null} />

      {withdrawn === null ? null : (
        <p
          role="alert"
          data-testid="agent-withdrawn"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> <strong>{withdrawn.name}</strong> was cleared.{' '}
          {withdrawn.explanation ??
            'This project’s availability read no longer offers it, and this Backend did not say why.'}
        </p>
      )}

      {selected === null ? (
        <NoAgentNote offerCount={read.offered.length} answered={read.status === 'ready'} />
      ) : (
        <Consequence agent={selected.agent} />
      )}

      <Excluded
        refused={read.refused}
        refusalsStated={read.refusalsStated}
        answered={read.status === 'ready'}
        unreadable={read.unreadable}
        sessionExists={sessionExists}
      />

      {read.status !== 'ready' || read.unrecognised.length === 0 ? null : (
        <p
          data-testid="agent-availability-unrecognised"
          className="mt-1 text-2xs text-text-muted leading-150"
        >
          <span aria-hidden="true">ⓘ</span> This Backend also served{' '}
          <code className="font-mono">{read.unrecognised.join(', ')}</code> on the availability
          document, which this build does not read. Named rather than dropped: a renamed field is
          how a screen quietly starts saying “cannot tell” about something it was told.
        </p>
      )}
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
function NoAgentNote({ offerCount, answered }: { offerCount: number; answered: boolean }) {
  return (
    <p data-testid="agent-none-note" className="mt-1 text-2xs text-text-muted leading-150">
      <span aria-hidden="true">ⓘ</span> No persona and no tool restrictions — the runtime behaves
      exactly as it does outside Mission Control, governed by this machine’s own Claude Code
      settings.
      {!answered
        ? ''
        : offerCount === 0
          ? ' No agent is offered for this session; the list below says why.'
          : ' Binding an agent adds a system prompt and takes tools away.'}
    </p>
  );
}

/**
 * The four ways this field can have no answer, told apart.
 *
 * Nothing here is an error path in the ordinary sense — the session is creatable without an agent
 * in every one of them. What they have in common is that the screen must not imply it knows
 * something it does not: a picker that renders "no agents are offered" when it never asked, or
 * when the route 404'd, is making a claim about the operator's data out of a fact about the wire.
 */
function CannotTell({ read, suppressed }: { read: AgentAvailabilityRead; suppressed: boolean }) {
  // The caller already stated a more specific reason (e.g. "choose a project first"); a second
  // sentence saying the same thing in weaker words is noise.
  if (suppressed) return null;

  if (read.status === 'unasked') {
    return (
      <p data-testid="agent-unasked" className="mt-1 text-2xs text-text-muted leading-150">
        <span aria-hidden="true">ⓘ</span> Availability is a question about a project, and none is
        chosen — so nothing has been asked and nothing can be offered yet.
      </p>
    );
  }

  if (read.status === 'pending') {
    return (
      <p data-testid="agent-pending" className="mt-1 text-2xs text-text-muted leading-150">
        Reading which agents can be bound here…
      </p>
    );
  }

  if (read.status === 'route_missing') {
    return (
      <p data-testid="agent-route-missing" className="mt-1 text-2xs text-text-muted leading-150">
        <span aria-hidden="true">ⓘ</span> This Backend does not serve{' '}
        <code className="font-mono">/api/v1{endpoints.projects.availableAgents('{id}')}</code>, so
        it cannot say which agents may be bound here — which is a different fact from having no
        agents, and only one of them is fixed by creating one. The session can still be created
        without one.
      </p>
    );
  }

  if (read.status === 'failed') {
    return (
      <p
        data-testid="agent-field-error"
        className="mt-1 text-2xs leading-150"
        style={{ color: 'var(--color-warning)' }}
      >
        <span aria-hidden="true">▲</span> Which agents can be bound here could not be read, so none
        can be offered and no absence can be explained. The session can still be created without
        one.
      </p>
    );
  }

  return null;
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
 * Every agent the server named and did not offer, with the server's own reason.
 *
 * A `<details>` rather than an always-open list: this is now every other agent in the install and
 * on an instance with a few projects it is the longest thing in the dialog. It is *present*,
 * closed, with the count in the summary — which is the difference between a screen that hid
 * something and a screen that filed it.
 *
 * The sentences are not written here. They are the Backend's, identical to the message its
 * `400`/`409` would carry if the operator forced the binding, which is the point of the change
 * that produced them.
 */
function Excluded({
  refused,
  refusalsStated,
  answered,
  unreadable,
  sessionExists,
}: {
  refused: readonly RefusedAgentView[];
  refusalsStated: boolean;
  answered: boolean;
  unreadable: number;
  sessionExists: boolean;
}) {
  if (!answered) return null;

  // The Backend served the document and no refusal array. The offer set is still its answer, so
  // the field works — but nothing here can account for an agent that is missing from it.
  if (!refusalsStated) {
    return (
      <p
        data-testid="agent-refusals-unstated"
        className="mt-2 text-2xs text-text-muted leading-150"
      >
        <span aria-hidden="true">ⓘ</span> This Backend does not say which agents it left out of this
        list, so an agent you can see on the Agents screen and not here cannot be explained. The
        agents offered above are still its own answer.
      </p>
    );
  }

  if (refused.length === 0 && unreadable === 0) return null;

  return (
    <details data-testid="agent-exclusions" className="mt-2 text-2xs text-text-muted">
      <summary className="cursor-pointer" style={{ minHeight: 24 }}>
        {refused.length === 0
          ? 'Some agents could not be read.'
          : `${refused.length} ${refused.length === 1 ? 'agent is' : 'agents are'} not offered here.`}
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {refused.map((entry) => (
          <li key={entry.agentId} data-testid={`agent-excluded-${entry.reason}`}>
            <span className="text-text-secondary">{entry.name}</span> —{' '}
            <RefusalText refusal={entry} sessionExists={sessionExists} />
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

/**
 * The server's sentence, except where this screen knows it was answered for a different moment.
 *
 * `session_not_yet` is the one reason computed from `sessionId: null`. On the create surface that
 * is exactly right and the server's wording is better than anything written here. On the surface
 * that binds an agent to an existing Session it is stale — the Session does exist — so the row
 * degrades to a stated "cannot tell" instead of a confident falsehood.
 */
function RefusalText({
  refusal,
  sessionExists,
}: {
  refusal: RefusedAgentView;
  sessionExists: boolean;
}) {
  if (sessionExists && refusal.reason === REFUSAL_PENDING_SESSION) {
    return (
      <span data-testid="agent-excluded-stale-context">
        scoped to a single session. This Backend answers availability for a <em>new</em> session in
        this project, so it cannot say whether this agent belongs to <em>this</em> one — and this
        screen will not guess.
      </span>
    );
  }

  if (refusal.explanation === null) {
    return (
      <span>
        not offered here (<code className="font-mono">{refusal.reason}</code>). This Backend served
        the reason code and no explanation.
      </span>
    );
  }

  return <span>{refusal.explanation}</span>;
}
