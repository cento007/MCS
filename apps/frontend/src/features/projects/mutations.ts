import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ApiError,
  apiSend,
  apiVoid,
  type DiscoveryReport,
  endpoints,
  errorMessage,
  type Project,
  queryKeys,
  type Repository,
  type SyncAccepted,
} from '../../lib/api/index.js';
import { toast } from '../../stores/toast-store.js';

/**
 * Project and Repository writes (TDS 04 §4/§5.1, TDS 05 §11.3).
 *
 * **Nothing here is optimistic.** §11.3's allow-list is narrow — notification read state and
 * pure client preferences — and none of these qualify: a rename can collide with
 * `ux_projects_workspace_name`, a workflow-mode change is audit-logged server-side, and a
 * repository registration is decided by a `git status` on the server. Every one of them awaits
 * the server and then invalidates.
 */

export interface CreateProjectVariables {
  readonly name: string;
  readonly description?: string | null;
  /** Omitted or `null` = inherit the global default (§4). */
  readonly workflowMode?: 'manual' | 'assisted' | null;
}

export function useCreateProject(): UseMutationResult<Project, ApiError, CreateProjectVariables> {
  const queryClient = useQueryClient();

  return useMutation<Project, ApiError, CreateProjectVariables>({
    mutationFn: (input) =>
      apiSend<Project>('POST', endpoints.projects.list, {
        body: {
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
        },
      }),
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.projects.detail(project.id), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.root() });
    },
    // No toast: the create modal renders the failure inline, next to the field that caused it.
  });
}

export interface ProjectPatch {
  readonly name?: string;
  readonly description?: string | null;
  /**
   * `null` **clears the override** and is therefore a meaningful value, not an omission — which
   * is why this whole patch type is applied with `'key' in patch` semantics at the call site
   * rather than by stripping undefined.
   */
  readonly workflowMode?: 'manual' | 'assisted' | null;
  readonly archivedAt?: string | null;
}

export function useUpdateProject(
  projectId: string,
): UseMutationResult<Project, ApiError, ProjectPatch> {
  const queryClient = useQueryClient();

  return useMutation<Project, ApiError, ProjectPatch>({
    mutationFn: (patch) =>
      apiSend<Project>('PATCH', endpoints.projects.detail(projectId), { body: patch }),
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.projects.detail(projectId), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.root() });
    },
    onError: (error) => report(error, 'Could not save the project'),
  });
}

export interface RegisterRepositoryVariables {
  /** Absolute native path on the **Mission Control host** (F8.1), verified server-side. */
  readonly localPath: string;
  readonly name?: string;
  readonly defaultBranch?: string;
  /** `null` registers the repository unassigned — the state discovery leaves it in. */
  readonly projectId: string | null;
}

/**
 * `POST /repositories` — register an existing working tree by local path.
 *
 * The route is flagged in the Backend as additive to TDS 04 §5.1 (which assumes every
 * Repository arrives through discovery), and it is the only way a Repository can exist in
 * Phase 1. Its failures are the interesting part: the server distinguishes path-missing,
 * not-a-directory and not-a-git-repository in `error.details.reason`, and `registration.ts`
 * maps each one to an instruction rather than to "Validation failed".
 */
export function useRegisterRepository(): UseMutationResult<
  Repository,
  ApiError,
  RegisterRepositoryVariables
> {
  const queryClient = useQueryClient();

  return useMutation<Repository, ApiError, RegisterRepositoryVariables>({
    mutationFn: (input) =>
      apiSend<Repository>('POST', endpoints.repositories.list, {
        body: {
          localPath: input.localPath,
          ...(input.name === undefined || input.name === '' ? {} : { name: input.name }),
          ...(input.defaultBranch === undefined || input.defaultBranch === ''
            ? {}
            : { defaultBranch: input.defaultBranch }),
          projectId: input.projectId,
        },
      }),
    onSuccess: (repository) => {
      queryClient.setQueryData(queryKeys.repositories.detail(repository.id), repository);
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.root() });
    },
    // No toast: the register dialog owns the error, because the recovery affordance (the path
    // field) is inside it.
  });
}

/**
 * `DELETE /repositories/{id}` — de-register. **Nothing on disk is touched**, which the confirm
 * dialog says out loud; the server refuses with `CONFLICT` while any Session references it,
 * because the FK would otherwise silently rewrite those Sessions' history.
 */
export function useRemoveRepository(): UseMutationResult<void, ApiError, { id: string }> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, { id: string }>({
    mutationFn: ({ id }) => apiVoid('DELETE', endpoints.repositories.detail(id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.root() });
    },
  });
}

/**
 * `PATCH /repositories/{id} { projectId }` — assign a Repository to a Project (§5.1).
 *
 * This is how a *discovered* Repository joins a Project: discovery registers rows with
 * `projectId: null` ("discovered, unassigned", TDS 03 §3.6), because it reads a working tree's
 * `origin` remote and has no way to know which Project an operator considers it part of.
 */
export function useAssignRepository(): UseMutationResult<
  Repository,
  ApiError,
  { id: string; projectId: string | null }
> {
  const queryClient = useQueryClient();

  return useMutation<Repository, ApiError, { id: string; projectId: string | null }>({
    mutationFn: ({ id, projectId }) =>
      apiSend<Repository>('PATCH', endpoints.repositories.detail(id), { body: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.root() });
    },
    onError: (error) => report(error, 'Could not attach the repository'),
  });
}

/**
 * `POST /repositories/{id}/sync` → `202 { jobId }`.
 *
 * The `202` is the whole interaction model: the answer is "queued", and the *outcome* arrives on
 * the `repositories` WebSocket channel as `repository.synced` / `repository.sync_failed`, which
 * `lib/ws/invalidation.ts` already maps onto `['repositories']`. So this mutation deliberately
 * does not wait for or invent a result — it reports that the work was accepted, and the row
 * updates itself when the work is done. There is no `GET /jobs/{id}` in the contract, so the
 * `jobId` is not something the client can poll, and pretending otherwise would be a spinner that
 * never ends.
 */
export function useSyncRepository(): UseMutationResult<SyncAccepted, ApiError, { id: string }> {
  const queryClient = useQueryClient();

  return useMutation<SyncAccepted, ApiError, { id: string }>({
    mutationFn: ({ id }) => apiSend<SyncAccepted>('POST', endpoints.repositories.sync(id)),
    onSuccess: () => {
      // The row already carries `syncStatus`; refetch so a queued sync that completes fast is
      // not waiting on an event the client might have missed while reconnecting (F6.3).
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.root() });
    },
  });
}

/**
 * `POST /repositories/discover` → `200 { report }`.
 *
 * Registers what it finds (with `projectId: null`) and returns a report of what it skipped and
 * why. Not a job: the Backend flags the departure from §5.1's `202 { jobId }` because the skip
 * reasons are the product and nothing persists them.
 */
export function useDiscoverRepositories(): UseMutationResult<DiscoveryReport, ApiError, void> {
  const queryClient = useQueryClient();

  return useMutation<DiscoveryReport, ApiError, void>({
    mutationFn: () => apiSend<DiscoveryReport>('POST', endpoints.repositories.discover),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.root() });
    },
  });
}

function report(error: ApiError, title: string): void {
  toast({
    kind: 'danger',
    message: `${title}: ${errorMessage(error)}`,
    detail: error.requestId === null ? error.code : `${error.code} · ${error.requestId}`,
  });
}
