import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ApiError,
  type ApiTokenSummary,
  apiSend,
  apiVoid,
  endpoints,
  errorMessage,
  type QueryKey,
  queryKeys,
} from '../../lib/api/index.js';
import { toast } from '../../stores/toast-store.js';
import type { CreatedApiToken, IntegrationSlug, TestConnectionResult } from './types.js';

/**
 * Settings writes (TDS 04 §7.3, §7.4, §3.2–3.3; TDS 05 §7.2, §11.3).
 *
 * **Never optimistic.** §7.2: "the UI shows a 'Saved' confirmation with timestamp, no
 * optimistic write". The whole point of the write-only secret contract is that the operator's
 * only evidence a credential landed is the server's own answer; painting a masked field as
 * saved before the server said so would forge exactly that evidence.
 *
 * **A save is a full-category replace** (§7.3), not a patch. TDS 05 §7.2 describes "sending
 * only dirty fields", which is the one place these two documents disagree — and the API's
 * semantics have to win, because a partial body against a full replace would erase every field
 * the operator did not touch. Secrets are the documented exception (§7.1): omitted keeps,
 * `null` clears, a string sets. So the body is `{...persisted, ...dirty}` with secret keys
 * present only when replaced or cleared.
 */

export interface SaveSettingsVariables {
  /** The complete category (or integration) document, secrets per §7.1. */
  readonly body: unknown;
}

export interface SaveSettingsOptions<TDoc> {
  readonly path: string;
  readonly queryKey: QueryKey;
  /** Human name for the toast: "General settings saved". */
  readonly label: string;
  /**
   * Write the server's masked answer back into the cache.
   *
   * Overridable because the six Integrations cards each `PUT` their own sub-document
   * (`/settings/integrations/{integration}`) while all six *read* one combined document
   * (`GET /settings/integrations`, §7.3) — so their result has to be merged into a slice of
   * that entry rather than replacing it. Default: replace the whole entry.
   */
  readonly applyResult?: (client: ReturnType<typeof useQueryClient>, document: TDoc) => void;
  readonly onSaved?: (document: TDoc) => void;
}

export function useSaveSettings<TDoc>(
  options: SaveSettingsOptions<TDoc>,
): UseMutationResult<TDoc, ApiError, SaveSettingsVariables> {
  const queryClient = useQueryClient();

  return useMutation<TDoc, ApiError, SaveSettingsVariables>({
    mutationFn: ({ body }) => apiSend<TDoc>('PUT', options.path, { body }),
    onSuccess: (document) => {
      // The response is the masked document (§7.3), so it — not the request body — becomes the
      // new baseline. That is what makes a replaced secret come back as `{ isSet: true }` with
      // a fresh timestamp rather than as the string the operator typed.
      if (options.applyResult === undefined) {
        queryClient.setQueryData(options.queryKey, document);
      } else {
        options.applyResult(queryClient, document);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.services.health() });
      toast({ kind: 'success', message: `${options.label} saved` });
      options.onSaved?.(document);
    },
    onError: (error) => reportFailure(error, `Could not save ${options.label.toLowerCase()}`),
  });
}

/**
 * `POST /settings/integrations/{integration}/test-connection` (§7.4).
 *
 * A completed check is a **200 regardless of outcome** — an integration that rejects the stored
 * credential is data, not an API error — so `ok: false` arrives here as a success and only a
 * refused request (`INTEGRATION_NOT_CONFIGURED`, 409) rejects. The two are rendered
 * differently and must not be collapsed: "GitHub said no" and "Mission Control would not ask"
 * are different problems with different fixes.
 *
 * No toast: the result belongs beside the button that produced it, and §7.4 makes results
 * ephemeral client state that is discarded the moment the panel goes dirty again.
 */
export function useTestConnection(
  integration: IntegrationSlug,
): UseMutationResult<TestConnectionResult, ApiError, void> {
  return useMutation<TestConnectionResult, ApiError, void>({
    mutationFn: () =>
      apiSend<TestConnectionResult>('POST', endpoints.settings.testConnection(integration)),
    retry: false,
  });
}

// ------------------------------------------------------------------------ api tokens (§3.2)

export interface CreateTokenVariables {
  readonly name: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: string;
}

/**
 * `POST /auth/tokens` → 201 with the raw `token`.
 *
 * The value is returned to the caller and **never written to the query cache**: the cache is
 * long-lived, inspectable from devtools, and serialised by every cache-persistence tool anyone
 * might add later. It exists in one component's state for as long as its modal is open.
 */
export function useCreateApiToken(): UseMutationResult<
  CreatedApiToken,
  ApiError,
  CreateTokenVariables
> {
  const queryClient = useQueryClient();

  return useMutation<CreatedApiToken, ApiError, CreateTokenVariables>({
    mutationFn: (input) =>
      apiSend<CreatedApiToken>('POST', endpoints.auth.tokens, {
        body: {
          name: input.name,
          ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.tokens() });
    },
    onError: (error) => reportFailure(error, 'Could not create the token'),
  });
}

export function useRevokeApiToken(): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, string>({
    mutationFn: (tokenId) => apiVoid('DELETE', endpoints.auth.token(tokenId)),
    onSuccess: (_result, tokenId) => {
      // Drop the row immediately as well as refetching: a revoked credential that lingers in a
      // table for one refetch is the wrong thing to leave on screen.
      queryClient.setQueryData<readonly ApiTokenSummary[]>(queryKeys.auth.tokens(), (previous) =>
        previous === undefined ? previous : previous.filter((token) => token.id !== tokenId),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.tokens() });
      toast({ kind: 'success', message: 'Token revoked' });
    },
    onError: (error) => reportFailure(error, 'Could not revoke the token'),
  });
}

// ------------------------------------------------------------------------- password (§3.1)

export interface ChangePasswordVariables {
  readonly currentPassword: string;
  readonly newPassword: string;
}

/** `POST /auth/password` → 204. Its own action, never part of a panel's batched save. */
export function useChangePassword(): UseMutationResult<void, ApiError, ChangePasswordVariables> {
  return useMutation<void, ApiError, ChangePasswordVariables>({
    mutationFn: (input) => apiVoid('POST', endpoints.auth.password, { body: input }),
    onSuccess: () => {
      toast({ kind: 'success', message: 'Password updated' });
    },
  });
}

function reportFailure(error: ApiError, title: string): void {
  const detail = error.requestId === null ? error.code : `${error.code} · ${error.requestId}`;
  toast({ kind: 'danger', message: `${title}: ${errorMessage(error)}`, detail });
}
