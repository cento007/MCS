/**
 * Queue name constants (TDS 02 §2.1 — `queue` export owns them).
 *
 * A queue name is NOT an event type. `session.launch` is a job name that carries no F6
 * envelope (TDS 04 §15.2 note); domain events all travel on the `events` queue and are
 * routed by consumers on `envelope.type`.
 *
 * The Obsidian sync and export job names land with the Sync Worker; everything the Backend
 * and the Telegram Worker need is declared here.
 */
export const QUEUE_NAMES = Object.freeze({
  /** Every F6 domain event enqueued transactionally with its domain write (F6.3). */
  EVENTS: 'events',
  /** Durable managed-session launch requests when the concurrency pool is saturated (TDS 02 §4.3). */
  SESSION_LAUNCH: 'session.launch',
  /**
   * Rate-limited turns awaiting retry (TDS 02 §4.3). Also a job name, not an event: the Session
   * stays `running` throughout, so nothing in the F6 catalog describes it.
   */
  SESSION_PROMPT_RETRY: 'session.prompt.retry',
  /**
   * One repository's GitHub sync (TDS 04 §5.1's `POST /repositories/{id}/sync`). A job name,
   * not an event: the *outcome* is `repository.synced` / `repository.sync_failed`, which do
   * carry F6 envelopes and do appear in the §15.2 catalog.
   */
  REPOSITORY_SYNC: 'repository.sync',
  /**
   * The GitHub polling tick (`integrations.github.syncIntervalMinutes`, §7.2). Self-rescheduling
   * rather than driven by an in-process timer, so polling survives a Backend restart — which is
   * the whole reason it is a durable job and not a `setInterval`.
   */
  GITHUB_POLL: 'github.poll',
  /**
   * One Notification's Telegram delivery — TDS 02 §2.2's "notification-dispatch jobs".
   *
   * A job name, not an event: the *outcomes* are `notification.sent` / `notification.failed`,
   * which do carry F6 envelopes and do appear in the §15.2 catalog. It is a dedicated queue
   * rather than a route through `events` for one structural reason — pg-boss is a
   * **competing-consumer** substrate, so a worker that took its delivery trigger off the
   * shared `events` queue would also take (and drop) every event addressed to the Sync
   * Worker. See `docs/tds/04-api-contracts-and-events.md` §15.2 and the note in
   * `apps/backend/src/notifications/produce.ts`.
   *
   * The job id **is the Notification id** on first enqueue, so producing the same Notification
   * twice cannot create two deliveries (`ON CONFLICT (name, id) DO NOTHING`).
   */
  NOTIFICATION_DELIVER: 'notification.deliver',
  /**
   * The Telegram Worker's scheduler tick (TDS 02 §2.2: "owns the scheduled daily-report job").
   *
   * Self-rescheduling like `github.poll`, and for the same reason: a durable job survives a
   * restart where a `setInterval` does not. The tick re-reads `notifications.dailyReport` and
   * `general.timezone` every time, so changing either takes effect within one tick instead of
   * at the next fire.
   */
  NOTIFICATION_SCHEDULE: 'notification.schedule',
  /**
   * One Obsidian sync run — payload `{ syncRunId }` (TDS 04 §10).
   *
   * A job name, not an event: the *outcomes* are `sync.started` / `sync.completed` /
   * `sync.failed` / `sync.conflict_detected`, which do carry F6 envelopes and do appear in the
   * §15.2 catalog. Produced by the Backend (`POST /sync-runs`) and by the Sync Worker's own
   * scheduler tick; consumed only by the Sync Worker, which is the only process that writes to
   * the vault.
   *
   * Overlap is prevented by the database, not by the queue: `ux_sync_runs_active` admits one
   * non-terminal run per kind (TDS 03 §4.5), so a redelivered or duplicated job finds the run
   * already claimed and does nothing.
   */
  OBSIDIAN_SYNC: 'obsidian.sync',
  /**
   * The Sync Worker's scheduler tick (`integrations.obsidian.syncIntervalMinutes`, §7.2).
   *
   * Self-rescheduling like `github.poll` and `notification.schedule`, and for the same reason:
   * a durable job survives a restart where a `setInterval` does not. Worker-only — the Backend
   * never produces one.
   */
  OBSIDIAN_SCHEDULE: 'obsidian.schedule',
  /**
   * Draft an ADR from a Session — payload `{ sessionId }` (TDS 04 §9's
   * `POST /sessions/{id}/generate-adr`, which answers `202 { jobId }`).
   *
   * The job id **is** the id returned to the caller, so the operator's `jobId` names a real
   * row in `pgboss.job` rather than a token that means nothing.
   */
  ADR_GENERATE: 'adr.generate',
} as const);

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
