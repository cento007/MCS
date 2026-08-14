import { NavLink } from 'react-router';

/**
 * The Agents area's two tabs (PRD §8.5, TDS 06 §6.2).
 *
 * §6.2's wireframe reserves `[ Global ] [ Project ] [ Teams ]`. The first two are **scopes of the
 * same list**, and they are filter chips on the Agents screen rather than tabs — a tab implies a
 * different collection, and `global` and `project` agents are one collection with a column. Teams
 * genuinely are a different collection, with their own route and their own empty state, so they
 * get the tab.
 *
 * **There is no Workflows tab, deliberately.** PRD §5.6 sketches `Developer → QA → Security →
 * Architect`, and nothing in this product can execute such a chain: `POST /agents/{id}/executions`
 * is unbuilt and the three `agent.execution_*` events are reserved and unproduced. A builder for a
 * sequence nothing can run would be the most elaborate inert control in the codebase.
 *
 * Rendered as links rather than as buttons over local state so each tab is a URL an operator can
 * keep, and so the unsaved-changes guard sees a real navigation between them.
 */
export function AgentsTabs({ active }: { active: 'agents' | 'teams' }) {
  return (
    <nav aria-label="Agents sections" className="mt-3 flex gap-1">
      <Tab to="/agents" label="Agents" current={active === 'agents'} />
      <Tab to="/agents/teams" label="Teams" current={active === 'teams'} />
    </nav>
  );
}

function Tab({ to, label, current }: { to: string; label: string; current: boolean }) {
  return (
    <NavLink
      to={to}
      end
      aria-current={current ? 'page' : undefined}
      className="flex items-center rounded-xs px-3 text-sm"
      style={{
        minHeight: 24,
        height: 'var(--mc-control-sm)',
        backgroundColor: current ? 'var(--color-selected)' : 'transparent',
        color: current ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        // The rule under the active tab, per §6.2. A border rather than an underline so it lines
        // up with the panel edge below it on every zoom level.
        borderBottom: `2px solid ${current ? 'var(--color-accent)' : 'transparent'}`,
      }}
    >
      {label}
    </NavLink>
  );
}
