import type { AgentView } from '../../../lib/agents/index.js';
import { agentScopeLabel } from '../../../lib/agents/index.js';
import type { Project } from '../../../lib/api/index.js';
import { MAX_AGENT_TEAM_MEMBERS, type MemberExclusion, type RosterChoices } from './shape.js';

/**
 * The roster and the project assignment — the two set-valued fields on a team.
 *
 * Both are **checkbox lists over a bounded set**, not multi-selects and not tag inputs, because
 * both answer a question with a small, enumerable, already-known answer: which of this instance's
 * agents are on this team, and which of its projects it works on. A `<select multiple>` hides
 * unchosen options behind a scroll and is close to unusable with a keyboard; a tag input implies
 * free text where only ids are legal.
 *
 * Neither list has a reorder handle. `agent_team_members` has no ordinal and the Backend argues
 * why: a team is a *set*, ordering belongs to PRD §5.6's workflows, and even then it would belong
 * to the workflow rather than to the team (the same five agents can run in two orders in two
 * chains). Members come back sorted by agent name, and that is the order shown.
 */

export interface RosterFieldProps {
  readonly choices: RosterChoices;
  readonly selected: readonly string[];
  readonly onToggle: (agentId: string, on: boolean) => void;
  readonly disabled: boolean;
  /**
   * Members already on the roster that this client cannot re-send: archived agents. They are
   * rendered as seats with a removal affordance rather than hidden, because the save fails while
   * they are listed and hiding them would make the failure unattributable.
   */
  readonly archivedMembers: readonly AgentView[];
  /** True when the agents list could not be read at all. */
  readonly agentsUnavailable: boolean;
}

export function RosterField({
  choices,
  selected,
  onToggle,
  disabled,
  archivedMembers,
  agentsUnavailable,
}: RosterFieldProps) {
  const chosen = new Set(selected);

  return (
    <div data-testid="roster-field">
      {agentsUnavailable ? (
        <p className="text-2xs leading-150" style={{ color: 'var(--color-warning)' }}>
          <span aria-hidden="true">▲</span> The agents list could not be read, so the roster cannot
          be edited here. Everything else on this page still saves.
        </p>
      ) : choices.eligible.length === 0 ? (
        <p data-testid="roster-none-eligible" className="text-sm text-text-secondary leading-150">
          No agent on this instance may sit on this team. The list below says why for each one — the
          usual reason is scope: a global team may hold only global agents.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {choices.eligible.map((agent) => {
            const on = chosen.has(agent.id);
            return (
              <li key={agent.id}>
                <label
                  className="flex items-start gap-2 rounded-sm px-1 py-1 text-sm text-text"
                  style={{ minHeight: 24 }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    aria-label={agent.name}
                    onChange={(event) => onToggle(agent.id, event.target.checked)}
                    style={{
                      width: 16,
                      height: 16,
                      minWidth: 16,
                      marginTop: 4,
                      accentColor: 'var(--color-accent)',
                    }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{agent.name}</span>
                    <span className="text-2xs text-text-muted">
                      {agent.scope.length === 0 ? 'scope not stated' : agentScopeLabel(agent.scope)}
                      {agent.description.length === 0 ? '' : ` · ${agent.description}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {archivedMembers.length > 0 ? (
        <div
          role="note"
          data-testid="roster-archived-members"
          className="mt-2 rounded-sm border p-3"
          style={{
            backgroundColor: 'var(--color-warning-subtle)',
            borderColor: 'var(--color-warning)',
          }}
        >
          <p className="text-sm text-text leading-150">
            <span aria-hidden="true">▲</span>{' '}
            {archivedMembers.length === 1 ? 'One seat is' : `${archivedMembers.length} seats are`}{' '}
            held by an archived agent.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {archivedMembers.map((agent) => (
              <li key={agent.id} className="flex flex-wrap items-center gap-2 text-2xs text-text">
                <span>{agent.name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggle(agent.id, false)}
                  className="rounded-xs border border-border-control px-2 text-2xs text-text disabled:opacity-50"
                  style={{ minHeight: 24 }}
                >
                  Remove from team
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-text-muted leading-150">
            The seat is kept rather than dropped — archiving is reversible, and silently removing
            members would make un-archiving unable to restore the roster. But a save re-states the
            whole roster and the Backend refuses one containing an archived agent, so no roster
            change can be saved until each of these is either removed here or un-archived on the
            Agents screen.
          </p>
        </div>
      ) : null}

      <p className="mt-2 text-2xs text-text-muted leading-150">
        {selected.length} of {MAX_AGENT_TEAM_MEMBERS} seats used. A team is a set, not a sequence —
        there is no ordering here, because order belongs to a workflow and workflows are not built.
      </p>

      <Excluded exclusions={choices.excluded} />
    </div>
  );
}

/** Every agent that exists and cannot sit here, with the Backend's own rule attached. */
function Excluded({ exclusions }: { exclusions: readonly MemberExclusion[] }) {
  if (exclusions.length === 0) return null;

  return (
    <details data-testid="roster-exclusions" className="mt-2 text-2xs text-text-muted">
      <summary className="cursor-pointer" style={{ minHeight: 24 }}>
        {exclusions.length} {exclusions.length === 1 ? 'agent is' : 'agents are'} not eligible for
        this team.
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {exclusions.map((exclusion) => (
          <li key={exclusion.agent.id} data-testid={`roster-excluded-${exclusion.reason}`}>
            <span className="text-text-secondary">{exclusion.agent.name}</span> —{' '}
            {exclusion.explanation}
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface AssignmentFieldProps {
  readonly projects: readonly Project[];
  readonly selected: readonly string[];
  readonly onToggle: (projectId: string, on: boolean) => void;
  readonly disabled: boolean;
  /** A project-scoped team can be assigned only to its own project. */
  readonly restrictedTo: string | null;
  readonly projectsUnavailable: boolean;
}

/**
 * PRD §5.7's "Teams can be assigned per project".
 *
 * **At most one team per project**, enforced by the Backend with a `CONFLICT` naming the team that
 * already holds it. This control cannot know about other teams' assignments without reading every
 * team, so it does not pretend to: it offers every project and lets the refusal arrive as a toast
 * that names the incumbent team — which is more useful than a greyed-out row that says nothing.
 */
export function AssignmentField({
  projects,
  selected,
  onToggle,
  disabled,
  restrictedTo,
  projectsUnavailable,
}: AssignmentFieldProps) {
  const chosen = new Set(selected);
  const offered =
    restrictedTo === null ? projects : projects.filter((project) => project.id === restrictedTo);

  if (projectsUnavailable) {
    return (
      <p className="text-2xs leading-150" style={{ color: 'var(--color-warning)' }}>
        <span aria-hidden="true">▲</span> The projects list could not be read, so assignment cannot
        be edited here.
      </p>
    );
  }

  return (
    <div data-testid="assignment-field">
      {offered.length === 0 ? (
        <p className="text-sm text-text-secondary leading-150">
          {restrictedTo === null
            ? 'This instance has no projects, so there is nothing to assign this team to.'
            : 'This team’s own project is not in the projects list — it may be archived. It is shown as stored and left alone by a save.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {offered.map((project) => (
            <li key={project.id}>
              <label
                className="flex items-center gap-2 rounded-sm px-1 py-1 text-sm text-text"
                style={{ minHeight: 24 }}
              >
                <input
                  type="checkbox"
                  checked={chosen.has(project.id)}
                  disabled={disabled}
                  aria-label={project.name}
                  onChange={(event) => onToggle(project.id, event.target.checked)}
                  style={{
                    width: 16,
                    height: 16,
                    minWidth: 16,
                    accentColor: 'var(--color-accent)',
                  }}
                />
                <span className="truncate">{project.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-2xs text-text-muted leading-150">
        <span aria-hidden="true">ⓘ</span> A project has at most one team. Assigning one that already
        belongs to another team is refused, and the refusal names the team holding it — unassign it
        there first.
        {restrictedTo === null
          ? ''
          : ' This is a project-scoped team, so it can only be assigned to its own project.'}
      </p>
    </div>
  );
}
