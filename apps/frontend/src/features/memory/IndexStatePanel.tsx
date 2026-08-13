import type { ReactNode } from 'react';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import type { ApiError } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format/index.js';
import type { MemoryBackfillStatus } from './types.js';
import { isRunActive } from './types.js';

/**
 * What is actually indexed, and how to change that.
 *
 * `GET /memory-items/backfill` answers two different questions in one document and the panel keeps
 * them apart, because conflating them is how "nothing indexed" and "no run has happened" become
 * one misleading line:
 *
 *  - **Index facts** — `indexedModels` and `rowsFromOtherModels`, derived from `memory_items`
 *    itself. `indexedModels` empty means *nothing is indexed*, full stop. More than one entry, or
 *    a non-zero `rowsFromOtherModels`, means part of the index was embedded by a model that is no
 *    longer configured, and those rows cannot answer a query.
 *  - **Run facts** — the active run, or the most recent one. All-`null` means no run has ever been
 *    triggered, which is not the same as an empty index (an event-driven index needs no run).
 *
 * ## No progress bar
 *
 * `BackfillProgress` carries counters and a stage cursor — `sourcesSeen`, `sourcesIndexed`,
 * `chunksEmbedded` — and **no total**. The sweep pages through four tables with a keyset cursor
 * and finds out how much there was by reaching the end of it, so a percentage would need a count
 * nobody has taken. Rendering `sourcesIndexed / sourcesSeen` as a bar would be worse than useless:
 * `sourcesSeen` grows *with* progress, so the bar would sit near 100% from the first slice and
 * never move. The counters are shown as counters, and the stage names where the sweep is.
 */

export interface IndexStatePanelProps {
  readonly status: MemoryBackfillStatus | undefined;
  readonly isPending: boolean;
  readonly error: ApiError | null;
  readonly onRetry: () => void;
  readonly onRunBackfill: () => void;
  readonly onRebuild: () => void;
  readonly triggerPending: boolean;
  /** The model retrieval says it is querying with — from the last search, when there was one. */
  readonly currentModel: string | null;
  /**
   * The last search reported `stamp_mismatch` — the stored vectors cannot answer a query.
   *
   * This panel would otherwise say `● Indexed with nomic-embed-text` in the success colour
   * directly above a red panel saying the index cannot be trusted, and it would not be *wrong*:
   * `memory_items.embedding_model` really does hold that name. But the rows are not the index —
   * the vectors are — and a green chip beside a refusal is the exact reassurance this screen
   * exists to withhold. Observed in the browser against a tampered collection stamp.
   */
  readonly untrusted: boolean;
}

export function IndexStatePanel(props: IndexStatePanelProps) {
  if (props.error !== null) {
    return (
      <section className="rounded-md border border-border p-3">
        <ErrorPanel
          error={props.error}
          title="The index state could not be read"
          onRetry={props.onRetry}
        />
      </section>
    );
  }

  if (props.isPending || props.status === undefined) {
    return (
      <section className="rounded-md border border-border p-3" role="status" aria-busy="true">
        <span className="sr-only">Loading index state</span>
        <Skeleton width={180} height={16} />
        <div className="mt-2">
          <Skeleton height={28} />
        </div>
      </section>
    );
  }

  const status = props.status;
  const active = isRunActive(status.state);
  const indexed = status.indexedModels.length > 0;

  return (
    <section
      aria-label="Memory index state"
      className="rounded-md border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium text-sm text-text">Index</h2>

        {indexed && props.untrusted ? (
          <Fact
            glyph="⚠"
            colorVar="--color-danger"
            label={`${status.indexedModels.join(', ')} rows stored, none queryable`}
          />
        ) : indexed ? (
          <Fact
            glyph="●"
            colorVar="--color-success"
            label={`Indexed with ${status.indexedModels.join(', ')}`}
          />
        ) : (
          // The one fact the whole screen turns on, and the only honest way to state it: the
          // table holds no rows, so no query can match anything regardless of phrasing.
          <Fact glyph="○" label="Nothing indexed" />
        )}

        {props.currentModel === null || status.indexedModels.includes(props.currentModel) ? null : (
          <Fact
            glyph="⚠"
            colorVar="--color-warning"
            label={`Queries run through ${props.currentModel}`}
          />
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={props.onRunBackfill}
            disabled={props.triggerPending || active}
            className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
            style={{ height: 'var(--mc-control-sm)', minHeight: 24 }}
          >
            {active ? 'Run in progress' : 'Run backfill'}
          </button>
          <button
            type="button"
            onClick={props.onRebuild}
            disabled={props.triggerPending}
            className="rounded-sm border px-3 text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-sm)',
              minHeight: 24,
              borderColor: 'var(--color-danger)',
              color: 'var(--color-danger)',
            }}
          >
            Rebuild
          </button>
        </div>
      </div>

      {status.rowsFromOtherModels > 0 ? (
        <p
          className="mt-2 rounded-sm px-2 py-1 text-2xs leading-150"
          style={{
            backgroundColor: 'var(--color-warning-subtle)',
            color: 'var(--color-warning)',
          }}
        >
          ⚠ {status.rowsFromOtherModels} chunk
          {status.rowsFromOtherModels === 1 ? ' was' : 's were'} embedded by a different model and
          cannot answer a query. A rebuild re-embeds them; nothing else will.
        </p>
      ) : null}

      <RunLine status={status} active={active} />
    </section>
  );
}

function RunLine({ status, active }: { status: MemoryBackfillStatus; active: boolean }) {
  if (status.runId === null) {
    return (
      <p className="mt-2 text-2xs text-text-muted leading-150">
        No backfill has run on this instance. Sessions, commits, ADRs and pull requests are indexed
        as they happen; vault notes and repository documentation are file-backed and only a backfill
        reaches them — as it does everything that already existed.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <RunStateChip state={status.state} />
        {status.mode === null ? null : <span>{status.mode}</span>}
        {status.trigger === null ? null : <span>triggered by {status.trigger}</span>}
        {status.startedAt === null ? null : <span>started {formatDateTime(status.startedAt)}</span>}
        {status.completedAt === null ? null : (
          <span>finished {formatDateTime(status.completedAt)}</span>
        )}
      </p>

      {status.progress === null ? null : (
        <p className="mt-1 flex flex-wrap items-center gap-3 font-mono text-2xs text-text-secondary">
          <span>{status.progress.sourcesIndexed} indexed</span>
          <span>{status.progress.chunksEmbedded} chunks</span>
          <span>{status.progress.sourcesSkipped} unchanged</span>
          {status.progress.failures > 0 ? (
            <span style={{ color: 'var(--color-danger)' }}>{status.progress.failures} failed</span>
          ) : null}
          {status.progress.pruned > 0 ? <span>{status.progress.pruned} pruned</span> : null}
          {active && status.progress.stage !== null ? (
            <span className="text-text-muted">at {status.progress.stage}</span>
          ) : null}
        </p>
      )}

      {active ? (
        // Said explicitly rather than implied by the absence of a bar, because the absence of a
        // bar is exactly what an operator reads as "the UI forgot to show progress".
        <p className="mt-1 text-2xs text-text-muted leading-150">
          These are counts, not a percentage: the sweep pages through the sources with a cursor and
          only learns the total by reaching the end, so there is no denominator to draw a bar
          against.
        </p>
      ) : null}

      {status.error === null ? null : (
        <p
          className="mt-2 rounded-sm px-2 py-1 text-2xs leading-150"
          style={{ backgroundColor: 'var(--color-danger-subtle)', color: 'var(--color-danger)' }}
        >
          ✕ {status.error}
        </p>
      )}

      {status.progress?.lastError == null ? null : (
        <p className="mt-1 text-2xs text-text-muted leading-150">
          Last source failure: {status.progress.lastError}
        </p>
      )}
    </div>
  );
}

/**
 * Run state, in the **health/outcome** ramp rather than the F7 session ramp.
 *
 * `--color-state-*` is keyed verbatim to the six Session states and means "this Session is
 * running"; a sync run is a different vocabulary that happens to share two of the words. Reusing
 * the state tokens here is the token misuse `theme.css` names as a review failure, and it would
 * also put a pulsing `running` mark on something that is not a Session.
 */
function RunStateChip({ state }: { state: string | null }) {
  if (state === null) return null;

  const colorVar =
    state === 'completed'
      ? '--color-success'
      : state === 'failed'
        ? '--color-danger'
        : state === 'running'
          ? '--color-info'
          : null;

  return (
    <span
      className="inline-flex items-center rounded-xs border border-border px-2 py-05 text-2xs"
      style={colorVar === null ? undefined : { color: `var(${colorVar})` }}
    >
      {state}
    </span>
  );
}

function Fact({
  glyph,
  label,
  colorVar,
}: {
  glyph: string;
  label: string;
  colorVar?: string;
}): ReactNode {
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs"
      style={{ color: colorVar === undefined ? 'var(--color-text-muted)' : `var(${colorVar})` }}
    >
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}
