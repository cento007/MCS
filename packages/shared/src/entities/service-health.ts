/**
 * Service-health vocabulary (TDS 04 §7.5, derivation TDS 02 §7).
 *
 * **This lives in `@mc/shared` because it already drifted once.** The SPA declared
 * `'ok' | 'degraded' | 'down' | 'not_configured' | 'unknown'` against a Backend returning
 * `'healthy' | … | 'disabled'`, with no overlap on the two most common values — so a Services
 * panel written against it would have typechecked cleanly while rendering every healthy
 * service as unknown. Two independent declarations of one enum cannot disagree loudly; one
 * declaration makes the next mismatch a compile error, which is the whole point of F4.1's
 * "consume the vocabulary verbatim rather than inventing parallel names".
 *
 * The distinction that carries the most weight in the UI:
 *
 * - **`disabled`** — specified but not deployed. Qdrant and Ollama (Phase 3), and the
 *   Telegram/Sync workers until Phase 2 ships. **Not a failure**, and must never feed the
 *   Dashboard's Needs Attention widget: four permanent red rows on the most-visited page of
 *   a correct install is how an operator learns to stop reading the panel.
 * - **`down`** — it ran and stopped. Heartbeat rows are upserted and persist, so a worker
 *   that has *never* started has no row at all (`disabled`), while one that went silent
 *   leaves a row that ages through `degraded` into `down`. A real crash still reads as one.
 * - **`unknown`** — the *check* failed, not necessarily the service. For worker rows this
 *   means the heartbeat read itself failed, i.e. the database is the broken dependency;
 *   blaming the worker would attribute the outage to the wrong component.
 */

export const SERVICE_STATUSES = ['healthy', 'degraded', 'down', 'disabled', 'unknown'] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
