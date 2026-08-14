/**
 * F6 — Event model: naming grammar and the Phase 1–2 type registry.
 *
 * Grammar (F6.1): `<domain>[.<sub-entity>].<verb-past>`, dot-separated lowercase snake_case.
 * The registry below is TDS 04 §15.2 verbatim — 30 durable types plus one ephemeral.
 * Payload SHAPES are owned by WS2 and land with the API contract implementation; what is
 * fixed here is the envelope and the type vocabulary, which every process must agree on.
 */

/** Which process produced the event (F6.2). */
export const EVENT_SOURCES = ['backend', 'telegram-worker', 'sync-worker'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** Phase 1 event types (TDS 04 §15.2, rows 1–22). */
export const PHASE_1_EVENT_TYPES = [
  'session.created',
  'session.state_changed',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.completed',
  'session.failed',
  'session.archived',
  'session.message.appended',
  'session.message.delta_appended',
  'session.observation_degraded',
  'repository.discovered',
  'repository.synced',
  'repository.sync_failed',
  'commit.recorded',
  'pull_request.opened',
  'pull_request.reviewed',
  'pull_request.merged',
  'pull_request.closed',
  'setting.updated',
  'audit.entry_recorded',
] as const;

/** Phase 2 event types (TDS 04 §15.2, rows 23–31). */
export const PHASE_2_EVENT_TYPES = [
  'sync.started',
  'sync.completed',
  'sync.failed',
  'sync.conflict_detected',
  'adr.created',
  'adr.updated',
  'notification.created',
  'notification.sent',
  'notification.failed',
] as const;

/**
 * Phase 3 event types — the three names TDS 04 §15.4 reserved, now produced.
 *
 * They graduate from `RESERVED_EVENT_TYPES.phase3` below (which keeps them listed, so the
 * reservation still reads as the record of where they came from) into the live registry,
 * because the memory indexer produces them and the WebSocket hub relays them on the reserved
 * `memory` channel. Payloads carry ids and counts only, per F6.2.
 *
 *   `memory.item_stored`  — one source's chunks were (re-)indexed
 *   `memory.item_deleted` — one source's chunks were removed (archive, delete, empty source)
 *   `memory.reindexed`    — a backfill or rebuild run reached a terminal state
 */
export const PHASE_3_EVENT_TYPES = [
  'memory.item_stored',
  'memory.item_deleted',
  'memory.reindexed',
] as const;

/**
 * Phase 4 event types — **three** of the six names TDS 04 §15.4 reserved, plus three the team
 * slice added.
 *
 *   `agent.created`      — an Agent was defined
 *   `agent.updated`      — its fields, permissions or archived state changed
 *   `agent.assigned`     — agents became available in a Project, because the team holding them
 *                          was assigned to it (or gained them while already assigned)
 *   `agent_team.created` — a team was defined
 *   `agent_team.updated` — its name, roster or project assignments changed
 *   `agent_team.deleted` — a team was deleted (teams are deleted, not archived — see
 *                          `db/schema/agent-teams.ts` for why that differs from agents)
 *
 * **`agent.assigned` graduates here** now that assignment exists. §13.2 reserved it alongside
 * `POST /agents/{id}/assignments`, i.e. as "an agent became available somewhere new"; that is
 * exactly what a team assignment does, so the reserved name is used for the fact it was reserved
 * for rather than a parallel one being invented. Its payload names the team and the project and
 * lists the agents that became available there — one event per (team, project) pair, not one per
 * agent, because the fact a consumer acts on is "project P's available-agent set changed".
 *
 * **`agent_team.*` is a new domain in the F6.1 grammar** (`<domain>[.<sub-entity>].<verb-past>`)
 * and is deliberately not spelled `agent.team.*`: the sub-entity form is for something owned by
 * its parent the way a Message is owned by a Session, and a team is not owned by an agent — it
 * contains agents. §15.4's reserved Phase-4 list predates the team design and reserved *agent*
 * names only, so these three are recorded as an addition in TDS 04 §13.2 rather than pretending
 * they were foreseen. They ride the reserved `agents` WebSocket channel (§14.3).
 *
 * The three `agent.execution_*` names stay in `RESERVED_EVENT_TYPES.phase4` below because nothing
 * produces them: `POST /agents/{id}/executions` is a later slice, and a workflow (PRD §5.6) is a
 * chain of executions, so neither exists yet. Listing an event name in the live registry makes it
 * subscribable and documentable — and a subscriber that waits forever for
 * `agent.execution_completed` is a worse outcome than a name that is honestly still reserved.
 */
export const PHASE_4_EVENT_TYPES = [
  'agent.created',
  'agent.updated',
  'agent.assigned',
  'agent_team.created',
  'agent_team.updated',
  'agent_team.deleted',
] as const;

export const EVENT_TYPES = [
  ...PHASE_1_EVENT_TYPES,
  ...PHASE_2_EVENT_TYPES,
  ...PHASE_3_EVENT_TYPES,
  ...PHASE_4_EVENT_TYPES,
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Ephemeral: relayed over the WebSocket to `session:{id}` subscribers only.
 * Never enqueued to the queue, never persisted (TDS 04 §14.5 / §15.2 row 10).
 */
export const EPHEMERAL_EVENT_TYPES: readonly EventType[] = Object.freeze([
  'session.message.delta_appended',
]);

export function isEphemeralEventType(type: EventType): boolean {
  return EPHEMERAL_EVENT_TYPES.includes(type);
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Reserved names for later phases (TDS 04 §15.4).
 *
 * > **Phase 4/5 — interface only.** Placeholder/extension point. Detailed design is out of
 * > TDS scope per the project-plan scope guard.
 *
 * The lists are kept whole after a name graduates into the live registry, so this stays the
 * record of where each one came from. `phase3` is entirely produced; of `phase4`, the three
 * `agent.*` names are live and the three `agent.execution_*` names are not. The three
 * `agent_team.*` types are absent here on purpose — they were never reserved, they were added
 * by the team slice, and back-filling them into a reservation list would erase that fact.
 */
export const RESERVED_EVENT_TYPES = Object.freeze({
  phase3: Object.freeze(['memory.item_stored', 'memory.item_deleted', 'memory.reindexed'] as const),
  phase4: Object.freeze([
    'agent.created',
    'agent.updated',
    'agent.assigned',
    'agent.execution_started',
    'agent.execution_completed',
    'agent.execution_failed',
  ] as const),
});
