import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '../../components/Modal.js';
import type { Project } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format/index.js';
import { toast } from '../../stores/toast-store.js';
import { useUpdateProject } from './mutations.js';
import { SessionCountsCell } from './ProjectsListPage.js';
import type { GlobalWorkflowModeRead, ProjectSessionState } from './queries.js';
import {
  effectiveModeSentence,
  WorkflowModeRadios,
  type WorkflowModeValue,
} from './WorkflowModeControl.js';

/**
 * The Project detail header (TDS 06 §5.3.2).
 *
 * Identity is the **name**, never an id — the same rule the Sessions surfaces follow (§9.3).
 * A Project's id is a UUIDv7 whose leading characters encode the millisecond it was created, so
 * it discriminates nothing an operator can read; unlike a Session, a Project always has a name,
 * so there is no fallback to write and no id column to demote. The id is not rendered at all.
 */

export interface ProjectHeaderProps {
  readonly project: Project;
  readonly repositoryCount: number | null;
  readonly sessionCounts: ReadonlyMap<ProjectSessionState, number> | null;
  readonly sessionCountsUnavailable: boolean;
  readonly globalMode: GlobalWorkflowModeRead;
}

export function ProjectHeader({
  project,
  repositoryCount,
  sessionCounts,
  sessionCountsUnavailable,
  globalMode,
}: ProjectHeaderProps) {
  const update = useUpdateProject(project.id);
  const [confirming, setConfirming] = useState<'archive' | 'restore' | null>(null);

  const archived = project.archivedAt !== null;

  const applyWorkflowMode = (next: WorkflowModeValue): void => {
    if (next === project.workflowMode) return;
    update.mutate(
      { workflowMode: next },
      {
        onSuccess: () =>
          toast({
            kind: 'success',
            message:
              next === null
                ? 'Workflow mode now follows the global default'
                : `Workflow mode set to ${next}`,
          }),
      },
    );
  };

  return (
    <header className="border-border border-b px-4 py-3 md:px-6">
      <p className="text-2xs text-text-muted">
        <Link to="/projects" className="underline decoration-dotted underline-offset-2">
          Projects
        </Link>{' '}
        / {project.name}
      </p>

      <div className="mt-1 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <InlineText
            value={project.name}
            label="Project name"
            editLabel="Rename project"
            multiline={false}
            pending={update.isPending}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (trimmed.length === 0 || trimmed === project.name) return;
              update.mutate({ name: trimmed });
            }}
            render={(value) => <h1 className="font-medium text-text text-xl">{value}</h1>}
          />

          <InlineText
            value={project.description ?? ''}
            label="Project description"
            editLabel="Edit description"
            multiline
            pending={update.isPending}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (trimmed === (project.description ?? '')) return;
              update.mutate({ description: trimmed === '' ? null : trimmed });
            }}
            render={(value) => (
              <p className="text-sm text-text-secondary leading-150">
                {value.length === 0 ? (
                  <span className="text-text-muted">No description</span>
                ) : (
                  value
                )}
              </p>
            )}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SessionCountsCell counts={sessionCounts} unavailable={sessionCountsUnavailable} />
          <span className="text-text-secondary text-xs">
            {repositoryCount === null
              ? 'repositories unknown'
              : `${repositoryCount} repositor${repositoryCount === 1 ? 'y' : 'ies'}`}
          </span>
          {archived ? (
            <span
              className="rounded-xs px-2 py-05 text-2xs"
              style={{
                backgroundColor: 'var(--color-state-archived-subtle)',
                color: 'var(--color-state-archived)',
              }}
              title={`Archived ${formatDateTime(project.archivedAt)}`}
            >
              archived
            </span>
          ) : null}

          <button
            type="button"
            onClick={() => setConfirming(archived ? 'restore' : 'archive')}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)' }}
          >
            {archived ? 'Restore' : 'Archive'}
          </button>
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-1 text-text-secondary text-xs">
          Workflow mode
          {update.isPending ? <span className="ml-2 text-text-muted">saving…</span> : null}
        </p>
        <WorkflowModeRadios
          name={`project-workflow-mode-${project.id}`}
          value={project.workflowMode}
          globalMode={globalMode}
          disabled={update.isPending}
          onChange={applyWorkflowMode}
        />
        <p className="mt-2 max-w-2xl text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span>{' '}
          {effectiveModeSentence(project.workflowMode, globalMode)} Manual records git activity but
          never proposes actions; Assisted lets Mission Control propose commit messages, branch
          names and PR descriptions for your approval. The setting is stored today; assisted actions
          arrive in Phase 2.
        </p>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === 'restore' ? 'Restore this project?' : 'Archive this project?'}
        body={
          confirming === 'restore'
            ? 'The project returns to the active list. Nothing else changes.'
            : 'The project leaves the active list. Its sessions, repositories and history are kept, and it can be restored at any time.'
        }
        confirmLabel={confirming === 'restore' ? 'Restore' : 'Archive'}
        pending={update.isPending}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action === null) return;
          // §4 spells archival as `PATCH { archivedAt }` — there is no `/archive` sub-action,
          // and inventing one would be the deviation. The operator stays on the page: the
          // header grows an `archived` chip and the button becomes Restore.
          update.mutate({ archivedAt: action === 'restore' ? null : new Date().toISOString() });
        }}
        onCancel={() => setConfirming(null)}
      />
    </header>
  );
}

/**
 * Click-to-edit text, committed on Enter/blur and abandoned on Escape — the same interaction the
 * Session header's title uses, so renaming works identically wherever an operator meets it.
 *
 * Never optimistic (§11.3): the rendered value is server state, so a rejected rename (a name
 * collision against `ux_projects_workspace_name`, for instance) leaves the old name on screen
 * and the toast explains why, rather than showing a name the database refused.
 */
function InlineText({
  value,
  label,
  editLabel,
  multiline,
  pending,
  onCommit,
  render,
}: {
  value: string;
  label: string;
  editLabel: string;
  multiline: boolean;
  pending: boolean;
  onCommit: (next: string) => void;
  render: (value: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        {render(value)}
        <button
          type="button"
          aria-label={editLabel}
          title={editLabel}
          disabled={pending}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="rounded-xs text-text-muted text-xs disabled:opacity-50"
          style={{ minWidth: 24, minHeight: 24 }}
        >
          ✎
        </button>
      </div>
    );
  }

  const commit = (): void => {
    setEditing(false);
    onCommit(draft);
  };

  const keyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(value);
      setEditing(false);
    }
  };

  return multiline ? (
    <textarea
      ref={inputRef as React.RefObject<HTMLTextAreaElement>}
      rows={2}
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={keyDown}
      className="w-full resize-y rounded-sm border bg-transparent p-2 text-sm text-text"
      style={{ borderColor: 'var(--color-border-control)' }}
    />
  ) : (
    <input
      ref={inputRef as React.RefObject<HTMLInputElement>}
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={keyDown}
      className="w-full rounded-sm border bg-transparent px-2 py-1 font-medium text-text text-xl"
      style={{ borderColor: 'var(--color-border-control)' }}
    />
  );
}
