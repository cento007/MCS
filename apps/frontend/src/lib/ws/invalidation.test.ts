import type { EventEnvelope } from '@mc/shared/types';
import { describe, expect, it } from 'vitest';
import {
  dedupeQueryKeys,
  queryKeysForChannel,
  queryKeysForEvent,
  reconnectBaselineKeys,
} from './invalidation.js';

/**
 * The §5.3 event table and the §14.7 reconnect refetch, asserted directly.
 *
 * These two maps are the entire reason the SPA can trust a WebSocket that offers no replay:
 * an event names what went stale, a channel names what an unknown gap might have staled.
 * Getting either wrong produces a screen that is silently out of date, which is the one
 * failure mode an operator console must not have.
 */

const SESSION_ID = '018f6b2e-1111-7abc-8def-0123456789ab';

function event(type: string, payload: Record<string, unknown> = {}): EventEnvelope {
  return {
    id: '018f6b30-4c2a-7d31-9e44-2f1a09b7c001',
    type,
    schemaVersion: 1,
    occurredAt: '2026-08-11T14:03:22.000Z',
    source: 'backend',
    correlationId: null,
    payload,
  } as unknown as EventEnvelope;
}

function keyStrings(keys: readonly (readonly unknown[])[]): string[] {
  return keys.map((key) => JSON.stringify(key));
}

describe('queryKeysForEvent', () => {
  it('invalidates the sessions list and spend for `session.created`', () => {
    expect(
      keyStrings(queryKeysForEvent(event('session.created', { sessionId: SESSION_ID }))),
    ).toEqual(['["sessions"]', '["spend"]']);
  });

  it('invalidates the specific Session AND the list for a state change', () => {
    const keys = keyStrings(
      queryKeysForEvent(event('session.state_changed', { sessionId: SESSION_ID })),
    );
    expect(keys).toContain(`["sessions","${SESSION_ID}"]`);
    expect(keys).toContain('["sessions"]');
  });

  it('adds the timeline for terminal transitions — the entry a failure diagnosis needs first', () => {
    const keys = keyStrings(queryKeysForEvent(event('session.failed', { sessionId: SESSION_ID })));
    expect(keys).toContain(`["sessions","${SESSION_ID}","timeline"]`);
  });

  it('invalidates messages for `session.message.appended`', () => {
    const keys = keyStrings(
      queryKeysForEvent(
        event('session.message.appended', { sessionId: SESSION_ID, messageId: 'm' }),
      ),
    );
    expect(keys).toContain(`["sessions","${SESSION_ID}","messages"]`);
  });

  it('invalidates NOTHING for a streaming delta', () => {
    // One REST refetch per token is the failure this rule exists to prevent (§6.2).
    expect(
      queryKeysForEvent(
        event('session.message.delta_appended', { sessionId: SESSION_ID, text: 'Refactoring the' }),
      ),
    ).toEqual([]);
  });

  it('scopes `setting.updated` to the changed category', () => {
    const keys = keyStrings(
      queryKeysForEvent(event('setting.updated', { category: 'integrations' })),
    );
    expect(keys).toContain('["settings","integrations"]');
    expect(keys).toContain('["services","health"]');
  });

  it('reaches the Session panels when a commit names a Session', () => {
    const keys = keyStrings(
      queryKeysForEvent(event('commit.recorded', { commitId: 'c', sessionId: SESSION_ID })),
    );
    expect(keys).toContain(`["sessions","${SESSION_ID}","commits"]`);
    expect(keys).toContain(`["sessions","${SESSION_ID}","files"]`);
  });

  it('refetches the agents group on an agent write', () => {
    // Phase 4 graduated `agent.created`/`agent.updated` from reserved to produced when the Agents
    // screen shipped. The blunt prefix is right here where it was wrong for memory: `GET /agents`
    // is one cheap read with no embedding call behind it, and these fire when a person presses
    // Save rather than hundreds of times inside a backfill.
    for (const type of ['agent.created', 'agent.updated']) {
      expect(keyStrings(queryKeysForEvent(event(type, {})))).toEqual(['["agents"]']);
    }
  });

  it('treats the three execution events as workflow step boundaries', () => {
    /**
     * These used to invalidate **nothing**, on the stated grounds that "nothing in the SPA renders
     * an execution". Slice 3 ended that: the workflow slice produces them for exactly the fact
     * §15.4 reserved them for — an Agent ran a task — which is one *step* of a run, and the run
     * screen renders every one of them.
     *
     * They reach the named run first, then the run group, then the Sessions group: a step boundary
     * *is* a Session reaching a terminal state, and the run screen shows each step's Session state
     * beside the run's own account of it.
     */
    expect(
      keyStrings(queryKeysForEvent(event('agent.execution_started', { runId: 'r1' }))),
    ).toEqual([
      '["agent-workflow-runs","r1"]',
      '["agent-workflow-runs"]',
      '["sessions"]',
      '["spend"]',
    ]);
    // Without a `runId` there is nothing to target, and the group is the honest fallback.
    expect(keyStrings(queryKeysForEvent(event('agent.execution_failed', {})))).toEqual([
      '["agent-workflow-runs"]',
      '["sessions"]',
      '["spend"]',
    ]);
  });

  it('separates a workflow definition write from a run moving', () => {
    // A definition changes when a person presses Save; a run changes on its own. Nesting the two
    // would refetch every definition on every step transition.
    for (const type of ['agent_workflow.created', 'agent_workflow.updated']) {
      expect(keyStrings(queryKeysForEvent(event(type, {})))).toEqual(['["agent-workflows"]']);
    }
    for (const type of [
      'agent_workflow.run.started',
      'agent_workflow.run.completed',
      'agent_workflow.run.halted',
      'agent_workflow.run.stopped',
    ]) {
      const keys = keyStrings(queryKeysForEvent(event(type, { runId: 'r1' })));
      expect(keys).toContain('["agent-workflow-runs","r1"]');
      expect(keys).not.toContain('["agent-workflows"]');
    }
  });

  it('lets a session ending reach the run it was a step of', () => {
    // The advance is driven by exactly these two events, and they arrive *before* the
    // `agent_workflow.run.*` that follows. Without this the run screen would keep showing the step
    // that just finished as running until the next event landed.
    for (const type of ['session.completed', 'session.failed']) {
      expect(keyStrings(queryKeysForEvent(event(type, { sessionId: SESSION_ID })))).toContain(
        '["agent-workflow-runs"]',
      );
    }
  });

  it('separates team writes from agent writes', () => {
    // `agent_team.*` must NOT reach `["agents"]`: an agent document does not change when a team's
    // roster does, and `["agents"]` is what the Agent Builder measures its dirty baseline against —
    // refetching it on every team edit would move that baseline for no reason.
    for (const type of ['agent_team.created', 'agent_team.updated', 'agent_team.deleted']) {
      expect(keyStrings(queryKeysForEvent(event(type, {})))).toEqual(['["agent-teams"]']);
    }
  });

  it('targets one Project’s availability read on `agent.assigned`', () => {
    // The reserved §15.4 name, produced for the first time by the team slice. The fact a consumer
    // acts on is "project P's available-agent set changed" — so the Project's own read model is
    // what goes stale, not every agent list in the cache.
    expect(keyStrings(queryKeysForEvent(event('agent.assigned', { projectId: 'p1' })))).toEqual([
      '["projects","p1","available-agents"]',
      '["agent-teams"]',
    ]);
    // Without the id there is nothing to target, and the team group is the honest fallback.
    expect(keyStrings(queryKeysForEvent(event('agent.assigned', {})))).toEqual(['["agent-teams"]']);
  });

  it('refetches the memory INDEX STATE on a memory event, and never a cached search', () => {
    // Phase 3 graduated `memory.*` from reserved to produced. The narrow target is deliberate:
    // a search is a POST costing an embedding call plus a vector query, and `memory.item_stored`
    // fires once per indexed source — so invalidating `["memory-items"]` root would re-run the
    // operator's query a few hundred times during a backfill, while they read the first answer.
    for (const type of ['memory.item_stored', 'memory.item_deleted', 'memory.reindexed']) {
      expect(keyStrings(queryKeysForEvent(event(type, {})))).toEqual([
        '["memory-items","backfill"]',
      ]);
    }
  });

  it('degrades gracefully when a payload lacks the id it should carry', () => {
    expect(queryKeysForEvent(event('session.message.appended', {}))).toEqual([]);
    expect(keyStrings(queryKeysForEvent(event('session.state_changed', {})))).toEqual([
      '["sessions"]',
      '["spend"]',
    ]);
  });
});

describe('queryKeysForChannel (reconnect gap healing)', () => {
  it('re-reads the whole Session group for a `session:{id}` channel', () => {
    const keys = keyStrings(queryKeysForChannel(`session:${SESSION_ID}`));
    expect(keys).toEqual([
      `["sessions","${SESSION_ID}"]`,
      `["sessions","${SESSION_ID}","messages"]`,
      `["sessions","${SESSION_ID}","timeline"]`,
      `["sessions","${SESSION_ID}","commits"]`,
      `["sessions","${SESSION_ID}","files"]`,
    ]);
  });

  it('is wider than the per-event map, because the gap contents are unknown', () => {
    const perEvent = queryKeysForEvent(event('session.state_changed', { sessionId: SESSION_ID }));
    const perChannel = queryKeysForChannel(`session:${SESSION_ID}`);
    expect(perChannel.length).toBeGreaterThan(perEvent.length);
  });

  it('heals the memory gap at the index state, and the agents gap at the whole group', () => {
    // Same narrowness as the per-event map, for the same reason: the reconnect is healing an
    // unknown gap in what is *indexed*, not re-asking a question the operator asked once.
    expect(keyStrings(queryKeysForChannel('memory'))).toEqual(['["memory-items","backfill"]']);
    // Agents is the opposite trade: the gap is cheap to close and a stale agent list is a list of
    // permissions that are no longer what it says they are. Teams and every Project's availability
    // read ride the same channel, so the heal covers them — an `agent.assigned` missed inside the
    // window is exactly what leaves a launch picker leading with the wrong team.
    // Workflows and runs ride the same channel from slice 3. A run is the one thing here that
    // moves on its own, so a gap of unknown content is exactly when its state is most likely stale.
    expect(keyStrings(queryKeysForChannel('agents'))).toEqual([
      '["agents"]',
      '["agent-teams"]',
      '["projects"]',
      '["agent-workflows"]',
      '["agent-workflow-runs"]',
    ]);
  });

  it('always refetches notifications and service health on reconnect', () => {
    expect(keyStrings(reconnectBaselineKeys())).toEqual([
      '["notifications"]',
      '["services","health"]',
    ]);
  });
});

describe('dedupeQueryKeys', () => {
  it('collapses identical keys so one reconnect issues one refetch each', () => {
    const keys = dedupeQueryKeys([
      ['sessions'],
      ['sessions'],
      ['sessions', SESSION_ID],
      ['notifications'],
    ]);
    expect(keyStrings(keys)).toEqual([
      '["sessions"]',
      `["sessions","${SESSION_ID}"]`,
      '["notifications"]',
    ]);
  });
});
