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
  /**
   * Memory indexing — payload `{ kind: 'source' | 'backfill' | 'purge', … }` (PRD §6.3).
   *
   * A job name, not an event: the *outcomes* are `memory.item_stored` / `memory.item_deleted` /
   * `memory.reindexed`, the three names TDS 04 §15.4 reserved for Phase 3.
   *
   * **Produced and consumed by the Backend**, which is arbitration A16 applied rather than
   * worked around: the queue has exactly one consuming process. The Sync Worker was the
   * intuitive home — it already does the slow filesystem work — and it is the wrong one here
   * for three reasons. Retrieval runs in the Backend and must go through the *same*
   * `ensureCollection` stamp verification the writer used, so putting the writer elsewhere
   * means two verifications and two chances to disagree about which model the collection holds.
   * The Qdrant API key is decrypted through the Backend's `SecretVault`, which is where
   * `MC_ENCRYPTION_KEY` is already wired. And the work itself is a bounded HTTP call to
   * loopback — the same class of I/O the Backend already does for GitHub — not the vault churn
   * F2.2 wanted kept off the API path.
   *
   * One queue rather than one per job kind, with `concurrency: 1`: it makes every write to the
   * index serial by construction, so two jobs can never race on the same
   * `(source, chunk, model)` row. Backfill slices are bounded (`BACKFILL_BATCH_SIZE`) precisely
   * so an incremental index queued behind one waits seconds, not minutes.
   */
  MEMORY_INDEX: 'memory.index',
  /**
   * The memory retention tick — `settings.memory.retentionDays` (PRD §4.4 item 4, §6.1's
   * "Session Memory — temporary").
   *
   * Self-rescheduling like `github.poll`, `notification.schedule` and `obsidian.schedule`, and
   * for the same reason: a durable job survives a restart where a `setInterval` does not, and a
   * deterministic tick id makes re-priming after a restart a no-op rather than a second chain.
   *
   * A separate queue from `memory.index` on purpose. `memory.index` is `concurrency: 1` so that
   * every *write* to the index is serial, and putting a periodic delete on it would make the
   * tick wait behind a backfill slice — or, worse, make a backfill wait behind a tick that
   * cannot run because the runtime is down. They contend for nothing: retention deletes rows by
   * age and never writes a `(source, chunk, model)` row.
   *
   * A job name, not an event. The outcome is `memory.item_deleted`, which does carry an F6
   * envelope and is in the §15.4 catalog.
   */
  MEMORY_RETENTION: 'memory.retention',
  /**
   * Move a workflow run to its next step — payload `{ kind, runId, … }` (PRD §5.6).
   *
   * A job name, not an event: the *outcomes* are `agent.execution_started`,
   * `agent_workflow.run.completed` and friends, which do carry F6 envelopes and do appear in the
   * §15.2 catalog.
   *
   * **Produced and consumed by the Backend**, arbitration A16 applied exactly as `memory.index`
   * applies it: the trigger is a domain event on the in-process post-commit bus
   * (`session.completed` / `session.failed`), the work is enqueued to a queue with **one**
   * consuming process, and no queue has two consumers. The Backend is that process because the
   * work is "generate a context package, create a Session, launch it" — all three are Backend
   * services holding Backend state (the concurrency semaphore, the managed runtime registry), and
   * none of them is reachable from a worker.
   *
   * `concurrency: 1`, so two advances can never race to launch a second Session for one run.
   * The real guarantee is in the database (`ux_agent_workflow_run_steps_attempt` and
   * `ck_agent_workflow_runs_sessions_launched`); this only keeps the common case cheap.
   */
  AGENT_WORKFLOW_ADVANCE: 'agent_workflow.advance',
} as const);

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
