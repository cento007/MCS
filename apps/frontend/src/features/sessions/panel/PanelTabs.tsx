import { useState } from 'react';
import { EmptyState } from '../../../components/EmptyState.js';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { Skeleton } from '../../../components/Skeleton.js';
import type { Session } from '../../../lib/api/index.js';
import { formatClock, formatDateTime } from '../../../lib/format/index.js';
import { useSessionCommits, useSessionFiles, useSessionTimeline } from '../queries.js';

/**
 * The four right-panel tab bodies (TDS 05 §6.7, TDS 06 §5.5, TDS 04 §6.7/§6.10).
 *
 * **Panel ↔ transcript correlation (WC3)** is the reason Timeline and Commits entries are
 * buttons rather than rows: "what happened at 14:32" and "what produced this commit" are the
 * two questions a 400-message session raises, and a side panel that only *lists* them makes
 * the operator scroll-hunt for the answer. An entry whose transcript point cannot be reached
 * is rendered non-interactive with a tooltip that says why, rather than as a dead click.
 */

export interface PanelTabProps {
  readonly session: Session;
  readonly active: boolean;
  /** Returns false when no transcript point exists for that instant. */
  readonly scrollToTime: (isoTimestamp: string) => boolean;
}

export function TimelineTab({ session, active, scrollToTime }: PanelTabProps) {
  const query = useSessionTimeline(session.id, active);

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;

  const entries = query.data ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No timeline entries yet."
        hint="Lifecycle facts appear here as they happen."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {entries.map((entry) => (
        <li key={entry.id}>
          <TranscriptLink
            occurredAt={entry.occurredAt}
            scrollToTime={scrollToTime}
            label={timelineLabel(entry.type, entry.fromState, entry.toState, entry.detail)}
            trigger={entry.trigger}
          />
        </li>
      ))}
      {query.hasNextPage ? (
        <li>
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            className="rounded-sm border border-border-control px-3 text-2xs text-text-secondary"
            style={{ height: 'var(--mc-control-sm)' }}
          >
            Load more
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** Verbatim F7 state names, per §5.5: `created → running (user) 13:58`. */
export function timelineLabel(
  type: string,
  fromState: string | undefined,
  toState: string | undefined,
  detail: string | undefined,
): string {
  if (type === 'session.state_changed' && fromState !== undefined && toState !== undefined) {
    return `${fromState} → ${toState}`;
  }
  if (detail !== undefined && detail.length > 0) return `${type} · ${detail}`;
  return type;
}

export function CommitsTab({ session, active, scrollToTime }: PanelTabProps) {
  const query = useSessionCommits(session.id, active);

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;

  const commits = query.data ?? [];
  if (commits.length === 0) {
    return (
      <EmptyState
        title="No commits recorded for this session."
        hint="Commits are linked as the repository is synced."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {commits.map((commit) => (
        <li key={commit.id} className="rounded-sm border border-border p-2">
          <p className="flex items-center gap-2">
            <code className="font-mono text-2xs text-text-secondary">{commit.sha.slice(0, 7)}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-text" title={commit.message}>
              {commit.message.split('\n')[0]}
            </span>
          </p>
          <p className="mt-1 flex items-center gap-2 text-2xs text-text-muted">
            <span>
              {commit.filesChanged} file{commit.filesChanged === 1 ? '' : 's'}
            </span>
            <span className="font-mono">+{commit.additions}</span>
            <span className="font-mono">−{commit.deletions}</span>
            <span className="font-mono">{formatClock(commit.committedAt)}</span>
            <JumpButton occurredAt={commit.committedAt} scrollToTime={scrollToTime} />
          </p>
        </li>
      ))}
    </ul>
  );
}

export function FilesTab({ session, active }: PanelTabProps) {
  const query = useSessionFiles(session.id, active);

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;

  const model = query.data;
  if (model === undefined) return null;

  return (
    <div className="flex flex-col gap-2">
      {/* §6.10.2: "The UI must render `partial` visibly" — a Files tab that merely looks short
          is indistinguishable from a Session that genuinely touched few files. */}
      {model.completeness === 'partial' ? (
        <p
          className="rounded-xs px-2 py-1 text-2xs"
          style={{ backgroundColor: 'var(--color-warning-subtle)', color: 'var(--color-warning)' }}
        >
          ⚠ Partial list —{' '}
          {model.completenessReason === 'observation_degraded'
            ? 'transcript fidelity is degraded, so some tool activity was never seen.'
            : 'hooks are not installed for this session, so tool activity is incomplete.'}
        </p>
      ) : null}

      <p className="font-mono text-2xs text-text-muted" title={model.root}>
        {model.root}
      </p>
      {model.commitsAsOf === null ? null : (
        <p className="text-2xs text-text-muted">commits as of {formatClock(model.commitsAsOf)}</p>
      )}

      {model.files.length === 0 ? (
        <EmptyState title="No files touched yet." />
      ) : (
        <ul className="flex flex-col gap-1">
          {model.files.map((file) => (
            <li key={file.path} className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-2xs text-text-secondary"
                title={file.path}
              >
                {file.outsideRoot ? '↗ ' : ''}
                {file.path}
              </span>
              <span className="font-mono text-2xs text-text-muted">×{file.touchCount}</span>
            </li>
          ))}
        </ul>
      )}

      {model.truncated ? (
        <p className="text-2xs text-text-muted">Showing 500 of {model.totalFiles} files.</p>
      ) : null}
    </div>
  );
}

export interface NotesTabProps {
  readonly session: Session;
  readonly onSave: (notes: string) => void;
  readonly saving: boolean;
}

export function NotesTab({ session, onSave, saving }: NotesTabProps) {
  const [draft, setDraft] = useState(session.notes ?? '');
  const dirty = draft !== (session.notes ?? '');

  return (
    <div className="flex flex-col gap-2">
      <textarea
        rows={10}
        value={draft}
        aria-label="Session notes"
        placeholder="Operator notes for this session…"
        onChange={(event) => setDraft(event.target.value)}
        className="w-full resize-y rounded-sm border bg-transparent p-2 text-sm text-text"
        style={{ borderColor: 'var(--color-border-control)' }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(draft)}
          disabled={!dirty || saving}
          className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
          style={{ height: 'var(--mc-control-sm)' }}
        >
          {saving ? 'Saving…' : 'Save notes'}
        </button>
        <span className="text-2xs text-text-muted">
          {dirty ? 'Unsaved changes' : `Saved ${formatDateTime(session.updatedAt)}`}
        </span>
      </div>
    </div>
  );
}

function TranscriptLink({
  occurredAt,
  scrollToTime,
  label,
  trigger,
}: {
  occurredAt: string;
  scrollToTime: (isoTimestamp: string) => boolean;
  label: string;
  trigger: string;
}) {
  const [unreachable, setUnreachable] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setUnreachable(!scrollToTime(occurredAt))}
      title={
        unreachable
          ? 'No transcript point corresponds to this entry.'
          : 'Jump to this moment in the transcript'
      }
      className="flex w-full items-center gap-2 rounded-xs px-1 text-left"
      style={{ minHeight: 24 }}
    >
      <span className="font-mono text-2xs text-text-muted">{formatClock(occurredAt)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{label}</span>
      <span className="text-2xs text-text-muted">({trigger})</span>
    </button>
  );
}

function JumpButton({
  occurredAt,
  scrollToTime,
}: {
  occurredAt: string;
  scrollToTime: (isoTimestamp: string) => boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => scrollToTime(occurredAt)}
      aria-label="Jump to the transcript at this commit"
      title="Jump to the transcript at this commit"
      className="ml-auto rounded-xs px-1 text-text-muted"
      style={{ minWidth: 24, minHeight: 24 }}
    >
      ↧
    </button>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton height={20} />
      <Skeleton height={20} />
      <Skeleton height={20} />
    </div>
  );
}
