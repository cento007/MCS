import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ApiError, apiGet, endpoints, queryKeys } from '../../../lib/api/index.js';
import type { Draft } from '../../../lib/forms/dirty.js';
import { type PanelForm, usePanelForm } from '../form.js';
import type { IntegrationSlug, IntegrationsSettings, SecretFieldWrite } from '../types.js';

/**
 * One integration card's form, wired to the split read/write shape of TDS 04 §7.3.
 *
 * The API reads **all** integrations in one document (`GET /settings/integrations`) and writes
 * them **one at a time** (`PUT /settings/integrations/{integration}`). There is deliberately no
 * per-integration GET. So each card selects its slice out of the shared query — six observers,
 * one fetch — and merges its own masked answer back into that slice on save. Without the
 * merge, saving GitHub would replace the whole cache entry with a GitHub-shaped document and
 * blank the other five cards.
 */

const INTEGRATION_KEYS = {
  github: 'github',
  'claude-code': 'claudeCode',
  telegram: 'telegram',
  obsidian: 'obsidian',
  qdrant: 'qdrant',
  ollama: 'ollama',
} as const satisfies Record<IntegrationSlug, keyof IntegrationsSettings>;

export function useIntegrationSlice<TSlice>(
  slug: IntegrationSlug,
): UseQueryResult<TSlice, ApiError> {
  const field = INTEGRATION_KEYS[slug];
  return useQuery<IntegrationsSettings, ApiError, TSlice>({
    queryKey: queryKeys.settings.integrations(),
    queryFn: ({ signal }) =>
      apiGet<IntegrationsSettings>(endpoints.settings.integrations, { signal }),
    select: (document) => document[field] as TSlice,
    retry: false,
  });
}

export interface IntegrationFormOptions<TSlice> {
  readonly slug: IntegrationSlug;
  /** Breadcrumb for the guard modal — always `Integrations → ‹Name›`. */
  readonly label: string;
  readonly toDraft: (slice: TSlice) => Draft;
  readonly toBody: (input: {
    readonly draft: Draft;
    readonly secrets: Readonly<Record<string, SecretFieldWrite>>;
    readonly document: TSlice;
  }) => unknown;
}

export function useIntegrationForm<TSlice>(
  options: IntegrationFormOptions<TSlice>,
): PanelForm<TSlice> {
  const { slug, label, toDraft, toBody } = options;
  const query = useIntegrationSlice<TSlice>(slug);
  const queryClient = useQueryClient();
  const field = INTEGRATION_KEYS[slug];

  return usePanelForm<TSlice>({
    panelId: `integrations.${slug}`,
    label: `Integrations → ${label}`,
    path: endpoints.settings.integration(slug),
    queryKey: queryKeys.settings.integrations(),
    query,
    toDraft,
    toBody,
    applyResult: (_client, saved) => {
      queryClient.setQueryData<IntegrationsSettings>(
        queryKeys.settings.integrations(),
        (previous) => (previous === undefined ? previous : { ...previous, [field]: saved }),
      );
    },
  });
}

/** Trim to `null` — the API models "unset" as `null`, never as an empty string. */
export function nullableText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text.length === 0 ? null : text;
}

/** Drop blank rows before writing an ordered list — an empty path is not a configured path. */
export function cleanList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[])
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0)
    : [];
}

/** `''`/`NaN` from a half-typed number input becomes the documented fallback, never `NaN`. */
export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Same, but `null` is a *meaningful* value here: "no budget" is not "budget of zero" (§7.2). */
export function nullableNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
