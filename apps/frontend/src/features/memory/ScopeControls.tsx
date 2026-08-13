import { MEMORY_SOURCE_TYPES, PRODUCIBLE_MEMORY_TIERS } from '@mc/shared/types';
import type { Project, Session } from '../../lib/api/index.js';
import { sessionLabel } from '../../lib/format/index.js';
import { sourceTypeLabel } from './links.js';
import { describeScope, type MemoryScope, toggleSourceType, toggleTier } from './scope.js';

/**
 * The scope controls — tier, source type, project, session, floor.
 *
 * They cover exactly what `POST /memory-items/search` accepts and nothing else. A control the API
 * cannot honour would be a filter that silently does nothing, which is the same defect as an
 * unknown field being dropped — and the Backend closed that door on this route deliberately
 * (`additionalProperties: false`, so an unknown field is a `400` rather than a no-op).
 *
 * The scope **sentence** below the chips is the load-bearing part. Chips show what is pressed;
 * the sentence says what that means, including the two behaviours the operator cannot infer from
 * the chips: a project scope also returns global memory, and a session scope overrides the tier
 * filter entirely.
 */

export interface ScopeControlsProps {
  readonly scope: MemoryScope;
  readonly onChange: (next: MemoryScope) => void;
  readonly projects: readonly Project[];
  readonly projectsUnavailable: boolean;
  /** The Session behind a `?session=` scope, when it could be read. */
  readonly session: Session | undefined;
}

export function ScopeControls({
  scope,
  onChange,
  projects,
  projectsUnavailable,
  session,
}: ScopeControlsProps) {
  const projectName =
    scope.projectId === null
      ? null
      : (projects.find((project) => project.id === scope.projectId)?.name ?? null);

  const sessionName = session === undefined ? null : sessionLabel(session);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="flex flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">Filter by memory tier</legend>
          <span className="mr-1 text-2xs text-text-muted">Tier</span>
          {PRODUCIBLE_MEMORY_TIERS.map((tier) => (
            <FilterChip
              key={tier}
              label={tier}
              pressed={scope.tiers.includes(tier)}
              // A session scope pins the tier to `session` server-side, so the chips would be
              // decorative. Disabled with a stated reason beats a control that lies.
              disabled={scope.sessionId !== null}
              title={
                scope.sessionId === null
                  ? undefined
                  : 'A session scope searches session-tier chunks only.'
              }
              onClick={() => onChange(toggleTier(scope, tier))}
            />
          ))}
        </fieldset>

        <fieldset className="flex flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">Filter by source type</legend>
          <span className="mr-1 text-2xs text-text-muted">Source</span>
          {MEMORY_SOURCE_TYPES.map((sourceType) => (
            <FilterChip
              key={sourceType}
              label={sourceTypeLabel(sourceType)}
              pressed={scope.sourceTypes.includes(sourceType)}
              onClick={() => onChange(toggleSourceType(scope, sourceType))}
            />
          ))}
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-2xs text-text-muted">
          Project
          <select
            value={scope.projectId ?? ''}
            disabled={scope.sessionId !== null}
            onChange={(event) =>
              onChange({
                ...scope,
                projectId: event.target.value.length === 0 ? null : event.target.value,
              })
            }
            className="rounded-sm border bg-transparent px-2 text-2xs text-text disabled:opacity-50"
            style={{ height: 'var(--mc-control-sm)', borderColor: 'var(--color-border-control)' }}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        {projectsUnavailable ? (
          <span className="text-2xs text-text-muted">
            The project list could not be read, so only an already-scoped project can be kept.
          </span>
        ) : null}

        {scope.sessionId === null ? null : (
          <RemovableChip
            label={`session ${sessionName ?? scope.sessionId}`}
            onRemove={() => onChange({ ...scope, sessionId: null })}
          />
        )}

        {scope.minScore === null ? null : (
          // The chip says "override" rather than quoting a default alongside it: a response
          // produced under an override echoes the override as `minScore`, so a "(default …)"
          // read off the response would print the override twice under two names. The sentence
          // below names the real default.
          <RemovableChip
            label={`floor ${scope.minScore.toFixed(2)} override`}
            onRemove={() => onChange({ ...scope, minScore: null })}
          />
        )}
      </div>

      <p className="text-2xs text-text-secondary leading-150">
        {describeScope(scope, { project: projectName, session: sessionName })}
      </p>
    </div>
  );
}

function FilterChip({
  label,
  pressed,
  onClick,
  disabled = false,
  title,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      {...(title === undefined ? {} : { title })}
      className="rounded-xs border px-2 text-2xs disabled:opacity-50"
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

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-xs border px-2 text-2xs"
      style={{
        minHeight: 24,
        borderColor: 'var(--color-accent)',
        color: 'var(--color-accent)',
        backgroundColor: 'var(--color-selected)',
      }}
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove scope: ${label}`}
        className="rounded-xs"
        style={{ minWidth: 24, minHeight: 24 }}
      >
        ✕
      </button>
    </span>
  );
}
