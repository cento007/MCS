import { describe, expect, it } from 'vitest';
import type { SessionEventRow, SessionRow, TranscriptTailStateRow } from './repository.js';
import { serializeObservation, serializeSession, serializeTimelineEntry } from './serialize.js';

/**
 * The DB -> API mapping, with TDS 03 §3.9's mapping table as the authority. Every case below is
 * a rule that is *not* a straight `snake_case` -> `camelCase` rename, which is exactly where a
 * hand-written serializer drifts.
 */

const BASE_ROW: SessionRow = {
  id: '018f6b2e-1111-7abc-8def-0123456789ab',
  projectId: '018f6b2e-2222-7abc-8def-0123456789ab',
  repositoryId: null,
  userId: '018f6b2e-3333-7abc-8def-0123456789ab',
  resumedFromSessionId: null,
  lineageKind: null,
  sessionType: 'managed',
  state: 'running',
  runtime: 'claude_code',
  runtimeSessionId: '2f1a09b7-c001-4d31-9e44-2f1a09b7c001',
  runtimeVersion: '2.0.14',
  model: 'claude-sonnet-4-5',
  machine: 'workstation',
  environment: 'windows-dev',
  branch: 'DEV',
  workingDir: 'D:\\Repos\\MCS',
  transcriptPath: null,
  title: null,
  notes: null,
  failureReason: null,
  totalCostUsd: '3.421500',
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 30,
  },
  numTurns: 4,
  durationMs: 91_400,
  durationApiMs: 41_000,
  startedAt: new Date('2026-08-12T14:00:00.000Z'),
  completedAt: null,
  archivedAt: null,
  createdAt: new Date('2026-08-12T13:59:00.000Z'),
  updatedAt: new Date('2026-08-12T14:01:00.000Z'),
  searchTsv: null,
} as unknown as SessionRow;

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({ ...BASE_ROW, ...overrides });

describe('serializeSession', () => {
  it('renders an unset title as the empty string (§6.1 wire representation)', () => {
    expect(serializeSession(row({ title: null }), null).title).toBe('');
    expect(serializeSession(row({ title: 'Refactor the queue' }), null).title).toBe(
      'Refactor the queue',
    );
  });

  it('rounds duration_ms to whole seconds on read, never on write (WS7 N3)', () => {
    expect(serializeSession(row({ durationMs: 91_400 }), null).durationSeconds).toBe(91);
    expect(serializeSession(row({ durationMs: 91_600 }), null).durationSeconds).toBe(92);
    expect(serializeSession(row({ durationMs: null }), null).durationSeconds).toBeNull();
  });

  it('splits one lineage FK into two API fields via the discriminator (A6)', () => {
    const parent = '018f6b2e-9999-7abc-8def-0123456789ab';

    const resumed = serializeSession(
      row({ resumedFromSessionId: parent, lineageKind: 'resumed' }),
      null,
    );
    expect(resumed.resumedFromSessionId).toBe(parent);
    expect(resumed.clonedFromSessionId).toBeNull();

    const cloned = serializeSession(
      row({ resumedFromSessionId: parent, lineageKind: 'cloned' }),
      null,
    );
    expect(cloned.clonedFromSessionId).toBe(parent);
    expect(cloned.resumedFromSessionId).toBeNull();

    const root = serializeSession(row(), null);
    expect(root.resumedFromSessionId).toBeNull();
    expect(root.clonedFromSessionId).toBeNull();
  });

  it('projects the usage JSONB onto the four exposed counters', () => {
    expect(serializeSession(row(), null).tokenUsage).toEqual({
      input: 120,
      output: 45,
      cacheRead: 900,
      cacheWrite: 30,
    });
    expect(serializeSession(row({ usage: null }), null).tokenUsage).toBeNull();
  });

  it('renders numeric cost as a JSON number', () => {
    expect(serializeSession(row(), null).costUsd).toBe(3.4215);
    expect(serializeSession(row({ totalCostUsd: null }), null).costUsd).toBeNull();
  });

  it('serializes every timestamp as ISO 8601 UTC with a Z suffix (F4.2)', () => {
    const resource = serializeSession(row(), null);
    expect(resource.createdAt).toBe('2026-08-12T13:59:00.000Z');
    expect(resource.startedAt).toBe('2026-08-12T14:00:00.000Z');
    expect(resource.completedAt).toBeNull();
    expect(resource.archivedAt).toBeNull();
  });
});

describe('serializeObservation (§6.9)', () => {
  const tailState = (overrides: Partial<TranscriptTailStateRow> = {}): TranscriptTailStateRow =>
    ({
      id: 'x',
      sessionId: BASE_ROW.id,
      transcriptPath: '/home/me/.claude/projects/x/y.jsonl',
      byteOffset: 100,
      lineNo: 4,
      driftCount: 0,
      degraded: false,
      lastReadAt: null,
      lastError: null,
      createdAt: new Date('2026-08-12T13:59:00.000Z'),
      updatedAt: new Date('2026-08-12T14:02:00.000Z'),
      ...overrides,
    }) as unknown as TranscriptTailStateRow;

  it('is null for a managed Session', () => {
    expect(serializeObservation(row({ sessionType: 'managed' }), null)).toBeNull();
  });

  it('reports both channels attached when the tailer is healthy', () => {
    const observation = serializeObservation(row({ sessionType: 'observed' }), tailState());
    expect(observation).toEqual({
      channel: 'hooks_and_transcript',
      degraded: false,
      reason: null,
      driftCount: 0,
      updatedAt: '2026-08-12T14:02:00.000Z',
    });
  });

  it('reports hooks-only once the tailer has detached, with the drift it counted', () => {
    const observation = serializeObservation(
      row({ sessionType: 'observed' }),
      tailState({ degraded: true, driftCount: 12, lastError: 'unknown line type' }),
    );

    expect(observation?.channel).toBe('hooks_only');
    expect(observation?.degraded).toBe(true);
    expect(observation?.driftCount).toBe(12);
    expect(observation?.reason).toBe('unknown line type');
  });

  it('reports hooks-only for an observed Session with no tail state at all', () => {
    const observation = serializeObservation(row({ sessionType: 'observed' }), null);
    expect(observation?.channel).toBe('hooks_only');
    expect(observation?.degraded).toBe(false);
  });
});

describe('serializeTimelineEntry — §6.7 kind is a projection of the F6 name', () => {
  const timelineRow = (overrides: Partial<SessionEventRow>): SessionEventRow =>
    ({
      id: '018f6b2e-4444-7abc-8def-0123456789ab',
      sessionId: BASE_ROW.id,
      type: 'session.state_changed',
      fromState: 'created',
      toState: 'running',
      trigger: 'user',
      payload: null,
      correlationId: null,
      occurredAt: new Date('2026-08-12T14:00:00.000Z'),
      createdAt: new Date('2026-08-12T14:00:00.000Z'),
      updatedAt: new Date('2026-08-12T14:00:00.000Z'),
      ...overrides,
    }) as unknown as SessionEventRow;

  it('maps state changes and carries the states through', () => {
    const entry = serializeTimelineEntry(timelineRow({}));
    expect(entry.kind).toBe('state_changed');
    expect(entry.type).toBe('session.state_changed');
    expect(entry.fromState).toBe('created');
    expect(entry.toState).toBe('running');
  });

  it('splits session.message.appended by role, as the projection table requires', () => {
    expect(
      serializeTimelineEntry(
        timelineRow({ type: 'session.message.appended', payload: { role: 'user' } }),
      ).kind,
    ).toBe('prompt_submitted');

    expect(
      serializeTimelineEntry(
        timelineRow({ type: 'session.message.appended', payload: { role: 'tool' } }),
      ).kind,
    ).toBe('tool_used');

    expect(
      serializeTimelineEntry(
        timelineRow({ type: 'session.message.appended', payload: { role: 'assistant' } }),
      ).kind,
    ).toBe('other');
  });

  it('maps commit and observation events, and falls back to `other`', () => {
    expect(serializeTimelineEntry(timelineRow({ type: 'commit.recorded' })).kind).toBe(
      'commit_linked',
    );
    expect(serializeTimelineEntry(timelineRow({ type: 'session.observation_degraded' })).kind).toBe(
      'observation_changed',
    );
    // The forward-compatibility escape hatch: an unknown name renders from `type` + `detail`.
    expect(serializeTimelineEntry(timelineRow({ type: 'session.created' })).kind).toBe('other');
  });

  it('surfaces the failure reason as `detail`', () => {
    const entry = serializeTimelineEntry(
      timelineRow({ toState: 'failed', payload: { reason: 'backend_restart' } }),
    );
    expect(entry.detail).toBe('backend_restart');
  });
});
