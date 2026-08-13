import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Skeleton } from '../../components/Skeleton.js';
import { errorMessage, queryKeys, type Repository } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format/index.js';
import { formatRelativePast } from '../../lib/format/relative.js';
import { useLiveClock } from '../../lib/liveness.js';
import { toast } from '../../stores/toast-store.js';
import { AttachRepositoryModal } from './AttachRepositoryModal.js';
import { useRemoveRepository, useSyncRepository } from './mutations.js';
import {
  type RepositoryStatusRow,
  useProjectRepositories,
  useRepositoryStatuses,
} from './queries.js';
import { RegisterRepositoryModal } from './RegisterRepositoryModal.js';
import { removalProblem } from './registration.js';
import { describeWorkingTree, workingTreeColorVar } from './working-tree.js';

/**
 * The Repositories tab of the Project detail view (PRD §8.2, TDS 06 §5.3.2).
 *
 * The wireframe's columns are NAME · DEFAULT BRANCH · VISIBILITY · OPEN PRs · LAST COMMIT, and
 * three of those describe data no Phase 1 code path produces: nothing syncs commits or pull
 * requests yet, and `visibility` is `unknown` for every locally-registered repository because
 * registration touches no remote. Rendering `0 open PRs` and `—` under confident headers would
 * make a screen that looks synced and is not. The columns here are the ones the Backend can
 * actually answer, and the two that carry the truth about state are:
 *
 *  - **Sync** — `syncStatus` + `lastSyncedAt`, and `lastSyncError` inline when it is `failed`.
 *    That column exists precisely so a `failed` badge can be explained without opening the
 *    audit log (TDS 03 §3.6, finding B8), so the error text is rendered, not hidden in a title.
 *  - **Working tree** — the `GET /repositories/{id}/status` read model, rendered through
 *    `describeWorkingTree`, which never lets an unreadable tree render as a clean one.
 *
 * The remaining wireframe columns arrive with the data: `visibility`, open PRs and last commit
 * are filled by `POST /repositories/{id}/sync`, and a repository that has never synced shows
 * `never` here rather than a confident-looking `0`.
 */

export interface RepositoriesTabProps {
  readonly projectId: string;
  readonly projectName: string;
  /** False while the tab is not selected — status reads run a real `git status` per repository. */
  readonly active: boolean;
}

export function RepositoriesTab({ projectId, projectName, active }: RepositoriesTabProps) {
  const queryClient = useQueryClient();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [removing, setRemoving] = useState<Repository | null>(null);

  const repositories = useProjectRepositories(projectId);
  const rows = useMemo(() => repositories.data ?? [], [repositories.data]);
  const ids = useMemo(() => rows.map((repository) => repository.id), [rows]);

  const statuses = useRepositoryStatuses(ids, active && rows.length > 0);
  const statusById = useMemo(() => {
    const map = new Map<string, RepositoryStatusRow>();
    for (const row of statuses) map.set(row.repositoryId, row);
    return map;
  }, [statuses]);

  const remove = useRemoveRepository();

  const recheck = (): void => {
    for (const id of ids) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.status(id) });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-2xs text-text-secondary uppercase">Repositories</h2>
        <div className="ml-auto flex items-center gap-2">
          {rows.length === 0 ? null : (
            <button
              type="button"
              onClick={recheck}
              className="rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ height: 'var(--mc-control-sm)' }}
            >
              Recheck working trees
            </button>
          )}
          <button
            type="button"
            onClick={() => setAttachOpen(true)}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-sm)' }}
          >
            Attach existing…
          </button>
          <button
            type="button"
            onClick={() => setRegisterOpen(true)}
            className="rounded-sm px-3 font-medium text-sm"
            style={{
              height: 'var(--mc-control-sm)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            + Register repository
          </button>
        </div>
      </div>

      {repositories.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading repositories</span>
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : repositories.isError ? (
        <ErrorPanel error={repositories.error} onRetry={() => void repositories.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No repositories registered yet."
          hint="Register one by its absolute path on the Mission Control host, or scan the discovery roots from “Attach existing…” and attach what it finds."
          action={
            <button
              type="button"
              onClick={() => setRegisterOpen(true)}
              className="rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
            >
              Register repository
            </button>
          }
        />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-2xs text-text-secondary uppercase">
              <th scope="col" className="py-2 pr-3 font-medium">
                Name
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Default branch
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Working tree
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Sync
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((repository) => (
              <RepositoryRow
                key={repository.id}
                repository={repository}
                status={statusById.get(repository.id) ?? null}
                onRemove={() => setRemoving(repository)}
              />
            ))}
          </tbody>
        </table>
      )}

      <RegisterRepositoryModal
        open={registerOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setRegisterOpen(false)}
      />

      <AttachRepositoryModal
        open={attachOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setAttachOpen(false)}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'repository'} from Mission Control?`}
        body={`Mission Control forgets this repository and its recorded commits. Nothing on disk is touched — ${
          removing?.localPath ?? 'the working tree'
        } is left exactly as it is.`}
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target === null) return;
          remove.mutate(
            { id: target.id },
            {
              onError: (error) =>
                toast({
                  kind: 'danger',
                  message: `Could not remove ${target.name}: ${removalProblem(error)}`,
                  detail:
                    error.requestId === null ? error.code : `${error.code} · ${error.requestId}`,
                }),
            },
          );
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

function RepositoryRow({
  repository,
  status,
  onRemove,
}: {
  repository: Repository;
  status: RepositoryStatusRow | null;
  onRemove: () => void;
}) {
  const sync = useSyncRepository();

  return (
    <tr className="border-border border-t align-top" style={{ height: 'var(--mc-row-dense)' }}>
      <td className="py-2 pr-3">
        <span className="block truncate text-sm text-text">{repository.name}</span>
        {/* The absolute native path, verbatim and mono (F8.1). "MCS" is not a directory, and the
            operator is about to give a runtime write access to whatever this resolves to. */}
        <span
          className="block max-w-md truncate font-mono text-2xs text-text-muted"
          title={repository.localPath}
        >
          {repository.localPath}
        </span>
      </td>
      <td className="py-2 pr-3 font-mono text-text-secondary text-xs">
        {repository.defaultBranch}
      </td>
      <td className="py-2 pr-3">
        <WorkingTreeCell status={status} />
      </td>
      <td className="py-2 pr-3">
        <SyncCell repository={repository} />
      </td>
      <td className="py-2">
        <span className="flex items-center gap-1">
          {/* `202` means queued, and the outcome arrives as `repository.synced` /
              `repository.sync_failed` on the `repositories` channel — so the button reports
              acceptance and stops. There is no `GET /jobs/{id}` to poll, and a spinner waiting
              on one would never end. */}
          <button
            type="button"
            onClick={() =>
              sync.mutate(
                { id: repository.id },
                {
                  onSuccess: () =>
                    toast({
                      kind: 'success',
                      message: `Sync queued for ${repository.name}`,
                      detail: 'The row updates when the sync finishes.',
                    }),
                  onError: (error) =>
                    toast({
                      kind: 'danger',
                      message: `Could not sync ${repository.name}: ${errorMessage(error)}`,
                      detail:
                        error.requestId === null
                          ? error.code
                          : `${error.code} · ${error.requestId}`,
                    }),
                },
              )
            }
            disabled={sync.isPending}
            aria-label={`Sync ${repository.name}`}
            className="rounded-sm border border-border-control px-2 text-2xs text-text-secondary disabled:opacity-50"
            style={{ minHeight: 24, height: 'var(--mc-control-sm)' }}
          >
            {sync.isPending ? 'Queueing…' : 'Sync'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${repository.name}`}
            className="rounded-sm border border-border-control px-2 text-2xs text-text-secondary"
            style={{ minHeight: 24, height: 'var(--mc-control-sm)' }}
          >
            Remove
          </button>
        </span>
      </td>
    </tr>
  );
}

/**
 * The working-tree cell.
 *
 * Three distinct renderings, and the third is the one that matters: pending (a skeleton, because
 * a `git status` on a cold index takes seconds), read (branch + dirty count + divergence), and
 * unverifiable — which covers both an `unavailableReason` in a `200` body and a failure of the
 * status request itself. Neither is ever allowed to look like "clean".
 */
export function WorkingTreeCell({ status }: { status: RepositoryStatusRow | null }) {
  if (status?.isPending === true) {
    return (
      <span className="flex items-center gap-2" role="status" aria-busy="true">
        <span className="sr-only">Reading working tree</span>
        <Skeleton width={120} height={12} />
      </span>
    );
  }

  // A failed *request* is a different fact from an unreadable *tree*, and the operator needs the
  // `requestId` for the first — but both mean the same thing on this screen: not verified.
  if (status !== null && status.error !== null) {
    return (
      <span className="flex flex-col gap-05">
        <span className="text-2xs" style={{ color: 'var(--color-warning)' }}>
          <span aria-hidden="true">⚠</span> cannot verify
        </span>
        <span className="text-2xs text-text-muted">
          The working-tree status could not be read ({status.error.code}).
        </span>
      </span>
    );
  }

  const summary = describeWorkingTree(status?.status ?? null);

  return (
    <span className="flex flex-col gap-05">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-text-secondary text-xs">{summary.branchLabel}</span>
        <span className="text-2xs" style={{ color: `var(${workingTreeColorVar(summary.kind)})` }}>
          {summary.kind === 'unverifiable' ? <span aria-hidden="true">⚠ </span> : null}
          {summary.headline}
        </span>
        {summary.divergence === null ? null : (
          <span className="font-mono text-2xs text-text-muted">{summary.divergence}</span>
        )}
      </span>
      {summary.detail === null ? null : (
        <span className="text-2xs text-text-muted">{summary.detail}</span>
      )}
    </span>
  );
}

export function SyncCell({ repository }: { repository: Repository }) {
  const clock = useLiveClock();

  if (repository.syncStatus === 'failed') {
    return (
      <span className="flex flex-col gap-05">
        <span
          className="inline-flex w-fit items-center gap-1 rounded-xs px-2 py-05 text-2xs"
          style={{
            backgroundColor: 'var(--color-danger-subtle)',
            color: 'var(--color-danger)',
          }}
        >
          <span aria-hidden="true">✕</span> failed
        </span>
        {/* The whole reason `repositories.last_sync_error` exists: explain the badge here rather
            than sending the operator to the audit log. */}
        <span className="max-w-xs text-2xs text-text-muted" title={repository.lastSyncError ?? ''}>
          {repository.lastSyncError ?? 'No reason was recorded for the failure.'}
        </span>
        {repository.lastSyncedAt === null ? null : (
          <span
            className="text-2xs text-text-muted"
            title={formatDateTime(repository.lastSyncedAt)}
          >
            last succeeded {agoLabel(repository.lastSyncedAt, clock.now)}
          </span>
        )}
      </span>
    );
  }

  if (repository.syncStatus === 'never') {
    return <span className="text-2xs text-text-muted">never synced</span>;
  }

  return (
    <span className="flex flex-col gap-05">
      <span className="text-2xs" style={{ color: 'var(--color-success)' }}>
        <span aria-hidden="true">●</span> ok
      </span>
      <span className="text-2xs text-text-muted" title={formatDateTime(repository.lastSyncedAt)}>
        {repository.lastSyncedAt === null
          ? 'no sync time recorded'
          : agoLabel(repository.lastSyncedAt, clock.now)}
      </span>
    </span>
  );
}

/**
 * `2m ago` / `just now`. The compact form reads `now` for anything under a minute, and "now ago"
 * is not a phrase — the one-line wrapper is cheaper than a second time formatter.
 *
 * `now` comes from the frozen clock (`lib/liveness.ts`), so these values stop advancing when the
 * socket does, along with every other ticking value on the screen (TDS 06 §3.3).
 */
function agoLabel(timestamp: string, now: number): string {
  const relative = formatRelativePast(timestamp, now);
  if (relative === 'now') return 'just now';
  if (relative === '—') return 'unknown';
  return `${relative} ago`;
}
