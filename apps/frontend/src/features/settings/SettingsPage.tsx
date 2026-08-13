import { useEffect, useRef } from 'react';
import { NavLink, useParams } from 'react-router';
import {
  isSettingsCategory,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_PHASE,
  type SettingsCategory,
  settingsCategoryLabel,
} from '../../app/shell/navigation.js';
import { PhaseBadge } from '../../components/PhasePlaceholder.js';
import { DirtyFormProvider, UnsavedChangesGuard } from '../../components/UnsavedChangesGuard.js';
import { AgentsSettingsPanel } from './panels/AgentsSettingsPanel.js';
import { GeneralPanel } from './panels/GeneralPanel.js';
import { IntegrationsPanel } from './panels/IntegrationsPanel.js';
import { MemoryPanel } from './panels/MemoryPanel.js';
import { NotificationsPanel } from './panels/NotificationsPanel.js';
import { SecurityPanel } from './panels/SecurityPanel.js';
import { ServicesSettingsPanel } from './panels/ServicesSettingsPanel.js';

/**
 * `/settings/:category` — the Settings screen (PRD §4.4, TDS 05 §7, TDS 06 §5.7).
 *
 * Two panes: the category rail and the active panel. The seven PRD §4.4 categories in PRD
 * order, with `memory` and `agents` phase-gated.
 *
 * **Phase-gated rail entries are never `disabled`.** TDS 06 §2.5 is explicit and the reasoning
 * is worth keeping next to the code: these targets are focusable and they *do* something (they
 * route), so `disabled`/`aria-disabled` would be a lie to both the pointer user and the
 * screen-reader user, and `--color-text-disabled` is deliberately exempt from the AA contrast
 * floor — using it on a reachable target puts unreadable text in the navigation. The muted
 * `P3`/`P4` badge, not the contrast, communicates "later phase".
 *
 * The rail is plain `NavLink`s with no interception of their own: a category change *is* a
 * route change, so the single `UnsavedChangesGuard` blocker covers the rail, the main nav, the
 * command palette and browser back/forward with one rule. A second, rail-specific guard would
 * be the same rule implemented twice, and the two would drift.
 */
export function SettingsPage() {
  const { category = 'general' } = useParams();
  const known = isSettingsCategory(category);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // TDS 06 §7.2: focus is programmatically managed at route change. Without it a keyboard user
  // switching category lands wherever the removed panel left them.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <DirtyFormProvider>
      <div className="flex min-h-full flex-col md:flex-row">
        <nav
          aria-label="Settings categories"
          className="shrink-0 border-border border-b p-2 md:w-56 md:border-r md:border-b-0"
        >
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {SETTINGS_CATEGORIES.map((entry) => (
              <li key={entry}>
                <NavLink
                  to={`/settings/${entry}`}
                  className="flex items-center gap-2 whitespace-nowrap rounded-xs px-2 py-2 text-sm text-text-secondary"
                  style={({ isActive }) =>
                    isActive
                      ? { backgroundColor: 'var(--color-selected)', color: 'var(--color-text)' }
                      : undefined
                  }
                >
                  <span className="flex-1">{settingsCategoryLabel(entry)}</span>
                  {SETTINGS_CATEGORY_PHASE[entry] === undefined ? null : (
                    <PhaseBadge phase={SETTINGS_CATEGORY_PHASE[entry] as 3 | 4} />
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 px-4 py-4 md:px-6">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mb-4 font-medium text-text text-xl outline-none"
          >
            Settings
          </h1>

          {known ? (
            <CategoryPanel category={category} />
          ) : (
            <section className="rounded-md border border-border p-6">
              <h2 className="font-medium text-md text-text">Unknown settings category</h2>
              <p className="mt-2 text-sm text-text-secondary">
                There is no settings category named “{category}”. Pick one from the list.
              </p>
            </section>
          )}
        </div>
      </div>

      <UnsavedChangesGuard />
    </DirtyFormProvider>
  );
}

export function CategoryPanel({ category }: { category: SettingsCategory }) {
  switch (category) {
    case 'general':
      return <GeneralPanel />;
    case 'integrations':
      return <IntegrationsPanel />;
    case 'notifications':
      return <NotificationsPanel />;
    case 'security':
      return <SecurityPanel />;
    case 'services':
      return <ServicesSettingsPanel />;
    case 'memory':
      // Phase 3, and live: the panel renders whatever `GET /settings/memory` actually serves and
      // says so when that is nothing. The rail keeps its `P3` badge because the badge marks the
      // phase a category belongs to, exactly as the main nav's Memory entry does.
      return <MemoryPanel />;
    case 'agents':
      // Phase 4, and live. The placeholder this replaced promised "default runtime and default
      // permission template"; only the second was ever declared in the key registry, and the first
      // was withdrawn on purpose (one launchable runtime, so a picker chooses nothing). The rail
      // keeps its `P4` badge because the badge marks the phase a category belongs to.
      return <AgentsSettingsPanel />;
    default:
      return null;
  }
}
