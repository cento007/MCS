import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Skeleton } from '../../components/Skeleton.js';
import { errorMessage } from '../../lib/api/index.js';
import { useChannel } from '../../lib/ws/context.js';
import { toast } from '../../stores/toast-store.js';
import { IndexStatePanel } from './IndexStatePanel.js';
import { MemoryOutcome } from './MemoryOutcome.js';
import { MemoryResults } from './MemoryResults.js';
import {
  DEFAULT_MEMORY_SEARCH_LIMIT,
  useMemoryConfiguration,
  useMemoryIndexStatus,
  useMemorySearch,
  useScopeProjects,
  useScopeSession,
  useTriggerBackfill,
} from './queries.js';
import { ScopeControls } from './ScopeControls.js';
import { applyScope, isScoped, type MemoryScope, readScope, toSearchRequest } from './scope.js';

/**
 * `/memory` — semantic search across the four-tier memory system (PRD §8.4, TDS 06 §6.1).
 *
 * The wireframe reserved "a search field and a results region". The substance is what the results
 * region does when it has nothing to show, because a memory screen is empty far more often than
 * it is full, and the four things "empty" can mean have four different fixes:
 *
 *   not configured → Settings · nothing indexed → run a backfill · nothing relevant → rephrase or
 *   drop the floor · broken → the index is not answering at all.
 *
 * `MemoryOutcome` owns that fork; this page owns three things around it.
 *
 * **1. The query and its scope live in the URL.** A search is worth linking to (the `Ctrl+K`
 * palette hands off to `/memory?q=…`), the request object is the cache key so it must come from
 * one stable place, and a scoped query that loses its scope on reload is a query whose answer
 * quietly changes meaning.
 *
 * **2. Configuration is checked before a query is typed.** An operator should not have to compose
 * a question to be told that no embedding model is set. The check is a projection of
 * `GET /services/health`, which is the only route that can distinguish "not configured" from
 * "configured and empty" — see `queries.ts`.
 *
 * **3. An index that moves under a result is disclosed, not acted on.** The `memory` channel
 * invalidates the index state, never the cached search: re-running the query on every
 * `memory.item_stored` would mean an embedding call per indexed source while the operator reads
 * the first answer. Instead the page notices the index changed after the answer was produced and
 * offers to run it again.
 */
export function MemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = useMemo(() => readScope(searchParams), [searchParams]);

  const [draft, setDraft] = useState(scope.q);
  const [confirmingRebuild, setConfirmingRebuild] = useState(false);

  // Keep the field in step with the URL, so a palette hand-off or a back button changes what is
  // in the box as well as what was searched.
  useEffect(() => setDraft(scope.q), [scope.q]);

  // `memory.item_stored` / `memory.reindexed` land here (TDS 04 §14.3). The subscription is the
  // page's, not the shell's: nothing outside this screen reads the index state.
  useChannel('memory');

  const request = useMemo(
    () => (scope.q.length === 0 ? null : toSearchRequest(scope, DEFAULT_MEMORY_SEARCH_LIMIT)),
    [scope],
  );

  const search = useMemorySearch(request);
  const indexStatus = useMemoryIndexStatus();
  const configuration = useMemoryConfiguration();
  const projects = useScopeProjects();
  const session = useScopeSession(scope.sessionId);
  const trigger = useTriggerBackfill();

  const setScope = (next: MemoryScope): void => {
    setSearchParams(applyScope(searchParams, next), { replace: true });
  };

  const runBackfill = (mode: 'incremental' | 'rebuild'): void => {
    trigger.mutate(
      { mode },
      {
        onSuccess: (run) => {
          toast({
            kind: 'info',
            message:
              mode === 'rebuild'
                ? 'Rebuilding the index from zero. Retrieval is unavailable until it finishes.'
                : `Backfill queued (run ${run.runId.slice(-6)}).`,
          });
        },
        // §11.1: a failed mutation with no more specific inline surface is a toast. The Backend
        // refuses for three distinct reasons here — not configured, a stamp mismatch under an
        // incremental run, and a run already active — and each returns its own message.
        onError: (error) => toast({ kind: 'danger', message: errorMessage(error) }),
      },
    );
  };

  const response = search.data;
  const results = response?.results ?? [];
  const runActive = indexStatus.data?.state === 'queued' || indexStatus.data?.state === 'running';

  /**
   * Did the index move after this answer was produced?
   *
   * Both timestamps come from the same machine — the Backend and the browser are the same host in
   * the F2.1 topology — so the comparison is a clock comparison the deployment makes safe. The
   * consequence of being wrong is an extra offer to re-run the search, never a stale answer
   * presented as fresh.
   */
  const completedAt = indexStatus.data?.completedAt ?? null;
  const indexMovedAfterSearch =
    response !== undefined &&
    search.dataUpdatedAt > 0 &&
    completedAt !== null &&
    Date.parse(completedAt) > search.dataUpdatedAt;

  return (
    <section className="flex min-h-0 flex-col gap-4 px-4 py-4 md:px-6">
      <h1 className="font-medium text-text text-xl">Memory</h1>

      {/* `<search>` rather than `role="search"` — the native element carries the role, and
          the form inside it is what makes Enter submit. */}
      <search>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setScope({ ...scope, q: draft.trim() });
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Ask your engineering memory"
            placeholder="Ask your engineering memory…"
            // The Backend's ceiling. Enforcing it here turns a `400` into an input that simply
            // stops accepting characters.
            maxLength={2000}
            className="min-w-0 flex-1 rounded-sm border bg-transparent px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
          />
          <button
            type="submit"
            className="rounded-sm px-3 font-medium text-sm"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            Search
          </button>
        </form>
      </search>

      <ScopeControls
        scope={scope}
        onChange={setScope}
        projects={projects.data ?? []}
        projectsUnavailable={projects.isError}
        session={session.data}
      />

      <IndexStatePanel
        status={indexStatus.data}
        isPending={indexStatus.isPending}
        error={indexStatus.error}
        onRetry={() => void indexStatus.refetch()}
        onRunBackfill={() => runBackfill('incremental')}
        onRebuild={() => setConfirmingRebuild(true)}
        triggerPending={trigger.isPending}
        currentModel={response?.embeddingModel ?? null}
        untrusted={response?.emptyReason === 'stamp_mismatch'}
      />

      <div className="min-h-0">
        {request === null ? (
          <IdleRegion
            configured={configuration.configured}
            configurationPending={configuration.isPending}
          />
        ) : search.isPending ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <span className="sr-only">Searching memory</span>
            <Skeleton height={96} />
            <Skeleton height={96} />
            <Skeleton height={96} />
          </div>
        ) : search.isError ? (
          <ErrorPanel
            error={search.error}
            title="The memory search failed"
            onRetry={() => void search.refetch()}
          />
        ) : response === undefined ? null : (
          <div className="flex flex-col gap-3">
            <ResultsHeader
              count={results.length}
              minScore={response.minScore}
              embeddingModel={response.embeddingModel}
              candidatesConsidered={response.candidatesConsidered}
              fetching={search.isFetching}
            />

            {indexMovedAfterSearch ? (
              <p
                role="status"
                className="flex flex-wrap items-center gap-2 rounded-sm px-2 py-1 text-2xs leading-150"
                style={{
                  backgroundColor: 'var(--color-info-subtle)',
                  color: 'var(--color-info)',
                }}
              >
                The index changed after this answer was produced.
                <button
                  type="button"
                  onClick={() => void search.refetch()}
                  className="rounded-xs underline decoration-dotted underline-offset-2"
                  style={{ minHeight: 24 }}
                >
                  Run the search again
                </button>
              </p>
            ) : null}

            {results.length > 0 ? (
              <MemoryResults results={results} minScore={response.minScore} />
            ) : (
              <MemoryOutcome
                reason={response.emptyReason}
                detail={response.detail}
                scoped={isScoped(scope)}
                minScore={response.minScore}
                onShowClosest={() => setScope({ ...scope, minScore: 0 })}
                onRunBackfill={() => runBackfill('incremental')}
                onRebuild={() => setConfirmingRebuild(true)}
                onRetry={() => void search.refetch()}
                backfillPending={trigger.isPending}
                backfillActive={runActive}
              />
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmingRebuild}
        title="Rebuild the memory index?"
        body={
          'This destroys every stored vector and re-embeds from zero. Semantic search returns ' +
          'nothing until it finishes — the collection carries one embedding stamp, so old and ' +
          'new vectors cannot coexist in it. It is the correct action after changing the ' +
          'embedding model, and the wrong one otherwise.'
        }
        confirmLabel="Rebuild from zero"
        destructive
        pending={trigger.isPending}
        onConfirm={() => {
          setConfirmingRebuild(false);
          runBackfill('rebuild');
        }}
        onCancel={() => setConfirmingRebuild(false)}
      />
    </section>
  );
}

/**
 * The results header — the provenance of the answer on screen.
 *
 * The floor and the model are here rather than hidden in a tooltip because they are the two facts
 * that decide what a score means: the same prose against the same index under a different floor
 * is a different answer, and against a different model the numbers are not comparable at all.
 */
function ResultsHeader({
  count,
  minScore,
  embeddingModel,
  candidatesConsidered,
  fetching,
}: {
  count: number;
  minScore: number;
  embeddingModel: string | null;
  candidatesConsidered: number;
  fetching: boolean;
}) {
  return (
    <p className="flex flex-wrap items-center gap-3 text-2xs text-text-muted" aria-live="polite">
      <span className="text-text-secondary">
        {count} result{count === 1 ? '' : 's'}
      </span>
      <span title="Chunks the vector store offered before the relevance floor was applied.">
        {candidatesConsidered} considered
      </span>
      <span title="Cosine similarity below this is not shown. It is a request parameter, not a constant.">
        floor {minScore.toFixed(2)}
      </span>
      {embeddingModel === null ? null : <span className="font-mono">{embeddingModel}</span>}
      {fetching ? <span>updating…</span> : null}
    </p>
  );
}

/**
 * Before anything has been asked.
 *
 * It is not blank, and it is not a fake "no results": the operator gets the one fact that decides
 * whether asking is worth their time. `configured === null` means the health read failed, and
 * that renders as silence rather than as an accusation — claiming "not configured" on a failed
 * probe would send someone to Settings to fix something that is not broken.
 */
function IdleRegion({
  configured,
  configurationPending,
}: {
  configured: boolean | null;
  configurationPending: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-6">
      {configured === false && !configurationPending ? (
        <div role="status">
          <p className="font-medium text-sm text-text">◌ Memory is not configured.</p>
          <p className="mt-2 max-w-2xl text-sm text-text-secondary leading-150">
            No embedding model is set, so nothing is being indexed and no query can be answered. Set
            one on Settings → Integrations → Qdrant.
          </p>
        </div>
      ) : (
        <div>
          <p className="text-sm text-text-secondary">
            Ask a question in prose. Memory is searched by meaning, not by keyword.
          </p>
          <p className="mt-2 max-w-2xl text-text-muted text-xs leading-150">
            Indexed sources: completed sessions, commits, ADRs, pull requests and Obsidian notes.
            Results are ranked by cosine similarity and anything below the relevance floor is
            withheld rather than shown as a weak match — “nothing relevant” is an answer here, not
            an empty list.
          </p>
        </div>
      )}
    </div>
  );
}
