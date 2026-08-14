import type { EventEnvelope } from '@mc/shared/types';
import { type QueryKey, queryKeys } from '../api/query-keys.js';
import { payloadString, sessionIdOfChannel } from './protocol.js';

/**
 * Event -> query invalidation, and channel -> query invalidation (TDS 05 §5.3, TDS 04 §14.7).
 *
 * The governing rule is F6.2: **events carry entity IDs, never entities.** So an event is
 * never written into the cache — it names what went stale and TanStack Query refetches the
 * canonical resource over REST. "REST owns state, WebSocket owns liveness."
 *
 * Two maps, two jobs:
 *
 *  - `queryKeysForEvent` runs on every relayed event during steady state.
 *  - `queryKeysForChannel` runs once per channel on reconnect, where no event is available
 *    because the missed ones are gone forever (F6.3: best-effort relay, **no replay**).
 *    It must therefore be *wider* than the per-event map — it is healing an unknown gap,
 *    not reacting to a known change.
 */

/**
 * The one event type that must NOT invalidate anything: streaming deltas are rendered
 * straight from `liveSessionStore` and land in the cache only when the turn commits via
 * `session.message.appended`. Invalidating per delta would issue a REST refetch per token.
 */
const EPHEMERAL_DELTA = 'session.message.delta_appended';

/** Query groups that go stale for any event on the cross-session `sessions` channel. */
function sessionsChannelKeys(): QueryKey[] {
  // §14.7: `/spend` is refetched with the sessions channel because a Session may have
  // completed inside the loss window, and a stale spend total is a confidently-wrong
  // number rather than a missing one.
  return [queryKeys.sessions.root(), queryKeys.spend()];
}

/**
 * Every query key an event invalidates. Empty means "this event changes no server state the
 * client caches" — the delta stream, and any event type this client does not know about yet
 * (Phase 3/4 `memory.*` / `agent.*` are ignored by design, TDS 05 §10).
 */
export function queryKeysForEvent(event: EventEnvelope): readonly QueryKey[] {
  const type = event.type as string;

  if (type === EPHEMERAL_DELTA) return [];

  const sessionId = payloadString(event, 'sessionId');

  switch (type) {
    case 'session.created':
      return sessionsChannelKeys();

    case 'session.state_changed':
    case 'session.started':
    case 'session.paused':
    case 'session.resumed':
    case 'session.archived':
    case 'session.observation_degraded':
      return sessionId === null
        ? sessionsChannelKeys()
        : [queryKeys.sessions.detail(sessionId), ...sessionsChannelKeys()];

    case 'session.completed':
    case 'session.failed':
      // Same as a state change, plus the timeline: the terminal transition is the entry an
      // operator diagnosing a failure looks for first.
      return sessionId === null
        ? sessionsChannelKeys()
        : [
            queryKeys.sessions.detail(sessionId),
            queryKeys.sessions.timeline(sessionId),
            ...sessionsChannelKeys(),
          ];

    case 'session.message.appended':
      return sessionId === null
        ? []
        : [queryKeys.sessions.messages(sessionId), queryKeys.sessions.detail(sessionId)];

    case 'repository.discovered':
    case 'repository.synced':
    case 'repository.sync_failed':
    case 'pull_request.opened':
    case 'pull_request.reviewed':
    case 'pull_request.merged':
    case 'pull_request.closed':
      return [
        queryKeys.repositories.root(),
        queryKeys.pullRequests.root(),
        queryKeys.projects.root(),
      ];

    case 'commit.recorded':
      return sessionId === null
        ? [queryKeys.repositories.root(), queryKeys.commits.root()]
        : [
            queryKeys.repositories.root(),
            queryKeys.commits.root(),
            queryKeys.sessions.commits(sessionId),
            queryKeys.sessions.files(sessionId),
          ];

    case 'setting.updated': {
      const category = payloadString(event, 'category');
      // A settings change can move service configuration, so health goes with it.
      return category === null
        ? [queryKeys.settings.root(), queryKeys.services.health()]
        : [queryKeys.settings.category(category), queryKeys.services.health()];
    }

    case 'audit.entry_recorded':
      return [queryKeys.auditLogEntries.root()];

    case 'sync.started':
    case 'sync.completed':
    case 'sync.failed':
    case 'sync.conflict_detected':
      return [queryKeys.syncRuns.root(), queryKeys.schedule()];

    case 'adr.created':
      return [queryKeys.adrs.root()];

    case 'adr.updated': {
      const adrId = payloadString(event, 'adrId');
      return adrId === null
        ? [queryKeys.adrs.root()]
        : [queryKeys.adrs.root(), queryKeys.adrs.detail(adrId)];
    }

    case 'notification.created':
    case 'notification.sent':
    case 'notification.failed':
      return [queryKeys.notifications.root()];

    /**
     * Phase 3 memory (§15.4, relayed on the `memory` channel).
     *
     * **Only the backfill read model.** The obvious move — invalidate `['memory-items']` — would
     * also invalidate every cached *search*, and a search is a POST that costs an embedding call
     * plus a vector query. `memory.item_stored` fires once per indexed source, so a backfill over
     * a few hundred sources would re-run the operator's query a few hundred times while they
     * read the first answer. The index state is what actually changed and it is what is refetched;
     * the Memory screen compares the two and offers to re-run the search rather than doing it
     * silently.
     */
    case 'memory.item_stored':
    case 'memory.item_deleted':
    case 'memory.reindexed':
      return [queryKeys.memoryItems.backfill()];

    /**
     * Phase 4 agents (§13.2's reserved names, relayed on the `agents` channel).
     *
     * The blunt prefix is right here where it was wrong for memory: an agent list is one cheap
     * `GET /agents` with no embedding call behind it, these events fire when a person presses
     * Save rather than hundreds of times during a backfill, and the Agent Builder is a form that
     * must not keep showing a stale baseline after another tab saved over it.
     *
     * The three `agent.execution_*` names are deliberately absent: nothing in the SPA renders an
     * execution, so invalidating on them would refetch a list to redraw nothing.
     */
    case 'agent.created':
    case 'agent.updated':
      return [queryKeys.agents.root()];

    /**
     * PRD §5.7 teams, on the same `agents` channel (TDS 04 §14.3).
     *
     * `agent_team.*` reaches `['agent-teams']` and **not** `['agents']`: an agent document does not
     * change when a team's roster does, and the agents group is what the Agent Builder measures its
     * dirty baseline against — refetching it on every team edit would move that baseline for no
     * reason.
     */
    case 'agent_team.created':
    case 'agent_team.updated':
    case 'agent_team.deleted':
      return [queryKeys.agentTeams.root()];

    /**
     * `agent.assigned` — "project P's available-agent set changed", one event per (team, project)
     * pair. It invalidates that Project's availability read **specifically**, because that is the
     * only thing it changes: the agents themselves are untouched, and the team document is covered
     * by the `agent_team.updated` that accompanies it.
     */
    case 'agent.assigned': {
      const projectId = payloadString(event, 'projectId');
      return projectId === null
        ? [queryKeys.agentTeams.root()]
        : [queryKeys.projects.availableAgents(projectId), queryKeys.agentTeams.root()];
    }

    default:
      return [];
  }
}

/**
 * Everything that must be refetched for one channel after a reconnect (TDS 04 §14.7,
 * TDS 05 §5.3). Wider than the per-event map on purpose: the client is healing a gap of
 * unknown content, so it re-reads the whole group rather than guessing what it missed.
 */
export function queryKeysForChannel(channel: string): readonly QueryKey[] {
  const sessionId = sessionIdOfChannel(channel);
  if (sessionId !== null) {
    return [
      queryKeys.sessions.detail(sessionId),
      queryKeys.sessions.messages(sessionId),
      queryKeys.sessions.timeline(sessionId),
      queryKeys.sessions.commits(sessionId),
      queryKeys.sessions.files(sessionId),
    ];
  }

  switch (channel) {
    case 'sessions':
      return sessionsChannelKeys();
    case 'repositories':
      return [
        queryKeys.repositories.root(),
        queryKeys.commits.root(),
        queryKeys.pullRequests.root(),
      ];
    case 'settings':
      return [queryKeys.settings.root(), queryKeys.services.health()];
    case 'audit':
      return [queryKeys.auditLogEntries.root()];
    case 'notifications':
      return [queryKeys.notifications.root()];
    case 'sync':
      return [queryKeys.syncRuns.root(), queryKeys.schedule()];
    case 'adrs':
      return [queryKeys.adrs.root()];
    /**
     * A reconnect healed an unknown gap, so the index state is re-read — but cached searches
     * are still left alone, for the reason above. The Memory screen surfaces the discrepancy.
     */
    case 'memory':
      return [queryKeys.memoryItems.backfill()];
    /**
     * Phase 4. This channel was "subscribable and silent" (§14.4) until the Agents screen
     * shipped; a reconnect now heals the whole agents group, because the gap is of unknown
     * content and an agent list is cheap to re-read.
     *
     * Teams ride the same channel, so the heal covers them too — plus every Project's availability
     * read, because an `agent.assigned` inside the loss window is exactly the kind of change that
     * leaves a launch picker leading with the wrong team. `['projects']` is the blunt instrument
     * here, and the right one: it is the only prefix that reaches every cached
     * `['projects', id, 'available-agents']` without enumerating the ids the client happens to hold.
     */
    case 'agents':
      return [queryKeys.agents.root(), queryKeys.agentTeams.root(), queryKeys.projects.root()];
    default:
      return [];
  }
}

/**
 * The always-refetch set on reconnect, regardless of which channels were subscribed
 * (TDS 05 §5.3: "…plus `['notifications']` and `['services','health']`").
 */
export function reconnectBaselineKeys(): readonly QueryKey[] {
  return [queryKeys.notifications.root(), queryKeys.services.health()];
}

/** De-duplicate a set of keys so one reconnect never issues the same refetch twice. */
export function dedupeQueryKeys(keys: readonly QueryKey[]): readonly QueryKey[] {
  const seen = new Map<string, QueryKey>();
  for (const key of keys) {
    seen.set(JSON.stringify(key), key);
  }
  return [...seen.values()];
}
