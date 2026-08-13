import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RequestIdLine } from '../../components/ErrorPanel.js';
import { Modal } from '../../components/Modal.js';
import { useRegisterRepository } from './mutations.js';
import { registrationProblem } from './registration.js';

/**
 * Register a repository by local path (`POST /repositories`).
 *
 * The dialog is mostly one field, and almost all of its design is in the failure path. The
 * Backend verifies the path *before* writing a row and distinguishes four things an operator can
 * actually fix — the path does not exist, it is not a directory, it is not a git working tree,
 * git could not be run — plus the duplicate-registration conflict. Rendering all five as
 * "Validation failed" would throw away the entire answer, so each one arrives here as a sentence
 * plus an instruction (`registration.ts`).
 *
 * The path is resolved **on the Mission Control host**, which on a home-server install is very
 * often not the machine the browser is on. The field says so, because "that path exists!" is the
 * first thing an operator thinks when they see `path_missing`.
 */

export interface RegisterRepositoryModalProps {
  readonly open: boolean;
  readonly projectId: string;
  readonly projectName: string;
  readonly onClose: () => void;
}

export function RegisterRepositoryModal({
  open,
  projectId,
  projectName,
  onClose,
}: RegisterRepositoryModalProps) {
  const [localPath, setLocalPath] = useState('');
  const [name, setName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');

  const register = useRegisterRepository();

  const resetMutation = useRef(register.reset);
  resetMutation.current = register.reset;

  useEffect(() => {
    if (open) return;
    setLocalPath('');
    setName('');
    setDefaultBranch('');
    resetMutation.current();
  }, [open]);

  const trimmedPath = localPath.trim();
  const canSubmit = trimmedPath.length > 0 && !register.isPending;

  const submit = (): void => {
    if (!canSubmit) return;
    register.mutate(
      {
        localPath: trimmedPath,
        name: name.trim(),
        defaultBranch: defaultBranch.trim(),
        projectId,
      },
      { onSuccess: onClose },
    );
  };

  const problem = register.isError ? registrationProblem(register.error) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register repository"
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
            disabled={!canSubmit}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {register.isPending ? 'Checking path…' : 'Register'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-2xs text-text-muted leading-150">
          The repository is registered against <span className="text-text">{projectName}</span>.
        </p>

        <div>
          <label htmlFor="register-repo-path" className="mb-1 block text-text-secondary text-xs">
            Local path
          </label>
          <input
            id="register-repo-path"
            value={localPath}
            onChange={(event) => setLocalPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="D:\Repos\MCS"
            aria-describedby="register-repo-path-hint"
            className="w-full rounded-sm border bg-transparent px-2 font-mono text-sm text-text"
            style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
          />
          <p id="register-repo-path-hint" className="mt-1 text-2xs text-text-muted leading-150">
            An absolute path on the machine running Mission Control — not on this computer, if they
            are different. It must already be a git working tree; Mission Control checks before
            saving and creates nothing on disk.
          </p>
        </div>

        <div>
          <label htmlFor="register-repo-name" className="mb-1 block text-text-secondary text-xs">
            Name
          </label>
          <input
            id="register-repo-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Defaults to the directory name"
            className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
            style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
          />
        </div>

        <div>
          <label htmlFor="register-repo-branch" className="mb-1 block text-text-secondary text-xs">
            Default branch
          </label>
          <input
            id="register-repo-branch"
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
            placeholder="main"
            className="w-full rounded-sm border bg-transparent px-2 font-mono text-sm text-text"
            style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
          />
          <p className="mt-1 text-2xs text-text-muted leading-150">
            Phase 1 asks no remote what the default branch is, so this is what Mission Control will
            believe until repository sync exists.
          </p>
        </div>

        {problem === null ? null : (
          <div
            role="alert"
            data-testid="registration-problem"
            className="rounded-md border p-3"
            style={{
              backgroundColor: 'var(--color-danger-subtle)',
              borderColor: 'var(--color-danger)',
            }}
          >
            <p className="font-medium text-sm" style={{ color: 'var(--color-danger)' }}>
              {problem.message}
            </p>
            {problem.hint === null ? null : (
              <p className="mt-1 text-sm text-text leading-150">{problem.hint}</p>
            )}
            {problem.existingRepositoryId === null ? null : (
              <p className="mt-2 text-2xs">
                <Link
                  to="/projects"
                  className="underline decoration-dotted underline-offset-2"
                  onClick={onClose}
                >
                  It is already registered — find it from the Projects list.
                </Link>
              </p>
            )}
            {register.error?.requestId == null ? null : (
              <RequestIdLine requestId={register.error.requestId} />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
