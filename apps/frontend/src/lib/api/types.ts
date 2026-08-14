import type { ServiceStatus } from '@mc/shared/types';
import type { ApiErrorCode } from './errors.js';
import type {
  DiscoveredRepository,
  ErrorEnvelopeCode,
  JobAccepted,
  LaunchMeta,
  Session,
  WorkingTreeUnavailableReason,
} from './types.generated.js';

/**
 * API resource shapes — **generated, with a marked seam**.
 *
 * TDS 05 §2.1 always planned for these to be generated from WS2's OpenAPI 3.1 document. They now
 * are: `./types.generated.ts` is emitted by `pnpm api:spec` from the response schemas the Backend's
 * routes declare, and `pnpm api:spec:check` fails when it drifts — the same guard that keeps
 * `openapi.yaml` honest.
 *
 * **Why that mattered enough to do.** This file was hand-written against prose for three phases
 * and was wrong three times while typechecking cleanly: `ServiceHealthRow.status` read
 * `'ok' | … | 'not_configured'` against an API answering `'healthy' | 'disabled'`;
 * `Repository.lastSyncError` was missing entirely; and `Session.agentId` — served from Phase 4
 * slice 1 — never appeared here at all, so the entire agent runtime binding (system prompt,
 * `disallowedTools`) was **unreachable from the browser** until slice 2 noticed. A generated type
 * cannot have that defect: the field is in the schema or the Backend does not compile.
 *
 * ---
 *
 * ## The seam
 *
 * Everything below this header is what generation does **not** yet cover, and each entry says why.
 * Nothing else is hand-written: `export * from './types.generated.js'` is the rest of the surface.
 *
 * 1. **Services health and the schedule read model** (`ServiceHealth`, `ServiceHealthRow`,
 *    `ScheduleEntry`, `ScheduleKind`). `GET /services/health` and `GET /schedule` are the two
 *    operations whose routes still declare no response schema, so there is nothing to generate
 *    from. They are the last hand-written *shapes* in this file, and they are the ones with the
 *    worst track record — `ServiceHealthRow.status` is the field that was wrong. It is imported
 *    from `@mc/shared` rather than re-declared, which is what stopped the second occurrence.
 * 2. **`WORKING_TREE_UNAVAILABLE_REASONS`** is a runtime array, and the generator emits types
 *    only. It is asserted below to be exactly the generated union, so it cannot fall behind.
 * 3. **Three aliases** for names the generator derives differently from the Backend's own
 *    (`SyncAccepted`, `DiscoveredRepositoryEntry`, `SessionActionResult`). They are one line each
 *    and keep existing import sites working.
 */

export * from './types.generated.js';

// ------------------------------------------------------------------- 3. compatibility aliases

/**
 * `POST /repositories/{id}/sync` -> `202 { data: { jobId } }` (§5.1).
 *
 * The Backend shares one schema between this and `POST /sessions/{id}/generate-adr` — both hand
 * back a durable job whose outcome is observable on the resource it will change — so the generated
 * name is the general one.
 */
export type SyncAccepted = JobAccepted;

/** One registered repository in a discovery report. */
export type DiscoveredRepositoryEntry = DiscoveredRepository;

/**
 * `POST /sessions/{id}/start` and in-place `resume`: the envelope, not a resource.
 *
 * The generator emits `components.schemas`, and an envelope is a property of an *operation* rather
 * than a named component — so the composition is spelled out here. `meta` is optional because the
 * other lifecycle actions answer with the bare data envelope.
 */
export interface SessionActionResult {
  readonly data: Session;
  readonly meta?: LaunchMeta;
}

// ------------------------------------------------- the error registry, now a checked copy

/**
 * `lib/api/errors.ts` keeps its own `API_ERROR_CODES` array, and it is not redundant: it is a
 * *value*, it drives `FRIENDLY_MESSAGES`, and `ErrorCode` there is deliberately wider than the
 * server's registry because it also admits codes the client synthesises for failures that never
 * reached the Backend (`NETWORK_ERROR`, `ABORTED`).
 *
 * What it should never be is a copy that has quietly fallen behind — `error.code` used to be typed
 * in the OpenAPI document as the pattern `^[A-Z][A-Z0-9_]*$`, which described the *spelling* of a
 * code and said nothing about which codes exist, so this array had no way to be checked. It is now
 * an enum generated from `ERROR_CODES` itself, and this assertion holds the two together in both
 * directions.
 */
type _ErrorRegistryMatches = [Exclude<ErrorEnvelopeCode, ApiErrorCode>] extends [never]
  ? [Exclude<ApiErrorCode, ErrorEnvelopeCode>] extends [never]
    ? true
    : never
  : never;
const _errorRegistryMatches: _ErrorRegistryMatches = true;
void _errorRegistryMatches;

// ------------------------------------------------------- 2. a vocabulary needed at runtime

/**
 * Why a working tree could not be read, as a **value** — the generator emits types only, and the
 * Repositories view iterates these to render each one as *unverifiable*.
 *
 * The two assertions below make it exactly the generated union in both directions: a reason the
 * Backend adds and this array misses, or an array entry the Backend no longer serves, is a compile
 * error rather than a badge with no explanation.
 */
export const WORKING_TREE_UNAVAILABLE_REASONS = [
  'path_missing',
  'not_a_directory',
  'not_a_git_repository',
  'git_unavailable',
  'timed_out',
  'git_failed',
] as const satisfies readonly WorkingTreeUnavailableReason[];

type _NoReasonMissing =
  Exclude<
    WorkingTreeUnavailableReason,
    (typeof WORKING_TREE_UNAVAILABLE_REASONS)[number]
  > extends never
    ? true
    : never;
const _reasonsAreExhaustive: _NoReasonMissing = true;
void _reasonsAreExhaustive;

// -------------------------------------------------- 1. service health (§7.5) — not generated

/**
 * Re-exported from `@mc/shared`, not re-declared. This file previously carried its own copy
 * reading `'ok' | … | 'not_configured'` — no overlap with the API on the two most common values —
 * so a Services panel written against it typechecked cleanly while rendering every healthy service
 * as unknown. One declaration makes the next mismatch a compile error.
 */
export type { ServiceStatus };

export interface ServiceHealthRow {
  readonly name: string;
  /** Display name from the server, e.g. `Queue (PostgreSQL)` — never derive it client-side. */
  readonly label: string;
  readonly status: ServiceStatus;
  readonly detail: string | null;
  readonly checkedAt: string;
  /** Probe-specific extras (latency, heartbeat age, queue depth). Shape varies by service. */
  readonly meta: Record<string, unknown> | null;
}

/** `GET /services/health` answers the read model, not a bare array (§7.5). */
export interface ServiceHealth {
  readonly services: readonly ServiceHealthRow[];
}

// ------------------------------------------------------ 1. schedule (§7.7) — not generated

/**
 * The computed schedule read model behind the Dashboard's "Upcoming Tasks" widget.
 *
 * **There is no Task entity and none is implied** (WS7 arbitration A1, TDS 06 §6.2 footnote).
 * Every value here is derived at read time from Settings plus last-run records; nothing is
 * persisted, no event exists, and the widget that renders it says so.
 */
export type ScheduleKind = 'obsidian_sync' | 'github_poll' | 'daily_report';

export interface ScheduleEntry {
  readonly kind: ScheduleKind;
  /** Display text from the server, e.g. `Obsidian vault sync`. */
  readonly label: string;
  readonly enabled: boolean;
  /**
   * `null` whenever the row is disabled or its interval is 0 — the row is still returned so the UI
   * can say *why* nothing is scheduled instead of hiding it (§7.7).
   */
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
}
