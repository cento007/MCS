import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ApiError,
  apiSend,
  apiVoid,
  endpoints,
  errorMessage,
  queryKeys,
} from '../../../lib/api/index.js';
import { toast } from '../../../stores/toast-store.js';

/**
 * AgentTeam writes (PRD §5.7, TDS 04 §13.2).
 *
 * **Never optimistic**, the same rule the Agent Builder and the Session actions follow — and with
 * an extra reason here: this is the first client written against `/agent-teams`, and the body it
 * sends may not be the one the Backend settled on. Painting a team as created before the server
 * answered would show a row that a `400` had refused, and the operator would have no idea which of
 * the two versions is true.
 *
 * Failures therefore surface with the `code` and the `requestId`, which on a contract this young is
 * the operator's only route from a red toast to the line in the Backend log that explains it.
 */

export interface CreateTeamVariables {
  readonly body: Record<string, unknown>;
}

export function useCreateAgentTeam(): UseMutationResult<unknown, ApiError, CreateTeamVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, CreateTeamVariables>({
    retry: false,
    mutationFn: ({ body }) => apiSend<unknown>('POST', endpoints.agentTeams.list, { body }),
    onSuccess: (team) => {
      const id = teamIdOf(team);
      if (id !== null) queryClient.setQueryData(queryKeys.agentTeams.detail(id), team);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentTeams.root() });
      toast({ kind: 'success', message: 'Team created' });
    },
    onError: (error) => reportFailure(error, 'Could not create the team'),
  });
}

export interface UpdateTeamVariables {
  readonly teamId: string;
  readonly body: Record<string, unknown>;
}

export function useUpdateAgentTeam(): UseMutationResult<unknown, ApiError, UpdateTeamVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, UpdateTeamVariables>({
    retry: false,
    mutationFn: ({ teamId, body }) =>
      apiSend<unknown>('PATCH', endpoints.agentTeams.detail(teamId), { body }),
    onSuccess: (team, variables) => {
      queryClient.setQueryData(queryKeys.agentTeams.detail(variables.teamId), team);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentTeams.list() });
      toast({ kind: 'success', message: 'Team saved' });
    },
    onError: (error) => reportFailure(error, 'Could not save the team'),
  });
}

/**
 * `DELETE /agent-teams/{id}` — `204`, or `409` while the team is still assigned to a project.
 *
 * Teams **are** deleted, unlike agents, and the Backend argues the asymmetry: an Agent is
 * referenced as history (`sessions.agent_id`, `audit_log_entries.actor_id`,
 * `memory_items.agent_id`) so erasing one would rewrite an append-only record, while a team is
 * referenced only by its own rows. Nothing about a past session changes when a team goes away.
 *
 * The `409` is not an error to paper over: it means the operator has to unassign the team's
 * projects first, which is a decision, not a retry.
 */
export function useDeleteAgentTeam(): UseMutationResult<void, ApiError, { teamId: string }> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, { teamId: string }>({
    retry: false,
    // `apiVoid`, not `apiSend`: a `204` has no envelope to unwrap, and `unwrapData` would raise
    // `MALFORMED_RESPONSE` on a delete that in fact succeeded.
    mutationFn: ({ teamId }) => apiVoid('DELETE', endpoints.agentTeams.detail(teamId)),
    onSuccess: (_result, variables) => {
      queryClient.removeQueries({ queryKey: queryKeys.agentTeams.detail(variables.teamId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentTeams.root() });
      toast({ kind: 'success', message: 'Team deleted' });
    },
    onError: (error) => reportFailure(error, 'Could not delete the team'),
  });
}

export function teamIdOf(team: unknown): string | null {
  if (typeof team !== 'object' || team === null) return null;
  const id = (team as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function reportFailure(error: ApiError, title: string): void {
  const detail = error.requestId === null ? error.code : `${error.code} · ${error.requestId}`;
  toast({ kind: 'danger', message: `${title}: ${errorMessage(error)}`, detail });
}
