import { Link } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Modal } from '../../components/Modal.js';
import { Skeleton } from '../../components/Skeleton.js';
import { ApiError, type DiscoveryReport } from '../../lib/api/index.js';
import { useAssignRepository, useDiscoverRepositories } from './mutations.js';
import { useAllRepositories } from './queries.js';

/**
 * Attach an already-known Repository to this Project, and run discovery.
 *
 * The two belong in one dialog because discovery's output *is* this dialog's input: a scan
 * registers rows with `projectId: null` — "discovered, unassigned" (TDS 03 §3.6) — because it
 * decides everything from a working tree's `origin` remote and has no way to know which Project
 * an operator considers a repository part of. A Discover button anywhere else would appear to do
 * nothing, since nothing it registers would show up on the Project it was pressed from.
 *
 * The scan report is rendered in full, skips included. That is the entire reason the route
 * answers `200` with a report instead of `202` with a job id (flagged in the Backend's
 * `discover.ts`): "no remote", "not GitHub", "already registered" are what an operator needs
 * when a repository they expected did not appear, and nothing persists them.
 */

export interface AttachRepositoryModalProps {
  readonly open: boolean;
  readonly projectId: string;
  readonly projectName: string;
  readonly onClose: () => void;
}

export function AttachRepositoryModal({
  open,
  projectId,
  projectName,
  onClose,
}: AttachRepositoryModalProps) {
  const repositories = useAllRepositories();
  const assign = useAssignRepository();
  const discover = useDiscoverRepositories();

  const unassigned = (repositories.data ?? []).filter(
    (repository) => repository.projectId === null,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Attach an existing repository"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm border border-border-control px-3 text-sm text-text"
          style={{ height: 'var(--mc-control-md)' }}
        >
          Done
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-2xs text-text-secondary uppercase">
              Unassigned repositories
            </h3>
            <button
              type="button"
              onClick={() => discover.mutate()}
              disabled={discover.isPending}
              className="ml-auto rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
              style={{ height: 'var(--mc-control-sm)' }}
            >
              {discover.isPending ? 'Scanning…' : 'Scan discovery roots'}
            </button>
          </div>

          {repositories.isPending ? (
            <div className="space-y-2" role="status" aria-busy="true">
              <span className="sr-only">Loading repositories</span>
              <Skeleton height={24} />
              <Skeleton height={24} />
            </div>
          ) : repositories.isError ? (
            <ErrorPanel error={repositories.error} onRetry={() => void repositories.refetch()} />
          ) : unassigned.length === 0 ? (
            <p className="text-2xs text-text-muted leading-150">
              Every known repository already belongs to a project. Scan the discovery roots to look
              for more, or register one by path.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {unassigned.map((repository) => (
                <li key={repository.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{repository.name}</span>
                    <span
                      className="block truncate font-mono text-2xs text-text-muted"
                      title={repository.localPath}
                    >
                      {repository.localPath}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Attach ${repository.name} to ${projectName}`}
                    disabled={assign.isPending}
                    onClick={() => assign.mutate({ id: repository.id, projectId })}
                    className="shrink-0 rounded-sm border border-border-control px-3 text-2xs text-text disabled:opacity-50"
                    style={{ minHeight: 24, height: 'var(--mc-control-sm)' }}
                  >
                    Attach
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {discover.isError ? <DiscoveryFailure error={discover.error} /> : null}
        {discover.data === undefined ? null : <DiscoverySummary report={discover.data} />}
      </div>
    </Modal>
  );
}

/**
 * `INTEGRATION_NOT_CONFIGURED` here means one specific, fixable thing — no discovery roots are
 * saved — so it is answered with the route to fix it rather than with the generic envelope.
 */
function DiscoveryFailure({ error }: { error: ApiError }) {
  if (error instanceof ApiError && error.code === 'INTEGRATION_NOT_CONFIGURED') {
    return (
      <div
        role="alert"
        className="rounded-md border p-3"
        style={{
          backgroundColor: 'var(--color-warning-subtle)',
          borderColor: 'var(--color-warning)',
        }}
      >
        <p className="text-sm text-text leading-150">
          There are no discovery roots to scan.{' '}
          <Link
            to="/settings/integrations"
            className="underline decoration-dotted underline-offset-2"
          >
            Add one in Settings → Integrations → GitHub
          </Link>
          , then scan again.
        </p>
      </div>
    );
  }

  return <ErrorPanel error={error} title="The scan could not run" />;
}

function DiscoverySummary({ report }: { report: DiscoveryReport }) {
  return (
    <section
      data-testid="discovery-report"
      className="rounded-md border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <h3 className="font-medium text-2xs text-text-secondary uppercase">Scan result</h3>
      <p className="mt-1 text-sm text-text">
        {report.counts.workingTreesFound} working tree
        {report.counts.workingTreesFound === 1 ? '' : 's'} found · {report.counts.registered}{' '}
        registered · {report.counts.skipped} skipped
      </p>

      {report.truncated ? (
        <p className="mt-1 text-2xs" style={{ color: 'var(--color-warning)' }}>
          <span aria-hidden="true">⚠</span> The scan hit its bounds and stopped early, so this is
          not the whole filesystem — narrow the discovery roots and scan again.
        </p>
      ) : null}

      {report.skipped.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-1">
          {report.skipped.map((skip) => (
            <li key={skip.localPath} className="text-2xs text-text-muted">
              <span className="font-mono" title={skip.localPath}>
                {skip.localPath}
              </span>{' '}
              — {skip.detail ?? skipSentence(skip.reason)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A readable fallback when the server sent a reason but no sentence. Unknown reasons are echoed
 * verbatim rather than swallowed — a skip nobody can explain is still better than a skip nobody
 * is told about.
 */
function skipSentence(reason: string): string {
  switch (reason) {
    case 'already_registered':
      return 'already registered';
    case 'invalid_path':
      return 'not usable as a repository path';
    default:
      return reason.replaceAll('_', ' ');
  }
}
