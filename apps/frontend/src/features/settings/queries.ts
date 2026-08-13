import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import {
  type ApiError,
  type ApiTokenSummary,
  apiGet,
  apiList,
  endpoints,
  queryKeys,
} from '../../lib/api/index.js';
import type {
  GeneralSettings,
  IntegrationsSettings,
  NotificationsSettings,
  SecuritySettings,
} from './types.js';

/**
 * Settings reads (TDS 04 §7.3, TDS 05 §7.2).
 *
 * **The settings endpoints are not served yet.** `apps/backend` has a `settings/` module of
 * typed *readers* (`general.ts`, `security.ts`, `claude-code.ts`, `integrations.ts`) consumed
 * internally by the spend and schedule read models, but no HTTP routes: there is no
 * `GET /api/v1/settings`, no `PUT /api/v1/settings/{category}`, and no test-connection route.
 * WS2 §7.6's key registry (`packages/shared/src/settings/registry.ts`), which those routes are
 * meant to derive from, has not landed either.
 *
 * So every read here is written to the §7.3 contract and every panel asks
 * `isEndpointMissing(error)`. A missing route answers the F5.4 envelope with `NOT_FOUND`
 * (`registerHttpConventions` installs that handler), and the panel then renders its fields
 * **disabled with a note naming the exact route it needs** — rather than inventing a
 * client-side store, or seeding defaults that would look like persisted configuration and
 * would be silently wrong the moment the operator trusted them.
 */

/**
 * True when the failure is "this route does not exist yet" rather than "the request was
 * rejected".
 *
 * A 404 on a *known* category is unambiguous in this codebase: §7.3 reserves `NOT_FOUND` for
 * an unknown category name, and the panels only ever request the six names the contract
 * defines. So a 404 here means the route itself is absent. 501 is accepted too, for a Backend
 * that later chooses to stub the route explicitly.
 */
export function isEndpointMissing(error: unknown): boolean {
  const apiError = error as ApiError | null;
  if (apiError === null || apiError === undefined) return false;
  return apiError.status === 404 || apiError.status === 501;
}

export function useGeneralSettings(): UseQueryResult<GeneralSettings, ApiError> {
  return useQuery<GeneralSettings, ApiError>({
    queryKey: queryKeys.settings.category('general'),
    queryFn: ({ signal }) =>
      apiGet<GeneralSettings>(endpoints.settings.category('general'), { signal }),
    retry: false,
  });
}

export function useIntegrationsSettings(): UseQueryResult<IntegrationsSettings, ApiError> {
  return useQuery<IntegrationsSettings, ApiError>({
    queryKey: queryKeys.settings.integrations(),
    queryFn: ({ signal }) =>
      apiGet<IntegrationsSettings>(endpoints.settings.integrations, { signal }),
    retry: false,
  });
}

export function useNotificationsSettings(): UseQueryResult<NotificationsSettings, ApiError> {
  return useQuery<NotificationsSettings, ApiError>({
    queryKey: queryKeys.settings.category('notifications'),
    queryFn: ({ signal }) =>
      apiGet<NotificationsSettings>(endpoints.settings.category('notifications'), { signal }),
    retry: false,
  });
}

export function useSecuritySettings(): UseQueryResult<SecuritySettings, ApiError> {
  return useQuery<SecuritySettings, ApiError>({
    queryKey: queryKeys.settings.category('security'),
    queryFn: ({ signal }) =>
      apiGet<SecuritySettings>(endpoints.settings.category('security'), { signal }),
    retry: false,
  });
}

/**
 * `GET /auth/tokens` (§3.2) — **this one is real and served.**
 *
 * Cursor-paginated per F5.3, but a single-operator instance holds a handful of tokens, so the
 * first page at the maximum limit is the whole list; no "Load more" is offered because a
 * Settings table that paginates four rows is ceremony.
 */
export function useApiTokens(): UseQueryResult<readonly ApiTokenSummary[], ApiError> {
  return useQuery<readonly ApiTokenSummary[], ApiError>({
    queryKey: queryKeys.auth.tokens(),
    queryFn: async ({ signal }) => {
      const page = await apiList<ApiTokenSummary>(endpoints.auth.tokens, {
        query: { limit: 200 },
        signal,
      });
      return page.data;
    },
    retry: false,
  });
}
