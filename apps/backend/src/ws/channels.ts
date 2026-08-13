import { type EventEnvelope, type EventType, isEphemeralEventType } from '@mc/shared';

/**
 * The channel registry and the event -> channel routing table (TDS 04 §14.3 and §15.2).
 *
 * This file IS the "filters to UI-relevant event types per channel" half of TDS 02 §2's
 * dumb-relay rule. It is a lookup table and nothing else: no I/O, no domain knowledge beyond
 * "which envelope field names the Session", and no default-allow — an event type absent from
 * the table below is relayed to nobody, so adding an event to the system does not silently
 * widen what the browser can observe.
 *
 * The per-event routing in §15.2 is authoritative where it is narrower than the prose in
 * §14.3. Concretely: `session.created` goes to `sessions` only, never to `session:{id}` —
 * nothing can be subscribed to a Session's channel before that Session exists.
 */

/** Static (non-parameterised) channels, TDS 04 §14.3. */
export const STATIC_CHANNELS = Object.freeze({
  sessions: 1,
  repositories: 1,
  settings: 1,
  audit: 1,
  notifications: 2,
  sync: 2,
  adrs: 2,
  /** §14.3, live in Phase 3: indexing outcomes and backfill-run progress. */
  memory: 3,
  /** §14.3, live in Phase 4: agent definition changes. Execution events are a later slice. */
  agents: 4,
} as const);

export type StaticChannel = keyof typeof STATIC_CHANNELS;

export const SESSION_CHANNEL_PREFIX = 'session:';

/** The one ephemeral event type (F6 / §15.2 row 10) — WS-only, never persisted, never queued. */
export const SESSION_DELTA_EVENT_TYPE = 'session.message.delta_appended' satisfies EventType;

/**
 * Events that fan out on the cross-session `sessions` channel — the dashboard/list feed
 * (§15.2 rows 1–8, 11). Message traffic is deliberately absent: §6.11.6 records the decision
 * not to widen this channel with per-message events.
 */
const SESSIONS_CHANNEL_EVENTS: readonly EventType[] = [
  'session.created',
  'session.state_changed',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.completed',
  'session.failed',
  'session.archived',
  'session.observation_degraded',
];

/**
 * Events that fan out on `session:{id}`, keyed off `payload.sessionId` (§15.2 rows 2–11).
 * `commit.recorded` is handled separately: it is a `repositories` event that ALSO reaches a
 * Session channel when its payload names one.
 */
const SESSION_SCOPED_EVENTS: readonly EventType[] = [
  'session.state_changed',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.completed',
  'session.failed',
  'session.archived',
  'session.message.appended',
  SESSION_DELTA_EVENT_TYPE,
  'session.observation_degraded',
];

/** Static channel per event type (§15.2 "WS channels" column). */
const STATIC_ROUTES: Readonly<Record<string, readonly StaticChannel[]>> = Object.freeze({
  'session.created': ['sessions'],
  'session.state_changed': ['sessions'],
  'session.started': ['sessions'],
  'session.paused': ['sessions'],
  'session.resumed': ['sessions'],
  'session.completed': ['sessions'],
  'session.failed': ['sessions'],
  'session.archived': ['sessions'],
  'session.observation_degraded': ['sessions'],
  'repository.discovered': ['repositories'],
  'repository.synced': ['repositories'],
  'repository.sync_failed': ['repositories'],
  'commit.recorded': ['repositories'],
  'pull_request.opened': ['repositories'],
  'pull_request.reviewed': ['repositories'],
  'pull_request.merged': ['repositories'],
  'pull_request.closed': ['repositories'],
  'setting.updated': ['settings'],
  'audit.entry_recorded': ['audit'],
  'sync.started': ['sync'],
  'sync.completed': ['sync'],
  'sync.failed': ['sync'],
  'sync.conflict_detected': ['sync'],
  'adr.created': ['adrs'],
  'adr.updated': ['adrs'],
  'notification.created': ['notifications'],
  'notification.sent': ['notifications'],
  'notification.failed': ['notifications'],
  // Phase 3 (§15.4's reserved names, now produced). The `memory` channel carries indexing
  // outcomes so a Memory UI can watch a backfill without polling; it is deliberately NOT
  // widened onto `sessions` or `adrs`, because indexing a Session is not a Session event and
  // a client watching the session list has no use for it.
  'memory.item_stored': ['memory'],
  'memory.item_deleted': ['memory'],
  'memory.reindexed': ['memory'],
  // Phase 4. Definition changes only: an agent's permissions decide what a *future* launch may
  // do, so a client holding an agent list needs to know they changed. Nothing routes onto
  // `sessions` — creating an agent is not a Session event.
  'agent.created': ['agents'],
  'agent.updated': ['agents'],
});

const SESSIONS_CHANNEL_SET: ReadonlySet<string> = new Set(SESSIONS_CHANNEL_EVENTS);
const SESSION_SCOPED_SET: ReadonlySet<string> = new Set(SESSION_SCOPED_EVENTS);

/**
 * Any UUID shape, not UUIDv7 specifically: `id` generation is F4.2's business and a channel
 * validator that knows the version would reject perfectly good ids the day a fixture uses a
 * v4. Shape validation exists here so a channel name can never reach a SQL parameter or a
 * `Map` key as arbitrary text.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedChannel =
  | { readonly kind: 'static'; readonly name: StaticChannel; readonly phase: number }
  | { readonly kind: 'session'; readonly name: string; readonly sessionId: string };

/** `null` for any name outside the §14.3 registry — the caller answers `VALIDATION_FAILED`. */
export function parseChannel(name: string): ParsedChannel | null {
  if (Object.hasOwn(STATIC_CHANNELS, name)) {
    const channel = name as StaticChannel;
    return { kind: 'static', name: channel, phase: STATIC_CHANNELS[channel] };
  }

  if (name.startsWith(SESSION_CHANNEL_PREFIX)) {
    const sessionId = name.slice(SESSION_CHANNEL_PREFIX.length);
    if (!UUID_PATTERN.test(sessionId)) return null;
    // Lower-cased so `session:ABC…` and `session:abc…` are one channel rather than two
    // half-populated ones.
    return {
      kind: 'session',
      name: `${SESSION_CHANNEL_PREFIX}${sessionId.toLowerCase()}`,
      sessionId: sessionId.toLowerCase(),
    };
  }

  return null;
}

export function sessionChannel(sessionId: string): string {
  return `${SESSION_CHANNEL_PREFIX}${sessionId.toLowerCase()}`;
}

/** A string field from an F6 payload, or `null`. Payloads carry ids and scalars only (F6.1). */
function payloadId(event: EventEnvelope, field: string): string | null {
  const value = event.payload[field];
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Every channel an envelope belongs on. The complete relay decision for one event — the hub
 * does no further filtering.
 */
export function channelsForEvent(event: EventEnvelope): readonly string[] {
  const channels: string[] = [];

  for (const channel of STATIC_ROUTES[event.type] ?? []) {
    channels.push(channel);
  }

  if (SESSION_SCOPED_SET.has(event.type) || event.type === 'commit.recorded') {
    const sessionId = payloadId(event, 'sessionId');
    if (sessionId !== null) channels.push(sessionChannel(sessionId));
  }

  return channels;
}

/** Exposed for the routing tests and for readability at the call sites in `hub.ts`. */
export function isSessionsChannelEvent(type: string): boolean {
  return SESSIONS_CHANNEL_SET.has(type);
}

/**
 * Ephemerality is a property of the EVENT TYPE (F6, `@mc/shared`), not of the relay — the hub
 * re-exports the predicate rather than keeping a second list, so "which events are never
 * persisted" has exactly one definition in the codebase.
 */
export function isEphemeral(event: EventEnvelope): boolean {
  return isEphemeralEventType(event.type);
}
