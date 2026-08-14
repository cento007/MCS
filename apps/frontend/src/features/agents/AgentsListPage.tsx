import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import { endpoints } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format/index.js';
import { formatRelativePast } from '../../lib/format/relative.js';
import { useLiveClock } from '../../lib/liveness.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../lib/media.js';
import { useChannel } from '../../lib/ws/context.js';
import { AgentsTabs } from './AgentsTabs.js';
import { type PermissionSummary, summarisePermissions } from './permissions.js';
import { projectName, useAgentProjects, useAgentsList } from './queries.js';
import type { AgentView } from './shape.js';
import { agentRuntimeLabel, agentScopeLabel } from './types.js';

/**
 * `/agents` — the Agents screen (PRD §8.5, TDS 06 §6.2).
 *
 * §8.5 is one line — *"Manage: global agents, project agents, teams, permissions"* — and all four
 * are now reachable: global and project agents are this list (they are one collection with a
 * column, so they are filter chips rather than tabs), permissions are the Builder's fifth section,
 * and **Teams** are the second tab, added in slice 2 against TDS 04 §13.2's reserved
 * `/agent-teams` routes.
 *
 * **Workflows (PRD §5.6) are still not here, and there is no tab for them.** A chain
 * `Developer → QA → Security → Architect` needs an execution primitive, and
 * `POST /agents/{id}/executions` is unbuilt with its three `agent.execution_*` events reserved and
 * unproduced. A builder for a sequence nothing can run is the most elaborate inert control this
 * codebase could ship, and the whole Permissions section is an argument against shipping one.
 *
 * The rest of the screen is mostly about being honest when there is nothing to show, because on
 * a fresh install that is every install:
 *
 *  - **no route** — this Backend has no `/agents`. Not the same as no agents, and it sends the
 *    reader somewhere completely different.
 *  - **no agents** — the route works and the instance has none. The first thing anybody sees.
 *  - **no matches** — a scope filter emptied a non-empty list.
 *  - **unreadable rows** — the route answered with rows this build could not project. Counted
 *    out loud rather than silently dropped, because a list that is quietly short is
 *    indistinguishable from one that is genuinely short.
 */
export function AgentsListPage() {
  const navigate = useNavigate();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);
  const clock = useLiveClock();

  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get('scope') ?? 'all';
  const includeArchived = searchParams.get('archived') === '1';

  // `agent.created` / `agent.updated` land here (TDS 04 §14.3). The subscription is this page's:
  // nothing outside the Agents screens reads an agent document.
  useChannel('agents');

  const query = useAgentsList(includeArchived);
  const projects = useAgentProjects();

  const { agents, unreadable } = query.read;

  /**
   * Scopes offered as filters: the wireframe's two, plus any this instance actually holds.
   *
   * The `session` chip appears only when a session-scoped agent exists — the Builder does not
   * create them (PRD §5.2 makes them temporary), so on most instances the chip would filter to
   * a permanently empty list.
   */
  const scopes = useMemo(() => {
    const present = new Set(agents.map((agent) => agent.scope).filter((s) => s.length > 0));
    const ordered = ['global', 'project'];
    for (const value of present) if (!ordered.includes(value)) ordered.push(value);
    return ordered;
  }, [agents]);

  const rows = useMemo(
    () => (scope === 'all' ? agents : agents.filter((agent) => agent.scope === scope)),
    [agents, scope],
  );

  const setParam = (key: string, next: string | null): void => {
    setSearchParams(
      (params) => {
        if (next === null) params.delete(key);
        else params.set(key, next);
        return params;
      },
      { replace: true },
    );
  };

  const setScope = (next: string): void => setParam('scope', next === 'all' ? null : next);

  return (
    <section className="px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-medium text-text text-xl">Agents</h1>
        <Link
          to="/agents/new"
          className="ml-auto flex items-center rounded-sm px-3 font-medium text-sm"
          style={{
            height: 'var(--mc-control-md)',
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          + New agent
        </Link>
      </div>

      <AgentsTabs active="agents" />

      <p className="mt-3 max-w-3xl text-sm text-text-secondary leading-150">
        Agents are specialised personas operating through runtimes, not models (PRD §5.1). A global
        agent is offered to every project; a project agent to exactly one. An agent is bound to a
        session when the session is created, and its permissions{' '}
        <strong>remove tools from that session</strong> — the Launch dialog names which.
      </p>

      {query.unavailable ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <fieldset className="flex flex-wrap gap-1 border-0 p-0">
            <legend className="sr-only">Filter by scope</legend>
            <FilterChip label="All" pressed={scope === 'all'} onClick={() => setScope('all')} />
            {scopes.map((entry) => (
              <FilterChip
                key={entry}
                label={agentScopeLabel(entry)}
                pressed={scope === entry}
                onClick={() => setScope(entry)}
              />
            ))}
          </fieldset>

          {/*
           * Archived agents are excluded by the Backend, not by this list, so this chip changes
           * the request rather than the filter. It exists because archival is the *only*
           * retirement there is — `apps/backend/src/agents/routes.ts` has no DELETE — and an
           * archived agent with no way back on screen is an agent nobody can un-retire.
           */}
          <FilterChip
            label="Show archived"
            pressed={includeArchived}
            onClick={() => setParam('archived', includeArchived ? null : '1')}
          />
        </div>
      )}

      <div className="mt-4">
        {query.unavailable ? (
          <RouteMissing />
        ) : query.isPending ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <span className="sr-only">Loading agents</span>
            <Skeleton height={36} />
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : query.isError ? (
          <ErrorPanel
            error={query.error}
            title="The agents list could not be read"
            onRetry={query.refetch}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={scope === 'all' ? 'No agents yet.' : `No ${agentScopeLabel(scope)} agents.`}
            hint={
              scope === 'all'
                ? 'An agent is a name, a prompt and a set of permissions on top of a runtime. Create one and it becomes available to sessions in its scope.'
                : 'Other scopes may still hold agents — clear the filter to see them.'
            }
            action={
              scope === 'all' ? (
                <Link
                  to="/agents/new"
                  className="flex items-center rounded-sm border border-border-control px-3 text-sm text-text"
                  style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                >
                  New agent
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className="rounded-sm border border-border-control px-3 text-sm text-text"
                  style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                >
                  Clear filter
                </button>
              )
            }
          />
        ) : mobile ? (
          <ul className="flex flex-col gap-2">
            {rows.map((agent) => (
              <li key={agent.id}>
                <MobileCard
                  agent={agent}
                  project={projectName(projects.data ?? [], agent.projectId)}
                  onOpen={() => void navigate(`/agents/${agent.id}`)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-2xs text-text-secondary uppercase">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Scope
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Runtime
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Permissions
                </th>
                <th scope="col" className="py-2 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((agent) => (
                <tr
                  key={agent.id}
                  className="border-border border-t align-top"
                  style={{ height: 'var(--mc-row-dense)' }}
                >
                  <td className="py-2 pr-3">
                    <Link to={`/agents/${agent.id}`} className="block" style={{ minHeight: 24 }}>
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm text-text">{agent.name}</span>
                        {agent.archivedAt === null ? null : <ArchivedChip />}
                      </span>
                      {agent.description.length === 0 ? null : (
                        <span className="block max-w-md truncate text-2xs text-text-muted">
                          {agent.description}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    <ScopeCell
                      agent={agent}
                      project={projectName(projects.data ?? [], agent.projectId)}
                    />
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    {agent.runtime.length === 0 ? (
                      <span className="text-text-muted" title="This Backend served no runtime.">
                        —
                      </span>
                    ) : (
                      agentRuntimeLabel(agent.runtime)
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <PermissionsCell summary={summarisePermissions(agent.permissions)} />
                  </td>
                  <td
                    className="py-2 text-text-secondary text-xs"
                    title={agent.updatedAt === null ? undefined : formatDateTime(agent.updatedAt)}
                  >
                    {agent.updatedAt === null
                      ? '—'
                      : formatRelativePast(agent.updatedAt, clock.now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unreadable > 0 ? (
          <p
            role="note"
            data-testid="agents-unreadable"
            className="mt-3 text-2xs text-text-muted leading-150"
          >
            <span aria-hidden="true">▲</span> {unreadable}{' '}
            {unreadable === 1 ? 'row was' : 'rows were'} served without an id or a name and{' '}
            {unreadable === 1 ? 'is' : 'are'} not shown. The count is here rather than nowhere: a
            list that is quietly short looks exactly like one that is genuinely short.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The Backend does not serve `/agents`.
 *
 * Deliberately not the empty state. "No agents yet" invites the operator to create one, which
 * would fail; this names the missing route, because the person reading it and the person who has
 * to add it are frequently the same person on a self-hosted install.
 */
function RouteMissing() {
  return (
    <div
      role="note"
      data-testid="agents-route-missing"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> This Backend does not serve{' '}
        <code className="font-mono text-xs">/api/v1{endpoints.agents.list}</code> yet.
      </p>
      <p className="mt-1 max-w-3xl text-2xs text-text-muted leading-150">
        The screen is built to TDS 04 §13.2 and stays out of the way until the route exists. It is
        not showing you an empty list, because “no agents” and “no agents API” are different facts
        with different fixes, and only one of them is solved by pressing New agent.
      </p>
    </div>
  );
}

function ScopeCell({ agent, project }: { agent: AgentView; project: string | null }) {
  if (agent.scope.length === 0) {
    return (
      <span className="text-text-muted" title="This Backend served no scope for this agent.">
        not stated
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span>{agentScopeLabel(agent.scope)}</span>
      {project === null ? null : (
        <span className="truncate text-2xs text-text-muted">{project}</span>
      )}
    </span>
  );
}

/**
 * `4 of 12 · 3 unenforced`.
 *
 * The second number is the column's reason for existing. "4 granted" reads as *this agent may do
 * four things*; adding what the Backend does not gate turns it into what it is — some number of
 * restrictions that hold, and some that are bookkeeping.
 */
export function PermissionsCell({ summary }: { summary: PermissionSummary }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-text-secondary text-xs">
      {/* Never "full access": PRD §5.5's other nine permissions are not modelled, so a word
          claiming completeness would claim more than the model has. */}
      <span title="Repository capabilities granted, of the three the Backend models.">
        {summary.granted} of {summary.total} · {summary.caption}
      </span>
      {summary.enforcementUnknown ? (
        <span
          className="rounded-xs border px-2 text-2xs"
          style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
          title="This Backend served no disallowedTools, so there is no evidence these gate anything."
        >
          enforcement not stated
        </span>
      ) : null}
    </span>
  );
}

function ArchivedChip() {
  return (
    <span
      className="rounded-xs border border-border px-2 text-2xs text-text-muted"
      title="Retired. It cannot be bound to a new session; PATCH { archived: false } brings it back."
    >
      archived
    </span>
  );
}

function FilterChip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="rounded-xs border px-2 text-2xs"
      style={{
        minHeight: 24,
        borderColor: pressed ? 'var(--color-accent)' : 'var(--color-border)',
        color: pressed ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        backgroundColor: pressed ? 'var(--color-selected)' : 'transparent',
      }}
    >
      {label}
    </button>
  );
}

function MobileCard({
  agent,
  project,
  onOpen,
}: {
  agent: AgentView;
  project: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-border p-3 text-left"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span className="flex items-center gap-2">
        <span className="truncate text-sm text-text">{agent.name}</span>
        {agent.archivedAt === null ? null : <ArchivedChip />}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <span>{agent.scope.length === 0 ? 'scope not stated' : agentScopeLabel(agent.scope)}</span>
        {project === null ? null : <span>{project}</span>}
        {agent.runtime.length === 0 ? null : <span>{agentRuntimeLabel(agent.runtime)}</span>}
      </span>
      <span className="mt-1 block">
        <PermissionsCell summary={summarisePermissions(agent.permissions)} />
      </span>
    </button>
  );
}
