import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal.js';
import { type AgentView, bindingConsequence, sessionBindability } from '../../lib/agents/index.js';
import type { Session } from '../../lib/api/index.js';
import { AgentField } from './AgentField.js';
import { useAgentAvailability, useSessionAgent } from './agents.js';

/**
 * Which Agent a Session runs — or ran — as (PRD §5.1).
 *
 * ## Why this is on the identity surfaces rather than in a panel tab
 *
 * A Session bound to an agent had a system prompt appended and a set of tools removed. Neither is
 * visible in the transcript: a denied tool produces *nothing* — no error, no line, just a step the
 * model did not take — so a Session whose agent is not stated is a Session whose behaviour cannot
 * be explained afterwards. "Why did it not run the tests?" has two completely different answers
 * depending on whether `Bash` was in that session's deny list, and only one of them is a bug.
 *
 * So the agent appears wherever the Session is identified: as a chip in the list row, and as a
 * stated line with its consequences in the detail header.
 *
 * ## Bindable, or a fact
 *
 * `PATCH /sessions/{id}` accepts `agentId` **only while the Session is `created`**, and only for a
 * `managed` one (`lib/agents/binding.ts` carries the rule). Past that the header shows the agent as
 * a fact with the reason attached rather than as a disabled control — a greyed-out select invites
 * the operator to look for the thing that would re-enable it, and there is nothing.
 */

/** The compact chip: a name where there is one, an honest stand-in where there is not. */
export function SessionAgentTag({
  agentId,
  agent,
  unreadable = false,
}: {
  agentId: string;
  /** The resolved Agent, or `null` while it is loading / when it could not be read. */
  agent: AgentView | null;
  unreadable?: boolean;
}) {
  const label = agent?.name ?? (unreadable ? `agent ${agentId.slice(-6)}` : '…');

  return (
    <span
      data-testid="session-agent-tag"
      title={
        agent === null
          ? `This session ran as agent ${agentId}.`
          : `This session runs as ${agent.name}${
              agent.archivedAt === null ? '' : ' (since archived)'
            }.`
      }
      className="inline-flex items-center gap-1 rounded-xs px-2 py-05 text-2xs"
      style={{ backgroundColor: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}
    >
      <span aria-hidden="true">◆</span> {label}
    </span>
  );
}

export interface SessionAgentLineProps {
  readonly session: Session;
  readonly onBind: (agentId: string | null) => void;
  readonly saving: boolean;
}

/**
 * The detail header's agent line.
 *
 * Absent only in the one case where it would be noise: a Session with no agent that can no longer
 * be given one. Everything else — bound, or bindable — is stated.
 */
export function SessionAgentLine({ session, onBind, saving }: SessionAgentLineProps) {
  const [open, setOpen] = useState(false);
  const resolved = useSessionAgent(session.agentId);
  const bindability = sessionBindability(session);

  if (session.agentId === null && !bindability.bindable) return null;

  return (
    /*
     * The dialog is a **sibling** of the line, not a child of it.
     *
     * It used to be nested inside this `<p>`, which is invalid HTML — a `<p>` may hold phrasing
     * content only, and the dialog contains `<h2>`, `<div>`, `<p>`, `<details>` and `<ul>`. The
     * browser silently auto-closed the paragraph and reparented the dialog, so it *looked* right
     * while React logged six "cannot be a descendant" errors per open. Found by opening the screen
     * rather than by any suite, which is the usual way this class of defect is found.
     */
    <>
      <p
        data-testid="session-agent-line"
        className="mt-1 flex flex-wrap items-center gap-2 text-2xs"
      >
        <span className="text-text-muted">Agent</span>

        {session.agentId === null ? (
          <span className="text-text-secondary">none — no persona, no tool restrictions</span>
        ) : (
          <>
            <SessionAgentTag
              agentId={session.agentId}
              agent={resolved.agent}
              unreadable={resolved.unavailable || resolved.unreadable}
            />
            <AgentEffect agent={resolved.agent} />
            {resolved.agent?.archivedAt === null || resolved.agent === null ? null : (
              <span className="text-text-muted">
                archived since — the binding stands, because archiving an agent does not rewrite the
                sessions that ran as it
              </span>
            )}
            {resolved.unavailable ? (
              <span style={{ color: 'var(--color-warning)' }}>
                this agent could not be read, so what it removed cannot be shown
              </span>
            ) : null}
          </>
        )}

        {bindability.bindable ? (
          <button
            type="button"
            data-testid="session-agent-bind"
            onClick={() => setOpen(true)}
            className="rounded-xs border border-border-control px-2 text-2xs text-text"
            style={{ minHeight: 24 }}
          >
            {session.agentId === null ? 'Choose an agent' : 'Change'}
          </button>
        ) : (
          <span className="text-text-muted">· fixed at launch</span>
        )}
      </p>

      {open ? (
        <BindAgentModal
          session={session}
          saving={saving}
          onClose={() => setOpen(false)}
          onBind={(next) => {
            onBind(next);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/** One clause: what this agent takes away. The whole reason the line is not just a name. */
function AgentEffect({ agent }: { agent: AgentView | null }) {
  if (agent === null) return null;
  const consequence = bindingConsequence(agent);

  if (consequence.kind === 'not_stated') {
    return (
      <span className="text-text-muted" title="The Agent resource carried no disallowedTools.">
        · tools removed: not stated by this Backend
      </span>
    );
  }
  if (consequence.kind === 'removes_nothing') {
    return <span className="text-text-muted">· removes no tools</span>;
  }
  /*
   * The count leads and the enumeration is capped at three.
   *
   * A read-only agent removes ten tools, and spelling all ten out here pushed the header's
   * identity block onto two lines and buried the state badge under a comma list — observed in the
   * browser on 2026-08-14. The *number* is the fact that matters at a glance ("this session was
   * restricted, by this much"); the names are what the `title` and the agent's own page are for,
   * and neither is a click away from being wrong.
   */
  const shown = consequence.tools.slice(0, 3);
  const rest = consequence.tools.length - shown.length;

  return (
    <span
      className="text-text-muted"
      title={`Removed from this session's runtime: ${consequence.tools.join(', ')}`}
    >
      · removes {consequence.tools.length} {consequence.tools.length === 1 ? 'tool' : 'tools'} (
      {shown.join(', ')}
      {rest > 0 ? `, +${rest} more` : ''})
    </span>
  );
}

/**
 * Bind or unbind, for a Session that is still in `created`.
 *
 * The offer set is the Backend's, read from `GET /projects/{id}/available-agents` for this
 * Session's Project — the same document and the same rule the Launch dialog uses, because a
 * second answer to "may this agent be bound" is the defect this whole change removes.
 *
 * **One thing that read cannot tell this screen**, and it is stated rather than guessed. The
 * Backend evaluates availability with `sessionId: null` — the create-time question — so a
 * *session-scoped* agent (PRD §5.2) always comes back refused as `session_not_yet`, even the one
 * that names this very Session. This surface used to offer it, from a client-side rule; it no
 * longer decides, so it says instead that this Backend was not asked about this Session. Closing
 * that needs a `sessionId` on the availability read, not a rule here.
 */
function BindAgentModal({
  session,
  saving,
  onClose,
  onBind,
}: {
  session: Session;
  saving: boolean;
  onClose: () => void;
  onBind: (agentId: string | null) => void;
}) {
  const [agentId, setAgentId] = useState(session.agentId ?? '');
  const agents = useAgentAvailability(session.projectId, true);

  // A refetch that lands while the dialog is open must not leave a selection the API would refuse
  // — but only once the read has actually answered, or an in-flight request would silently clear
  // a choice nobody rejected.
  useEffect(() => {
    if (agentId === '') return;
    if (agents.status !== 'ready') return;
    if (!agents.offered.some((option) => option.agent.id === agentId)) setAgentId('');
  }, [agentId, agents.status, agents.offered]);

  const unchanged = (session.agentId ?? '') === agentId;

  return (
    <Modal
      open
      onClose={onClose}
      title="Agent for this session"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || unchanged}
            onClick={() => onBind(agentId === '' ? null : agentId)}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-2xs text-text-muted leading-150">
        <span aria-hidden="true">ⓘ</span> An agent can be bound while a session is{' '}
        <code className="font-mono">created</code> and not afterwards: its instructions become the
        runtime’s system prompt at spawn, and the runtime cannot be handed another mid-conversation.
      </p>
      <AgentField
        read={agents}
        value={agentId}
        onChange={setAgentId}
        withdrawn={null}
        disabledReason={null}
        sessionExists
      />
    </Modal>
  );
}
