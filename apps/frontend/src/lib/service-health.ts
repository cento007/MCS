import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import {
  type ApiError,
  apiGet,
  endpoints,
  queryKeys,
  type ServiceHealth,
  type ServiceHealthRow,
  type ServiceStatus,
} from './api/index.js';

/**
 * Service health — the one read model two screens share (TDS 05 §7.5, TDS 06 §5.2/§5.7.12).
 *
 * It lives in `lib/` rather than in a feature folder because it has two consumers that are
 * not allowed to import each other: the Dashboard's compact Services widget (plus its Needs
 * Attention rows) and the Settings → Services panel. One query key, one poll interval, one
 * status vocabulary — so the two surfaces cannot report different health for the same
 * instance.
 *
 * **Polled, never socket-driven, and that is deliberate** (TDS 06 §5.2): "health must remain
 * observable when the socket is the sick component". There is no `services:health` channel
 * (TDS 04 §14.3) and this module subscribes to nothing.
 */

/** TDS 06 §5.2/§5.7.12: the panel and its Dashboard variant both refresh on 10 s. */
export const SERVICE_HEALTH_POLL_MS = 10_000;

export interface ServiceStatusPresentation {
  /** The verbatim §7.5 status name — visible text and `aria-label`, never a synonym. */
  readonly label: ServiceStatus;
  /** Mandatory: colour is never the only channel (TDS 06 §2.1.6). */
  readonly glyph: string;
  readonly colorVar: string;
  /**
   * Whether this status belongs in the Dashboard's Needs Attention widget.
   *
   * **`disabled` is `false`, and that is the load-bearing case.** `disabled` means
   * *specified but not deployed* — Qdrant and Ollama today, and the Phase 2 workers until
   * they ship. Heartbeat rows are upserted and persist, so a worker that has never run has
   * no row at all (`disabled`), while one that ran and went silent leaves a row that ages
   * into `degraded` then `down`. Treating the first as a failure would put permanent red
   * rows in the panel — and permanent entries in Needs Attention — for an install behaving
   * exactly as designed, and a widget that always shows failures is one operators learn to
   * ignore.
   */
  readonly attention: boolean;
}

const PRESENTATION: Readonly<Record<ServiceStatus, ServiceStatusPresentation>> = Object.freeze({
  healthy: {
    label: 'healthy',
    glyph: '●',
    // Cyan, not the accent: the accent marks operator intent, never a system condition
    // (TDS 06 §2.1.4).
    colorVar: '--color-success',
    attention: false,
  },
  degraded: { label: 'degraded', glyph: '▲', colorVar: '--color-warning', attention: true },
  down: { label: 'down', glyph: '✕', colorVar: '--color-danger', attention: true },
  disabled: { label: 'disabled', glyph: '◌', colorVar: '--color-text-muted', attention: false },
  // §5.7.12 names no glyph for `unknown` — it predates the enum's fifth member. `?` is used
  // rather than borrowing `▲`, because "the probe could not answer" and "the service is
  // misbehaving" are different facts; the colour is `warning` because it still needs a look.
  //
  // **This line is the only definition of that glyph.** Both consumers reach it through
  // `serviceStatusPresentation`, and their tests assert against this table rather than
  // against a literal `?`, so a surface that starts hard-coding one fails immediately —
  // which is the failure that produced two independent `?` choices in the first place.
  unknown: { label: 'unknown', glyph: '?', colorVar: '--color-warning', attention: true },
});

export function serviceStatusPresentation(status: ServiceStatus): ServiceStatusPresentation {
  return PRESENTATION[status];
}

/**
 * The clause every `unknown` row carries, because `unknown` names a failed *check*, not a
 * failed service.
 *
 * The worker rows are the case that makes this load-bearing. WS1's probe returns `unknown`
 * when the heartbeat **read** threw — i.e. PostgreSQL is the broken dependency — and the row
 * it lands on is labelled "Telegram Worker". Rendering `Heartbeat unreadable: …` under that
 * label, with a warning glyph beside it, reads as an accusation against a worker that may be
 * running perfectly. The row cannot be moved (the operator did ask about that service) so the
 * detail line has to carry the attribution.
 */
export const UNKNOWN_STATUS_NOTE = 'the check failed, not necessarily the service';

/**
 * The detail text a surface should render for a row — the server's `detail`, except for
 * `unknown`, where it is qualified.
 *
 * Shared for the same reason `serviceStatusPresentation` is: the Dashboard strip (tooltip),
 * the Settings table (Detail column) and the Needs Attention row all state this, and three
 * copies of the qualification is three chances for one of them to keep blaming the worker.
 */
export function serviceDetailText(row: ServiceHealthRow): string | null {
  if (row.status !== 'unknown') return row.detail;
  const detail = row.detail?.trim() ?? '';
  return detail.length === 0
    ? `Status could not be determined — ${UNKNOWN_STATUS_NOTE}.`
    : `${detail} — ${UNKNOWN_STATUS_NOTE}.`;
}

/**
 * The rows a human has to do something about — `degraded`, `down`, `unknown`.
 *
 * Shared by the Services panel's summary line and the Needs Attention aggregation, so the
 * widget and the panel cannot disagree about what counts as a problem.
 */
export function attentionServices(rows: readonly ServiceHealthRow[]): readonly ServiceHealthRow[] {
  return rows.filter((row) => serviceStatusPresentation(row.status).attention);
}

/**
 * `GET /services/health`, polled while the consuming panel is visible.
 *
 * `refetchIntervalInBackground: false` per TDS 05 §7.5 — a dashboard left open on another
 * monitor should not keep probing PostgreSQL every ten seconds forever.
 */
export function useServiceHealth(): UseQueryResult<ServiceHealth, ApiError> {
  return useQuery<ServiceHealth, ApiError>({
    queryKey: queryKeys.services.health(),
    queryFn: ({ signal }) => apiGet<ServiceHealth>(endpoints.services.health, { signal }),
    refetchInterval: SERVICE_HEALTH_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: SERVICE_HEALTH_POLL_MS,
    retry: false,
  });
}
