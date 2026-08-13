import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ApiError, apiSend, endpoints, errorMessage, queryKeys } from '../../lib/api/index.js';
import { toast } from '../../stores/toast-store.js';

/**
 * Agent writes (TDS 04 §13.2, TDS 05 §11.3).
 *
 * **Never optimistic**, the same rule the Settings panels and the Session actions follow. The
 * Backend rejects several bodies this form can produce — a project-scoped agent whose project
 * does not exist, a duplicate name, a scope its enum does not admit — and painting the row as
 * saved before the answer arrived would show a state the server refused. The form stays dirty on
 * failure so nothing typed is lost.
 *
 * The response document is written straight into the detail slot rather than only invalidating
 * it: it is the new baseline the Builder measures dirtiness against, and a round trip between
 * "saved" and "the form knows what was saved" is a window in which every field reads as changed.
 */

export interface CreateAgentVariables {
  readonly body: Record<string, unknown>;
}

export function useCreateAgent(): UseMutationResult<unknown, ApiError, CreateAgentVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, CreateAgentVariables>({
    retry: false,
    mutationFn: ({ body }) => apiSend<unknown>('POST', endpoints.agents.list, { body }),
    onSuccess: (agent) => {
      const id = agentIdOf(agent);
      if (id !== null) queryClient.setQueryData(queryKeys.agents.detail(id), agent);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.root() });
      toast({ kind: 'success', message: 'Agent created' });
    },
    onError: (error) => reportFailure(error, 'Could not create the agent'),
  });
}

export interface UpdateAgentVariables {
  readonly agentId: string;
  readonly body: Record<string, unknown>;
}

export function useUpdateAgent(): UseMutationResult<unknown, ApiError, UpdateAgentVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, UpdateAgentVariables>({
    retry: false,
    mutationFn: ({ agentId, body }) =>
      apiSend<unknown>('PATCH', endpoints.agents.detail(agentId), { body }),
    onSuccess: (agent, variables) => {
      queryClient.setQueryData(queryKeys.agents.detail(variables.agentId), agent);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      toast({ kind: 'success', message: 'Agent saved' });
    },
    onError: (error) => reportFailure(error, 'Could not save the agent'),
  });
}

export function agentIdOf(agent: unknown): string | null {
  if (typeof agent !== 'object' || agent === null) return null;
  const id = (agent as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function reportFailure(error: ApiError, title: string): void {
  const detail = error.requestId === null ? error.code : `${error.code} · ${error.requestId}`;
  toast({ kind: 'danger', message: `${title}: ${errorMessage(error)}`, detail });
}
