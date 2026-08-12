import { NavLink, useParams } from 'react-router';
import {
  isSettingsCategory,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_PHASE,
  settingsCategoryLabel,
} from '../app/shell/navigation.js';
import { PagePlaceholder } from '../components/PagePlaceholder.js';
import { PhaseBadge, PhasePlaceholder } from '../components/PhasePlaceholder.js';

/**
 * `/settings/:category` (TDS 05 §7, TDS 06 §5.7).
 *
 * The category rail is real — it is navigation, and navigation belongs to the shell task.
 * The panels themselves (schema-driven forms, `SecretField`, Test Connection, Services
 * health) are the Settings task. `memory` and `agents` are phase-gated categories: reachable,
 * badged, and never `disabled`.
 */
export function Component() {
  const { category = 'general' } = useParams();
  const known = isSettingsCategory(category);
  const phase = known ? SETTINGS_CATEGORY_PHASE[category] : undefined;

  return (
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

      <div className="min-w-0 flex-1">
        {!known ? (
          <PagePlaceholder
            title="Unknown settings category"
            summary={`There is no settings category named "${category}".`}
            owner="TDS 05 §7.1"
          />
        ) : phase !== undefined ? (
          <PhasePlaceholder
            phase={phase}
            title={settingsCategoryLabel(category)}
            description={`${settingsCategoryLabel(category)} settings arrive with their phase. The category exists today so the rail is complete and the route is linkable.`}
          />
        ) : (
          <PagePlaceholder
            title={settingsCategoryLabel(category)}
            summary="Schema-driven forms (React Hook Form + Zod), write-only SecretFields with Replace/Clear, per-integration Test Connection, and the read-only Services health panel."
            owner="TDS 05 §7 and TDS 06 §5.7"
          />
        )}
      </div>
    </div>
  );
}
