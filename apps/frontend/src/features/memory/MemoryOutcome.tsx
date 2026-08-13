import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import type { MemoryEmptyReason } from './types.js';

/**
 * The five ways a memory search can come back with nothing, rendered as five different screens.
 *
 * This component is the reason the Backend returns `emptyReason` as a first-class answer instead
 * of an empty array. The operator's next action is completely different in each case, and a
 * single "No results" would send them to the wrong place four times out of five:
 *
 * | reason            | what is true                              | next action            |
 * |-------------------|-------------------------------------------|------------------------|
 * | `not_configured`  | no embedding model is set                 | Settings               |
 * | `index_empty`     | configured, but nothing to match against  | run a backfill         |
 * | `below_threshold` | the query ran; everything scored too low  | rephrase, or drop floor|
 * | `unavailable`     | Qdrant or Ollama could not be reached     | fix the service        |
 * | `stamp_mismatch`  | the stored vectors are from another model | rebuild the collection |
 *
 * Two structural properties, not styling choices:
 *
 *  - **The last two are not empty states.** They render as `role="alert"` in the danger palette,
 *    because the index cannot answer *any* query — reading them as "no matches for this phrase"
 *    would have the operator rephrasing against an index that is not being consulted at all.
 *    `stamp_mismatch` is the sharper of the two: the collection is *reachable* and its contents
 *    are *incomparable*, which is the one failure that would otherwise return confident nonsense.
 *  - **The Backend's `detail` sentence is rendered verbatim.** It carries the numbers only the
 *    server knows — which setting is missing, how many candidates were considered, which model
 *    the collection was stamped with — and paraphrasing it here would be a second copy of a
 *    message that has to stay true to the code that produced it.
 */

export interface MemoryOutcomeProps {
  readonly reason: MemoryEmptyReason;
  /** The Backend's operator-facing sentence. Rendered as-is. */
  readonly detail: string | null;
  /** True when the request carried a project, session, tier or source-type filter. */
  readonly scoped: boolean;
  /** The floor this answer was produced under, so `below_threshold` can offer to drop it. */
  readonly minScore: number;
  readonly onShowClosest: () => void;
  readonly onRunBackfill: () => void;
  readonly onRebuild: () => void;
  readonly onRetry: () => void;
  readonly backfillPending: boolean;
  /** A run is already queued or running — triggering another answers `409`. */
  readonly backfillActive: boolean;
}

export function MemoryOutcome(props: MemoryOutcomeProps) {
  switch (props.reason) {
    case 'not_configured':
      return <NotConfigured detail={props.detail} />;
    case 'index_empty':
      return (
        <NothingIndexed
          detail={props.detail}
          onRunBackfill={props.onRunBackfill}
          pending={props.backfillPending}
          active={props.backfillActive}
        />
      );
    case 'below_threshold':
      return (
        <BelowThreshold
          detail={props.detail}
          scoped={props.scoped}
          minScore={props.minScore}
          onShowClosest={props.onShowClosest}
        />
      );
    case 'unavailable':
      return <Unavailable detail={props.detail} onRetry={props.onRetry} />;
    case 'stamp_mismatch':
      return (
        <StampMismatch
          detail={props.detail}
          onRebuild={props.onRebuild}
          pending={props.backfillPending}
        />
      );
    default:
      // `none` with no results is a shape the Backend does not produce — every empty list comes
      // back with a reason. Saying so is better than rendering a sixth, invented explanation.
      return (
        <EmptyState
          title="No results, and no reason given."
          hint="The Backend returned an empty result set without an emptyReason. That is a contract violation worth reporting."
        />
      );
  }
}

// ------------------------------------------------------------------------------ 1. not configured

function NotConfigured({ detail }: { detail: string | null }) {
  return (
    <OutcomeRegion>
      <EmptyState
        title="◌  Memory is not configured."
        hint={
          detail ??
          'No embedding model is set, so nothing has been indexed and no query can be answered.'
        }
        action={
          <div className="mt-2 flex flex-col items-center gap-2">
            <Link
              to="/settings/integrations"
              className="rounded-sm px-3 font-medium text-sm"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 'var(--mc-control-md)',
                backgroundColor: 'var(--color-accent)',
                color: 'var(--color-on-accent)',
              }}
            >
              Set an embedding model in Settings →
            </Link>
            <p className="max-w-md text-2xs text-text-muted leading-150">
              Mission Control will not pick one for you: the model is stamped permanently onto the
              vector collection, and every vector in it would be wrong the moment you chose
              differently.
            </p>
          </div>
        }
      />
    </OutcomeRegion>
  );
}

// ------------------------------------------------------------------------------- 2. nothing indexed

function NothingIndexed({
  detail,
  onRunBackfill,
  pending,
  active,
}: {
  detail: string | null;
  onRunBackfill: () => void;
  pending: boolean;
  active: boolean;
}) {
  return (
    <OutcomeRegion>
      <EmptyState
        title="◌  Nothing is indexed for this scope."
        hint={detail ?? 'The vector collection holds no chunks that this query could match.'}
        action={
          <div className="mt-2 flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onRunBackfill}
              disabled={pending || active}
              className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
              style={{
                minHeight: 'var(--mc-control-md)',
                backgroundColor: 'var(--color-accent)',
                color: 'var(--color-on-accent)',
              }}
            >
              {active ? 'A backfill is already running' : pending ? 'Starting…' : 'Run a backfill'}
            </button>
            {/* The distinction this whole component exists for, said out loud once. */}
            <p className="max-w-md text-2xs text-text-muted leading-150">
              Rephrasing will not help — there is nothing to match against yet. A backfill indexes
              existing ADRs, pull requests, commits, completed sessions and vault notes; after that,
              new ones are indexed as they happen.
            </p>
          </div>
        }
      />
    </OutcomeRegion>
  );
}

// ------------------------------------------------------------------------------ 3. below the floor

function BelowThreshold({
  detail,
  scoped,
  minScore,
  onShowClosest,
}: {
  detail: string | null;
  scoped: boolean;
  minScore: number;
  onShowClosest: () => void;
}) {
  return (
    <OutcomeRegion>
      <EmptyState
        title="○  Nothing scored above the relevance floor."
        hint={
          detail ??
          `The index was searched and every candidate scored below ${minScore.toFixed(2)}.`
        }
        action={
          <div className="mt-2 flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onShowClosest}
              className="rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ minHeight: 'var(--mc-control-md)' }}
            >
              Show the closest matches anyway
            </button>
            <p className="max-w-md text-2xs text-text-muted leading-150">
              This is the one empty answer where rephrasing helps: the index was searched and it had
              candidates. Dropping the floor to 0 shows them with their scores — useful for judging
              whether the floor is wrong, misleading as a way to read memory.
              {scoped ? ' This query was also scoped; widening the scope may reach more.' : ''}
            </p>
          </div>
        }
      />
    </OutcomeRegion>
  );
}

// -------------------------------------------------------------------------------- 4a. unreachable

function Unavailable({ detail, onRetry }: { detail: string | null; onRetry: () => void }) {
  return (
    <BrokenPanel
      title="✕  Memory search could not run."
      body={
        detail ??
        'The vector store or the embedding service could not be reached, so no query was answered.'
      }
      note="This is not an empty result. Nothing was searched, so nothing can be concluded about what memory contains."
      actions={
        <>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-border-control px-3 font-medium text-sm text-text"
            style={{ minHeight: 'var(--mc-control-md)' }}
          >
            Try again
          </button>
          <Link
            to="/settings/services"
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 'var(--mc-control-md)',
            }}
          >
            Check service health →
          </Link>
        </>
      }
    />
  );
}

// ----------------------------------------------------------------------------- 4b. stamp mismatch

function StampMismatch({
  detail,
  onRebuild,
  pending,
}: {
  detail: string | null;
  onRebuild: () => void;
  pending: boolean;
}) {
  return (
    <BrokenPanel
      title="⚠  The index cannot be trusted."
      body={
        detail ??
        'The collection was built by a different embedding model than the one configured now.'
      }
      note="Vectors produced by two different models are not comparable, so searching across them returns confident nonsense rather than an error. Retrieval refuses instead of degrading — this is not “no matches”, and rephrasing cannot fix it. The collection has to be rebuilt from zero."
      actions={
        <>
          <button
            type="button"
            onClick={onRebuild}
            disabled={pending}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              minHeight: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-danger)',
              color: 'var(--color-text-inverse)',
            }}
          >
            {pending ? 'Starting…' : 'Rebuild the index'}
          </button>
          <Link
            to="/settings/integrations"
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 'var(--mc-control-md)',
            }}
          >
            Review the embedding model →
          </Link>
        </>
      }
    />
  );
}

// ------------------------------------------------------------------------------------ primitives

/**
 * `role="status"` for the three genuinely-empty answers: the search ran (or could not start for
 * a configuration reason) and the region's content is the result, so it is announced politely
 * rather than interrupting.
 */
function OutcomeRegion({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-md border border-border">
      {children}
    </div>
  );
}

/**
 * The broken pair. Danger palette and `role="alert"`, because the operator is being told the
 * index is not answering — a condition they would otherwise misread as a property of their query.
 */
function BrokenPanel({
  title,
  body,
  note,
  actions,
}: {
  title: string;
  body: string;
  note: string;
  actions: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
      }}
    >
      <p className="font-medium text-sm" style={{ color: 'var(--color-danger)' }}>
        {title}
      </p>
      <p className="mt-2 text-sm text-text leading-150">{body}</p>
      <p className="mt-2 max-w-2xl text-text-muted text-xs leading-150">{note}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
