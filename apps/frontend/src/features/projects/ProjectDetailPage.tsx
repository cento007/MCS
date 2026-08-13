import { type ReactNode, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { PhaseBadge } from '../../components/PhasePlaceholder.js';
import { Skeleton } from '../../components/Skeleton.js';
import { ProjectHeader } from './ProjectHeader.js';
import {
  useGlobalWorkflowMode,
  useProject,
  useProjectRepositories,
  useProjectSessionCounts,
} from './queries.js';
import { RepositoriesTab } from './RepositoriesTab.js';

/**
 * `/projects/:projectId` — the Project detail view (PRD §8.2, TDS 06 §5.3.2, TDS 05 §2.2).
 *
 * Four tabs, mirroring the PRD's display list: Repositories and Sessions (Phase 1), Agents
 * (Phase 4) and Memory (Phase 3).
 *
 * **Phase gating follows the single canonical treatment (TDS 06 §2.5, UX register WC9):
 * full-contrast label plus a muted `P3`/`P4` badge, normal focus and hover, and never
 * `disabled` or `aria-disabled`.** The reason is not cosmetic: these tabs *do* something — they
 * select a panel that explains what is coming — so marking them disabled would be a false
 * statement to both pointer and screen-reader users, and `--color-text-disabled` is deliberately
 * exempt from the AA contrast floor, which would make the label genuinely hard to read as well.
 * The badge carries "later phase"; the contrast never does.
 */

export const PROJECT_TABS = ['repositories', 'sessions', 'agents', 'memory'] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

const TAB_META: Readonly<
  Record<ProjectTab, { readonly label: string; readonly phase: 3 | 4 | null }>
> = {
  repositories: { label: 'Repositories', phase: null },
  sessions: { label: 'Sessions', phase: null },
  agents: { label: 'Agents', phase: 4 },
  memory: { label: 'Memory', phase: 3 },
};

function asTab(value: string | null): ProjectTab {
  return (PROJECT_TABS as readonly string[]).includes(value ?? '')
    ? (value as ProjectTab)
    : 'repositories';
}

export interface ProjectDetailPageProps {
  readonly projectId: string;
  /**
   * The Sessions tab body, injected by the route.
   *
   * The Project's Sessions tab is "the identical table to §5.4 pre-filtered to the Project
   * (shared component)" — which is a *Sessions* view, owned by the Sessions slice. TDS 05 §2.1
   * forbids one feature importing another, so the composition happens one level up in
   * `routes/project-detail.tsx`, where importing both slices is exactly the job. The slot also
   * makes this page testable without dragging the whole Sessions data layer into its suite.
   */
  readonly sessionsTab: ReactNode;
}

export function ProjectDetailPage({ projectId, sessionsTab }: ProjectDetailPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = asTab(searchParams.get('tab'));

  const setTab = (next: ProjectTab): void => {
    setSearchParams(
      (params) => {
        if (next === 'repositories') params.delete('tab');
        else params.set('tab', next);
        return params;
      },
      { replace: true },
    );
  };

  const project = useProject(projectId);
  const repositories = useProjectRepositories(projectId);
  const sessionCounts = useProjectSessionCounts();
  const globalMode = useGlobalWorkflowMode();

  const counts = useMemo(
    () => sessionCounts.byProject.get(projectId) ?? null,
    [sessionCounts.byProject, projectId],
  );

  if (project.isPending) {
    return (
      <div className="px-4 py-4 md:px-6" role="status" aria-busy="true">
        <span className="sr-only">Loading project</span>
        <Skeleton width={240} height={22} />
        <div className="mt-6 space-y-3">
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      </div>
    );
  }

  if (project.isError || project.data === undefined) {
    return (
      <div className="px-4 py-4 md:px-6">
        <ErrorPanel
          error={project.error}
          title="This project could not be loaded"
          onRetry={() => void project.refetch()}
        />
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col">
      <ProjectHeader
        project={project.data}
        repositoryCount={repositories.isError ? null : (repositories.data ?? []).length}
        sessionCounts={counts}
        sessionCountsUnavailable={sessionCounts.isError}
        globalMode={globalMode}
      />

      <div className="px-4 pt-3 md:px-6">
        <div role="tablist" aria-label="Project sections" className="flex flex-wrap gap-1">
          {PROJECT_TABS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`project-tab-${candidate}`}
              aria-selected={tab === candidate}
              aria-controls={`project-panel-${candidate}`}
              // Roving tabindex: the tablist is one tab stop and arrows move within it. Every
              // tab is focusable — including the phase-gated ones, which is the whole point of
              // WC9's treatment.
              tabIndex={tab === candidate ? 0 : -1}
              onClick={() => setTab(candidate)}
              onKeyDown={(event) => {
                const index = PROJECT_TABS.indexOf(candidate);
                const next =
                  event.key === 'ArrowRight'
                    ? PROJECT_TABS[(index + 1) % PROJECT_TABS.length]
                    : event.key === 'ArrowLeft'
                      ? PROJECT_TABS[(index - 1 + PROJECT_TABS.length) % PROJECT_TABS.length]
                      : event.key === 'Home'
                        ? PROJECT_TABS[0]
                        : event.key === 'End'
                          ? PROJECT_TABS[PROJECT_TABS.length - 1]
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                setTab(next);
                // Roving tabindex means **moving focus**, not only moving the selection. Without
                // this the arrow key changes the panel while focus stays on the tab the operator
                // started from, so a second press walks from the wrong origin and the tablist is
                // unusable from the keyboard — which is exactly how a phase-gated tab ends up
                // unreachable without ever being marked `disabled`.
                document.getElementById(`project-tab-${next}`)?.focus();
              }}
              className="flex items-center gap-2 rounded-xs px-3 text-sm"
              style={{
                minHeight: 28,
                backgroundColor: tab === candidate ? 'var(--color-selected)' : 'transparent',
                // Full contrast on every tab, phase-gated or not.
                color: tab === candidate ? 'var(--color-accent)' : 'var(--color-text)',
              }}
            >
              {TAB_META[candidate].label}
              {TAB_META[candidate].phase === null ? null : (
                <PhaseBadge phase={TAB_META[candidate].phase as 3 | 4} />
              )}
            </button>
          ))}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`project-panel-${tab}`}
        aria-labelledby={`project-tab-${tab}`}
        className="min-h-0 flex-1 px-4 py-4 md:px-6"
      >
        {tab === 'repositories' ? (
          <RepositoriesTab
            projectId={projectId}
            projectName={project.data.name}
            active={tab === 'repositories'}
          />
        ) : tab === 'sessions' ? (
          sessionsTab
        ) : tab === 'agents' ? (
          <TabPlaceholder
            phase={4}
            title="Agents"
            description="Project-scoped agents — personas running on runtimes — are configured here, alongside the global agents and teams on the Agents screen."
          />
        ) : (
          <TabPlaceholder
            phase={3}
            title="Memory"
            description="Project-tier memory: what this project has learned, searchable semantically alongside the session, agent and global tiers."
          />
        )}
      </div>
    </section>
  );
}

/**
 * The in-panel phase placeholder. Same content shape as the routed `PhasePlaceholder` (TDS 05
 * §10) but without its page chrome — the heading here is an `h2` inside the Project's `h1`, not
 * a second page title.
 */
function TabPlaceholder({
  phase,
  title,
  description,
}: {
  phase: 3 | 4;
  title: string;
  description: string;
}) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3">
        <h2 className="font-medium text-md text-text">{title}</h2>
        <PhaseBadge phase={phase} />
      </div>
      <p className="mt-2 text-sm text-text-secondary leading-150">{description}</p>
      <p className="mt-3 text-text-muted text-xs">
        This tab ships in Phase {phase}. The tab, its panel and the reserved query-key namespace are
        the only commitments made today — nothing here is disabled, and nothing here is a dead end.
      </p>
    </div>
  );
}
