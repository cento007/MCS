import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EventEnvelope, type PgBossQueue, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  seedProject,
  seedSession,
  seedUser,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../../test/integration/harness.js';
import { createEventBus, type EventBus, Outbox } from '../../events/index.js';
import { MessageService } from '../messages.js';
import { SessionStateMachine } from '../state-machine.js';
import { ObservedIngestService } from './ingest.js';
import { DbTailStateStore } from './tail-state.js';
import { TranscriptTailer } from './transcript-tailer.js';

/**
 * The tailer against a real database (TDS 07 §5.4's companion integration cases).
 *
 * The unit tier proves the cursor arithmetic and the degradation ladder through fake ports;
 * what needs a real PostgreSQL is the part the fakes cannot honestly imitate:
 *
 *   - `transcript_tail_states` surviving a "restart" — a second tailer over the same rows;
 *   - the degradation **transaction** — the sticky flag, the timeline row and
 *     `session.observation_degraded` all committing together, exactly once;
 *   - hook ingest continuing to append Messages for a degraded Session (hook-only fidelity).
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'claude',
  'transcripts',
);

let queue: PgBossQueue;
let bus: EventBus;
let outbox: Outbox;
let events: EventEnvelope[];
let store: DbTailStateStore;
let ingest: ObservedIngestService;
let sessionId: string;
let directory: string;
let transcriptPath: string;

function tailer(overrides: Partial<ConstructorParameters<typeof TranscriptTailer>[0]> = {}) {
  return new TranscriptTailer({ store, sink: ingest, watch: false, ...overrides });
}

async function tailState() {
  const rows = await testDatabase()
    .db.select()
    .from(schema.transcriptTailStates)
    .where(eq(schema.transcriptTailStates.sessionId, sessionId));
  return rows[0] ?? null;
}

async function messages() {
  return testDatabase()
    .db.select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(schema.messages.ordinal);
}

async function sessionRow() {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId));
  return rows[0] ?? null;
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  events = [];
  bus = createEventBus();
  bus.subscribeAll((event) => events.push(event));
  outbox = new Outbox({ db: testDatabase().db, queue, bus });

  store = new DbTailStateStore({ db: testDatabase().db, outbox });
  ingest = new ObservedIngestService({
    db: testDatabase().db,
    outbox,
    messages: new MessageService({ outbox }),
    stateMachine: new SessionStateMachine({ outbox }),
  });

  const user = await seedUser();
  const { projectId } = await seedProject();
  sessionId = await seedSession({
    projectId,
    userId: user.id,
    sessionType: 'observed',
    state: 'running',
    runtimeSessionId: '11111111-1111-4111-8111-111111111111',
  });

  directory = mkdtempSync(join(tmpdir(), 'mc-tail-int-'));
  transcriptPath = join(directory, 'session.jsonl');
});

describe('transcript ingest into real Messages', () => {
  it('appends every conversation turn through MessageService, with runtime uuids as the key', async () => {
    copyFileSync(join(FIXTURES, 'happy-session.jsonl'), transcriptPath);

    const tail = tailer();
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);
    await tail.stop();

    const rows = await messages();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(rows[0]?.runtimeMessageId).toBe('aaaaaaa1-0000-4000-8000-000000000001');
    // Ordinals are contiguous and assigned by the one writer (TDS 03 §3.11).
    expect(rows.map((row) => Number(row.ordinal))).toEqual([0, 1, 2, 3, 4]);
    // The tool turn carries the path the §6.10.2 Files panel reads.
    expect(rows[2]?.toolFilePath).toBe('/home/op/proj/src/router.ts');
    // A13: the first user Message named the Session.
    expect((await sessionRow())?.title).toBe('Add a health endpoint to the backend');
  });

  it('re-reading the same file appends nothing — the dedupe key holds across bursts', async () => {
    copyFileSync(join(FIXTURES, 'happy-session.jsonl'), transcriptPath);

    const tail = tailer();
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);

    // Force a full re-read the way a replaced file would (TDS 03 §3.15's "idempotency via
    // ux_messages_session_runtime_id would absorb a full re-read").
    await store.advance(sessionId, { byteOffset: 0, lineNo: 0, driftCount: 0 });
    await tail.drain(sessionId);
    await tail.stop();

    expect(await messages()).toHaveLength(5);
  });
});

describe('restart resume (TDS 03 §3.15)', () => {
  it('a second tailer reattaches at the persisted offset and ingests only what is new', async () => {
    copyFileSync(join(FIXTURES, 'happy-session.jsonl'), transcriptPath);

    const first = tailer();
    await first.attach({ sessionId, transcriptPath });
    await first.drain(sessionId);
    await first.stop();

    const persisted = await tailState();
    expect(Number(persisted?.byteOffset)).toBeGreaterThan(0);
    expect(Number(persisted?.lineNo)).toBe(6);
    expect(persisted?.lastReadAt).toBeInstanceOf(Date);
    expect(await messages()).toHaveLength(5);

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'after the restart' },
        uuid: 'aaaaaaa1-0000-4000-8000-000000000099',
      })}\n`,
    );

    const second = tailer();
    expect(await second.resume()).toBe(1);
    await second.drain(sessionId);
    await second.stop();

    const rows = await messages();
    expect(rows).toHaveLength(6);
    expect(rows[5]?.content).toBe('after the restart');
    expect(Number((await tailState())?.byteOffset)).toBeGreaterThan(Number(persisted?.byteOffset));
  });

  it('does not reattach a Session that is no longer running', async () => {
    copyFileSync(join(FIXTURES, 'happy-session.jsonl'), transcriptPath);
    await store.attach({ sessionId, transcriptPath });

    await testDatabase()
      .db.update(schema.sessions)
      .set({ state: 'completed' })
      .where(eq(schema.sessions.id, sessionId));

    const tail = tailer();
    expect(await tail.resume()).toBe(0);
    await tail.stop();
  });
});

describe('degradation is terminal and exactly once (§6.9 / arbitration A11)', () => {
  beforeEach(() => {
    copyFileSync(join(FIXTURES, 'forward-compatibility.jsonl'), transcriptPath);
  });

  it('persists the flag, writes the timeline row and emits the event — once', async () => {
    const tail = tailer({ driftThreshold: 3 });
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);
    await tail.stop();

    const state = await tailState();
    expect(state?.degraded).toBe(true);
    expect(state?.driftCount).toBe(4);
    expect(state?.lastError).toContain('drift');

    // Assert the exact type string: WS7 caught this drifting to `sync.failed`, which belongs to
    // Obsidian sync runs and whose `syncRunId` payload is meaningless here.
    const emitted = events.filter((event) => event.type === 'session.observation_degraded');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      sessionId,
      driftCount: 4,
      channel: 'hooks_only',
    });

    // …appended to the session timeline as `kind: 'observation_changed'` (§6.7).
    const timeline = await testDatabase()
      .db.select()
      .from(schema.sessionEvents)
      .where(eq(schema.sessionEvents.sessionId, sessionId));
    const row = timeline.filter((entry) => entry.type === 'session.observation_degraded');
    expect(row).toHaveLength(1);
    expect(row[0]?.trigger).toBe('system');

    // It is NOT an F7 transition: no state change, no `session.state_changed`.
    expect((await sessionRow())?.state).toBe('running');
    expect(events.filter((event) => event.type === 'session.state_changed')).toHaveLength(0);
  });

  it('ingests everything it could read before degrading — degrading is not discarding', async () => {
    const tail = tailer({ driftThreshold: 3 });
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);
    await tail.stop();

    expect((await messages()).map((row) => row.content)).toEqual([
      'Rename the queue module',
      'On it.',
      'Renamed it.',
    ]);
  });

  it('stays degraded across a restart and never emits a second event', async () => {
    const first = tailer({ driftThreshold: 3 });
    await first.attach({ sessionId, transcriptPath });
    await first.drain(sessionId);
    await first.stop();

    events.length = 0;

    // A11: no re-attach contract, so the boot sweep must not pick it back up…
    const second = tailer({ driftThreshold: 3 });
    expect(await second.resume()).toBe(0);
    // …and neither may a later hook carrying the same transcript path.
    expect(await second.attach({ sessionId, transcriptPath })).toBeNull();
    await second.stop();

    expect((await tailState())?.degraded).toBe(true);
    expect(events).toHaveLength(0);

    // There is deliberately no `session.observation_restored` in the catalog to emit.
    expect(events.some((event) => event.type.includes('restored'))).toBe(false);
  });

  it('reports the degraded fidelity to the Files panel as `partial` (§6.10.2)', async () => {
    const tail = tailer({ driftThreshold: 3 });
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);
    await tail.stop();

    const state = await tailState();
    expect(state?.degraded).toBe(true);
    // The panel's completeness is derived from this row; `sessions.int.test.ts` asserts the
    // endpoint's own rendering of it.
  });
});

describe('hook-only observation after degradation', () => {
  it('keeps ingesting tool and lifecycle events for a degraded Session', async () => {
    copyFileSync(join(FIXTURES, 'forward-compatibility.jsonl'), transcriptPath);

    const tail = tailer({ driftThreshold: 3 });
    ingest.setTailer(tail);
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);
    expect((await tailState())?.degraded).toBe(true);

    const before = (await messages()).length;

    // The second channel is unaffected: this is what "hooks only" means.
    await ingest.ingest({
      hookEventName: 'PostToolUse',
      runtimeSessionId: '11111111-1111-4111-8111-111111111111',
      transcriptPath,
      cwd: directory,
      occurredAt: null,
      payload: {
        tool_name: 'Write',
        tool_use_id: 'toolu_99',
        tool_input: { file_path: join(directory, 'notes.md') },
      },
    });

    await ingest.ingest({
      hookEventName: 'SessionEnd',
      runtimeSessionId: '11111111-1111-4111-8111-111111111111',
      transcriptPath,
      cwd: directory,
      occurredAt: null,
      payload: {},
    });

    const after = await messages();
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]).toMatchObject({ role: 'tool', toolName: 'Write' });

    // The lifecycle hook still drives F7, and the degradation never touched the state.
    expect((await sessionRow())?.state).toBe('completed');
    expect((await tailState())?.degraded).toBe(true);

    await tail.stop();
  });
});

describe('robustness against a real filesystem', () => {
  it('never throws and never degrades when the transcript is missing', async () => {
    const tail = tailer({ driftThreshold: 1 });
    await tail.attach({ sessionId, transcriptPath: join(directory, 'never-written.jsonl') });

    await expect(tail.drain(sessionId)).resolves.toBeNull();
    expect((await tailState())?.degraded).toBe(false);
    await tail.stop();
  });

  it('follows a moved transcript without losing the Session', async () => {
    writeFileSync(transcriptPath, readFileSync(join(FIXTURES, 'happy-session.jsonl')));
    const tail = tailer();
    await tail.attach({ sessionId, transcriptPath });
    await tail.drain(sessionId);

    const moved = join(directory, 'moved.jsonl');
    writeFileSync(
      moved,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'in the new file' },
        uuid: 'moved-1',
      })}\n`,
    );

    await tail.attach({ sessionId, transcriptPath: moved });
    await tail.drain(sessionId);
    await tail.stop();

    expect((await tailState())?.transcriptPath).toBe(moved);
    expect((await messages()).map((row) => row.content)).toContain('in the new file');
  });
});
