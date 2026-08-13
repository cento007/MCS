import {
  type AgentPermissions,
  type AgentPermissionTemplate,
  agentPermissionsFromTemplate,
  DEFAULT_AGENT_PERMISSION_TEMPLATE,
  isAgentPermissionTemplate,
} from '@mc/shared/types';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type ApiError,
  apiGet,
  apiList,
  endpoints,
  type Project,
  queryKeys,
} from '../../lib/api/index.js';
import { type AgentListRead, type AgentView, readAgent, readAgentList } from './shape.js';

/**
 * The Agents read surface (TDS 04 §13.2).
 *
 * Three decisions worth stating:
 *
 *  - **`retry: false`.** The route may not exist on this Backend at all (§13.2 is a stub and the
 *    two apps ship separately), and retrying a 404 three times only delays the honest answer.
 *  - **The list is read as `unknown[]` and projected.** `readAgentList` is what decides which rows
 *    are renderable; a row missing an `id` is counted rather than crashing the screen. `AppShell`
 *    has no error boundary of its own — the nearest is on the `RequireAuth` parent — so one bad
 *    payload here would replace the entire authenticated area, not just this list.
 *  - **The scope filter is applied client-side; `includeArchived` is not.** `?scope=` is a
 *    declared parameter and would work, but filtering locally keeps one cached list behind every
 *    chip on an instance that holds tens of agents. `includeArchived` is different in kind: the
 *    Backend *excludes* archived agents by default, so no amount of local filtering can produce
 *    them — and archival is the only retirement there is (`apps/backend/src/agents/routes.ts`:
 *    there is no `DELETE`), which makes an unreachable archived agent an agent nobody can bring
 *    back. It therefore goes on the wire and is part of the query key.
 */

/** Generous: an agent definition changes when a person edits it, not on its own. */
const AGENTS_STALE_MS = 30_000;

export interface AgentsListQuery {
  readonly read: AgentListRead;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  /** True when the Backend does not serve `/agents` — a different fact from "no agents yet". */
  readonly unavailable: boolean;
  refetch(): void;
}

/**
 * True when the failure is "this route does not exist yet" rather than "the request failed".
 *
 * The same test Settings uses, for the same reason and with the same limits: a 404 on a
 * collection route in this codebase is unambiguous, because `GET /agents` takes no path
 * parameter that could itself be missing. 501 is accepted for a Backend that stubs it explicitly.
 */
export function isRouteMissing(error: unknown): boolean {
  const apiError = error as ApiError | null;
  if (apiError === null || apiError === undefined) return false;
  return apiError.status === 404 || apiError.status === 501;
}

export function useAgentsList(includeArchived = false): AgentsListQuery {
  const query = useQuery<readonly unknown[], ApiError>({
    queryKey: queryKeys.agents.list({ limit: 200, includeArchived }),
    retry: false,
    staleTime: AGENTS_STALE_MS,
    queryFn: async ({ signal }) => {
      const page = await apiList<unknown>(endpoints.agents.list, {
        // `buildUrl` drops `false` — it only skips `undefined`/`null`/`''` — so the parameter is
        // sent either way and the Backend's own default is never relied on implicitly.
        query: { limit: 200, includeArchived },
        signal,
      });
      return page.data;
    },
  });

  const read = useMemo(() => readAgentList(query.data ?? []), [query.data]);
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    read,
    isPending: query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    refetch: () => void query.refetch(),
  };
}

export interface AgentDetailQuery {
  readonly agent: AgentView | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly unavailable: boolean;
  /** The Backend answered, and the document was not a readable Agent. */
  readonly unreadable: boolean;
  refetch(): void;
}

export function useAgent(agentId: string | null): AgentDetailQuery {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.agents.detail(agentId ?? 'none'),
    enabled: agentId !== null,
    retry: false,
    staleTime: AGENTS_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.agents.detail(agentId as string), { signal }),
  });

  const agent = useMemo(
    () => (query.data === undefined ? null : readAgent(query.data)),
    [query.data],
  );
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    agent,
    isPending: agentId !== null && query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    unreadable: query.isSuccess && agent === null,
    refetch: () => void query.refetch(),
  };
}

/**
 * Projects, as a **narrow projection** rather than an import of the Projects slice.
 *
 * TDS 05 §2.1 forbids cross-feature imports, and the Agent Builder needs exactly two fields to
 * render a project picker. It writes to the shared `['projects','list',…]` slot, so opening the
 * builder warms the cache the Projects screen reads — the same trade `features/memory` makes.
 *
 * `archived: false` on purpose: scoping a new agent to an archived project is almost certainly a
 * mistake, and an archived project a *stored* agent points at is still named correctly by
 * `projectName` below, because that reads the row this query returned or falls back to the id.
 */
export function useAgentProjects(): UseQueryResult<readonly Project[], ApiError> {
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
 * A project's name for display, or an honest fallback.
 *
 * Never an empty cell and never a silent drop: an agent scoped to a project that is archived,
 * deleted or simply not in the first page still has to say *which* project, and the id tail is a
 * worse label than the name but a much better one than nothing.
 */
export function projectName(projects: readonly Project[], projectId: string | null): string | null {
  if (projectId === null) return null;
  const match = projects.find((project) => project.id === projectId);
  return match?.name ?? `project ${projectId.slice(-6)}`;
}

// ------------------------------------------------------------- the create form's starting point

/**
 * `settings.agents.defaultPermissionTemplate` — what `POST /agents` applies when the body names
 * no permissions.
 *
 * The create form seeds its switches from this, so what an operator sees before touching anything
 * is what they would get by not touching anything. Seeding a different value would make the form
 * and the API disagree about what "leave it alone" means, which is the quietest kind of wrong.
 *
 * Read defensively for two independent reasons: the `agents` settings category may not be served
 * yet, and a value outside `AGENT_PERMISSION_TEMPLATES` is not something to coerce. Both fall back
 * to `DEFAULT_AGENT_PERMISSION_TEMPLATE` — `read_only`, the same deny-biased constant the Backend
 * falls back to, imported rather than restated.
 */
export function readDefaultPermissionTemplate(document: unknown): AgentPermissionTemplate {
  if (typeof document !== 'object' || document === null) return DEFAULT_AGENT_PERMISSION_TEMPLATE;
  const value = (document as Record<string, unknown>)['defaultPermissionTemplate'];
  return isAgentPermissionTemplate(value) ? value : DEFAULT_AGENT_PERMISSION_TEMPLATE;
}

export interface DefaultPermissionsRead {
  readonly template: AgentPermissionTemplate;
  readonly permissions: AgentPermissions;
  /** True while the settings read is in flight — the create form waits rather than guessing. */
  readonly isPending: boolean;
  /** False when the setting could not be read and the shared default is standing in for it. */
  readonly fromSettings: boolean;
}

export function useDefaultAgentPermissions(): DefaultPermissionsRead {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.settings.category('agents'),
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) => apiGet<unknown>(endpoints.settings.category('agents'), { signal }),
  });

  const template = readDefaultPermissionTemplate(query.data);
  /**
   * Memoised on the **template**, not on the query result.
   *
   * `agentPermissionsFromTemplate` mints a fresh object every call, and the Builder's baseline is
   * a `useMemo` over it — so an unstable identity here would rebuild the create form's baseline on
   * every render, which is precisely the comparison the baseline exists to support. Stability
   * belongs at the producer; a suppression comment at the consumer would only hide it.
   */
  const permissions = useMemo(() => agentPermissionsFromTemplate(template), [template]);

  return {
    template,
    permissions,
    isPending: query.isPending,
    fromSettings: query.isSuccess,
  };
}
