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

export const EVENT_TYPES = [...PHASE_1_EVENT_TYPES, ...PHASE_2_EVENT_TYPES] as const;

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
 * > **Phase 3/4 — interface only.** Placeholder/extension point. Detailed design is out of
 * > TDS scope per the project-plan scope guard.
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
