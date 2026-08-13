import { useEffect, useRef, useState } from 'react';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Modal } from '../../components/Modal.js';
import type { Project } from '../../lib/api/index.js';
import { useCreateProject } from './mutations.js';
import { useGlobalWorkflowMode } from './queries.js';
import { WorkflowModeRadios } from './WorkflowModeControl.js';

/**
 * `+ Add Project` (TDS 06 §5.3.1).
 *
 * Three fields, and the third is the interesting one: **workflow mode defaults to "follow the
 * global default"**, which is the `null` the API stores (§4). A create form that pre-selected
 * `manual` would silently opt every new Project out of a global setting the operator may not
 * have configured yet — the override has to be a deliberate act, not a side effect of using the
 * dialog.
 */
export interface CreateProjectModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (project: Project) => void;
}

export function CreateProjectModal({ open, onClose, onCreated }: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workflowMode, setWorkflowMode] = useState<'manual' | 'assisted' | null>(null);

  const create = useCreateProject();
  const globalMode = useGlobalWorkflowMode();

  // The reset function is held in a ref because the mutation *result* object is a new identity
  // on every render — depending on it directly would re-run this effect continuously while a
  // mutation is pending, wiping the form the operator is looking at.
  const resetMutation = useRef(create.reset);
  resetMutation.current = create.reset;

  useEffect(() => {
    if (open) return;
    setName('');
    setDescription('');
    setWorkflowMode(null);
    resetMutation.current();
  }, [open]);

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !create.isPending;

  const submit = (): void => {
    if (!canCreate) return;
    create.mutate(
      {
        name: trimmed,
        description: description.trim() === '' ? null : description.trim(),
        workflowMode,
      },
      { onSuccess: onCreated },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Project"
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
            onClick={submit}
            disabled={!canCreate}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="new-project-name" className="mb-1 block text-text-secondary text-xs">
            Name
          </label>
          <input
            id="new-project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="mission-control"
            className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
            style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
          />
        </div>

        <div>
          <label
            htmlFor="new-project-description"
            className="mb-1 block text-text-secondary text-xs"
          >
            Description
          </label>
          <textarea
            id="new-project-description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional — what this project is for."
            className="w-full resize-y rounded-sm border bg-transparent p-2 text-sm text-text"
            style={{ borderColor: 'var(--color-border-control)' }}
          />
        </div>

        <div>
          <p className="mb-1 text-text-secondary text-xs">Workflow mode</p>
          <WorkflowModeRadios
            name="new-project-workflow-mode"
            value={workflowMode}
            globalMode={globalMode}
            onChange={setWorkflowMode}
          />
        </div>

        {create.isError ? (
          <ErrorPanel error={create.error} title="Could not create the project" />
        ) : null}
      </div>
    </Modal>
  );
}
