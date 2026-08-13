import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type ApiError,
  apiGet,
  apiList,
  apiSend,
  endpoints,
  type Project,
  queryKeys,
  type Session,
} from '../../lib/api/index.js';
import type {
  MemoryBackfillStatus,
  MemoryBackfillTrigger,
  MemoryRunMode,
  MemorySearchRequest,
  MemorySearchResponse,
} from './types.js';
import { isRunActive } from './types.js';

/**
 * The Memory read/write surface (TDS 04 §13.1).
 *
 * Three things here are decisions rather than defaults:
 *
 *  - **A search is a `useQuery`, not a `useMutation`,** even though it is a POST. It is a *read*
 *    keyed by its request: going back to a previous query, or returning to `/memory?q=…` from a
 *    result, must not re-embed prose that has already been embedded. `staleTime` is generous for
 *    the same reason — the index moves slowly and every refetch costs an embedding call plus a
 *    vector search while a person waits.
 *  - **`retry: false` everywhere.** The Backend already answers "Ollama is down" as a `200` with
 *    `emptyReason: 'unavailable'`, so a thrown error here is a genuine API failure, and retrying
 *    a 15-second-bounded embedding call three times turns a 15-second wait into 45.
 *  - **The index status polls only while a run is active.** A backfill emits `memory.item_stored`
 *    per source and `memory.reindexed` at the end, and the socket invalidates this slot for both
 *    — but relying on the socket alone would leave the panel frozen on an instance whose socket
 *    is degraded, which is exactly when an operator is watching it.
 */

/** The Backend clamps to 50; 10 is its default and the number a person can actually read. */
export const DEFAULT_MEMORY_SEARCH_LIMIT = 10;

/**
 * Long enough that navigating away and back does not re-embed; short enough that an operator who
 * has just run a backfill and re-submits the same prose gets a fresh answer.
 */
const SEARCH_STALE_MS = 60_000;

export function useMemorySearch(
  request: MemorySearchRequest | null,
): UseQueryResult<MemorySearchResponse, ApiError> {
  return useQuery<MemorySearchResponse, ApiError>({
    // `request` is the identity of the answer: the same prose under a different scope is a
    // different question. `?? {}` only ever feeds the disabled branch, whose key is never read.
    queryKey: queryKeys.memoryItems.search(request ?? {}),
    enabled: request !== null && request.q.length > 0,
    retry: false,
    staleTime: SEARCH_STALE_MS,
    // The previous answer stays on screen while a re-scoped one is in flight, so the results
    // region does not blink back to a skeleton on every filter chip.
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) =>
      apiSend<MemorySearchResponse>('POST', endpoints.memoryItems.search, {
        body: request,
        signal,
      }),
  });
}

export function useMemoryIndexStatus(): UseQueryResult<MemoryBackfillStatus, ApiError> {
  return useQuery<MemoryBackfillStatus, ApiError>({
    queryKey: queryKeys.memoryItems.backfill(),
    retry: false,
    staleTime: 5_000,
    refetchInterval: (query) => (isRunActive(query.state.data?.state ?? null) ? 3_000 : false),
    queryFn: ({ signal }) =>
      apiGet<MemoryBackfillStatus>(endpoints.memoryItems.backfill, { signal }),
  });
}

export interface TriggerBackfillInput {
  readonly mode: MemoryRunMode;
}

/**
 * `POST /memory-items/backfill` -> `202 { runId, state, mode, createdAt }`.
 *
 * Non-optimistic on purpose, the same rule §11.3 applies to Session actions: the Backend refuses
 * an `incremental` run under a stamp mismatch (`409`), refuses everything when memory is not
 * configured (`INTEGRATION_NOT_CONFIGURED`), and refuses a second concurrent run through a unique
 * index rather than a check. A UI that painted "running" before the answer would show three
 * states the Backend rejected.
 */
export function useTriggerBackfill(): UseMutationResult<
  MemoryBackfillTrigger,
  ApiError,
  TriggerBackfillInput
> {
  const queryClient = useQueryClient();

  return useMutation<MemoryBackfillTrigger, ApiError, TriggerBackfillInput>({
    retry: false,
    mutationFn: (input) =>
      apiSend<MemoryBackfillTrigger>('POST', endpoints.memoryItems.backfill, {
        body: { mode: input.mode },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryItems.backfill() });
    },
  });
}

// ------------------------------------------------------------------ scope labels (§2.1 narrow)

/**
 * Projects, read as a **narrow projection** rather than by importing the Projects slice.
 *
 * TDS 05 §2.1 forbids cross-feature imports, and this screen needs exactly two fields to render
 * a scope picker. It writes to the shared `['projects','list',…]` slot, so opening Memory warms
 * the cache the Projects screen reads and one `repository.discovered` invalidation reaches both.
 */
export function useScopeProjects(): UseQueryResult<readonly Project[], ApiError> {
  return useQuery<readonly Project[], ApiError>({
    queryKey: queryKeys.projects.list({ archived: false, limit: 200 }),
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const page = await apiList<Project>(endpoints.projects.list, {
        query: { archived: false, limit: 200 },
        signal,
      });
      return page.data;
    },
  });
}

/**
 * Is memory configured at all — asked *before* a query is typed.
 *
 * ⚠ **`GET /memory-items/backfill` cannot answer this**, which is a contract gap worth naming.
 * It reports `indexedModels` (from the `memory_items` table) and `rowsFromOtherModels`, so an
 * unconfigured instance and a configured-but-never-indexed one are byte-identical in that
 * document: both report no models and no run. The operator's next action is completely different.
 *
 * `GET /services/health` *can*: its `qdrant` and `ollama` rows come from the same
 * `readMemoryConfig` decision the search route uses, and carry `meta.configured` alongside a
 * `disabled` status when no embedding model is set. So this is read as a **narrow projection** of
 * the health read model, sharing the Dashboard's and the Services panel's cache slot rather than
 * adding a query — see `projects/queries.ts` for the same pattern against Settings.
 *
 * It returns `null` for "cannot tell", and every caller treats that as *not* an assertion: a
 * failed health read must never render as "memory is not configured", which would send an
 * operator to Settings to fix something that is not broken.
 */
export interface MemoryConfigurationRead {
  /** `true` / `false` when the health rows say so; `null` when they could not be read. */
  readonly configured: boolean | null;
  readonly isPending: boolean;
}

interface HealthProjection {
  readonly services: readonly {
    readonly name: string;
    readonly status: string;
    readonly meta: Record<string, unknown> | null;
  }[];
}

export function useMemoryConfiguration(): MemoryConfigurationRead {
  const query = useQuery<HealthProjection, ApiError>({
    queryKey: queryKeys.services.health(),
    retry: false,
    staleTime: 30_000,
    queryFn: ({ signal }) => apiGet<HealthProjection>(endpoints.services.health, { signal }),
  });

  const rows = query.data?.services ?? [];
  const qdrant = rows.find((row) => row.name === 'qdrant');
  const ollama = rows.find((row) => row.name === 'ollama');
  const configuredFlag = (row: (typeof rows)[number] | undefined): boolean | null =>
    row === undefined || typeof row.meta?.['configured'] !== 'boolean'
      ? null
      : (row.meta['configured'] as boolean);

  const flags = [configuredFlag(qdrant), configuredFlag(ollama)];

  return {
    // Either probe saying `configured: false` is the missing embedding model — the two rows are
    // driven by one config read, so they cannot honestly disagree.
    configured: flags.includes(false) ? false : flags.includes(true) ? true : null,
    isPending: query.isPending,
  };
}

/**
 * The Session behind a `?session=` scope, so the chip can name it.
 *
 * A session scope arrives by deep link (from a Session screen, or from a result), never from a
 * picker — an instance with 400 Sessions has no useful dropdown of them. When the read fails the
 * chip falls back to the id tail rather than dropping the scope, because a scope that silently
 * disappears is worse than one that is imperfectly labelled.
 */
export function useScopeSession(sessionId: string | null): UseQueryResult<Session, ApiError> {
  return useQuery<Session, ApiError>({
    queryKey: queryKeys.sessions.detail(sessionId ?? 'none'),
    enabled: sessionId !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      apiGet<Session>(endpoints.sessions.detail(sessionId as string), { signal }),
  });
}
