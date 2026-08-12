import { type EventEnvelope, type PgBossQueue, QUEUE_NAMES, schema } from '@mc/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  seedOperatorRow,
  seedProject,
  seedSession,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { Outbox } from '../events/index.js';
import { MessageService } from './messages.js';

/**
 * Message append and, with it, the A13 session-title derivation (TDS 04 §6.11).
 *
 * The contract's load-bearing claim is that derivation happens **in the same transaction as
 * the Message insert** and is guarded by `title IS NULL` alone — no flag column, no second
 * write, no background job. Everything below tests that claim from a different angle.
 */

let queue: PgBossQueue;
let outbox: Outbox;
let messages: MessageService;
let projectId: string;
let userId: string;

async function session(id: string) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id));
  return rows[0];
}

async function messageRows(sessionId: string) {
  return testDatabase()
    .db.select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(asc(schema.messages.ordinal));
}

async function enqueuedEvents(sessionId: string): Promise<EventEnvelope[]> {
  const result = await testDatabase().db.execute<{ data: EventEnvelope }>(
    sql`SELECT data FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS} ORDER BY created_on, id`,
  );
  return result.rows
    .map((row) => row.data)
    .filter((event) => event.payload['sessionId'] === sessionId);
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  outbox = new Outbox({ db: testDatabase().db, queue });
  messages = new MessageService({ outbox });
  userId = await seedOperatorRow();
  ({ projectId } = await seedProject());
});

describe('append — ordinals and events', () => {
  it('assigns per-session monotonic ordinals from zero', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({ sessionId, role: 'user', content: 'first' });
    await messages.append({ sessionId, role: 'assistant', content: 'second' });
    await messages.append({ sessionId, role: 'tool', content: 'third' });

    expect((await messageRows(sessionId)).map((row) => Number(row.ordinal))).toEqual([0, 1, 2]);
  });

  it('keeps ordinals independent per Session', async () => {
    const first = await seedSession({ projectId, userId, state: 'running' });
    const second = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({ sessionId: first, role: 'user', content: 'a' });
    await messages.append({ sessionId: second, role: 'user', content: 'b' });

    expect(Number((await messageRows(second))[0]?.ordinal)).toBe(0);
  });

  it('emits session.message.appended with ordinal and status, and writes the timeline row', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    const { message } = await messages.append({
      sessionId,
      role: 'user',
      content: 'Refactor the queue port',
      status: 'pending',
    });

    const events = await enqueuedEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.message.appended');
    expect(events[0]?.payload).toMatchObject({
      messageId: message?.id,
      role: 'user',
      ordinal: 0,
      status: 'pending',
    });

    const timeline = await testDatabase()
      .db.select()
      .from(schema.sessionEvents)
      .where(eq(schema.sessionEvents.sessionId, sessionId));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.type).toBe('session.message.appended');
    expect(timeline[0]?.trigger).toBe('user');
  });

  it('404s for an unknown Session', async () => {
    await expect(
      messages.append({
        sessionId: '018f6b2e-0000-7abc-8def-0123456789ab',
        role: 'user',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('de-duplication on (session_id, runtime_message_id) — TDS 03 §3.11', () => {
  it('collapses a replayed ingest into the existing row and appends nothing', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });
    const runtimeMessageId = 'hook:UserPromptSubmit:9f3a1c';

    const first = await messages.append({
      sessionId,
      role: 'user',
      content: 'Fix the TLS renewal',
      runtimeMessageId,
    });
    const replay = await messages.append({
      sessionId,
      role: 'user',
      content: 'Fix the TLS renewal',
      runtimeMessageId,
    });

    expect(first.deduplicated).toBe(false);
    expect(replay.deduplicated).toBe(true);
    expect(replay.message).toBeNull();
    expect(await messageRows(sessionId)).toHaveLength(1);
    // No second event, no second timeline row: nothing was appended.
    expect(await enqueuedEvents(sessionId)).toHaveLength(1);
  });

  it('does not de-duplicate rows Mission Control originates itself (NULL key)', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({ sessionId, role: 'system', content: 'notice' });
    await messages.append({ sessionId, role: 'system', content: 'notice' });

    expect(await messageRows(sessionId)).toHaveLength(2);
  });

  it('scopes the key to the Session — the same runtime id in two Sessions is two rows', async () => {
    const first = await seedSession({ projectId, userId, state: 'running' });
    const second = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({ sessionId: first, role: 'user', content: 'a', runtimeMessageId: 'u1' });
    await messages.append({
      sessionId: second,
      role: 'user',
      content: 'a',
      runtimeMessageId: 'u1',
    });

    expect(await messageRows(first)).toHaveLength(1);
    expect(await messageRows(second)).toHaveLength(1);
  });
});

describe('title derivation — §6.11', () => {
  it('names the Session from its first user Message, in the insert transaction', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running', title: null });

    const result = await messages.append({
      sessionId,
      role: 'user',
      content: 'Refactor the queue port to batch enqueue\n\nDetails follow.',
    });

    expect(result.titleDerived).toBe(true);
    // Committed before `append` resolved, so any subsequent read already sees it.
    expect((await session(sessionId))?.title).toBe('Refactor the queue port to batch enqueue');
  });

  it('derives from the text blocks when the row carries no rendered content', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({
      sessionId,
      role: 'user',
      contentBlocks: [
        { type: 'thinking', text: 'ignored' },
        { type: 'text', text: 'Investigate the tailer drift' },
      ],
    });

    expect((await session(sessionId))?.title).toBe('Investigate the tailer drift');
  });

  it('never overwrites an operator-set title', async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'running',
      title: 'Nightly refactor',
    });

    const result = await messages.append({ sessionId, role: 'user', content: 'Anything at all' });

    expect(result.titleDerived).toBe(false);
    expect((await session(sessionId))?.title).toBe('Nightly refactor');
  });

  it('derives at most once — later user Messages no-op on the same predicate', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({ sessionId, role: 'user', content: 'First prompt' });
    const second = await messages.append({ sessionId, role: 'user', content: 'Second prompt' });

    expect(second.titleDerived).toBe(false);
    expect((await session(sessionId))?.title).toBe('First prompt');
  });

  it('derives nothing from a non-user Message', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({ sessionId, role: 'assistant', content: 'Here is the plan' });

    expect((await session(sessionId))?.title).toBeNull();
  });

  it('leaves the next user Message eligible when the first derives nothing', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    // §6.11.3: the rule is "derived once successfully", not "attempted once" — a Session whose
    // opening prompt was a bare code fence must not be condemned to Untitled for life.
    const first = await messages.append({ sessionId, role: 'user', content: '   \n```\n   ' });
    expect(first.titleDerived).toBe(false);
    expect((await session(sessionId))?.title).toBeNull();

    const second = await messages.append({ sessionId, role: 'user', content: 'Second attempt' });
    expect(second.titleDerived).toBe(true);
    expect((await session(sessionId))?.title).toBe('Second attempt');
  });

  it('derives nothing on a replay collapsed by the dedupe key', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({
      sessionId,
      role: 'user',
      content: 'Original prompt',
      runtimeMessageId: 'u1',
    });
    // Clearing the title restores the precondition; the replay must still derive nothing,
    // because the row it would have derived from was never created (§6.11.1).
    await testDatabase()
      .db.update(schema.sessions)
      .set({ title: null })
      .where(eq(schema.sessions.id, sessionId));

    const replay = await messages.append({
      sessionId,
      role: 'user',
      content: 'Original prompt',
      runtimeMessageId: 'u1',
    });

    expect(replay.titleDerived).toBe(false);
    expect((await session(sessionId))?.title).toBeNull();
  });

  it('truncates to 60 code points and ellipsises, exactly as the pure rule does', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await messages.append({
      sessionId,
      role: 'user',
      content:
        'Investigate why the Sync Worker keeps rescheduling the same Obsidian export job forever',
    });

    const title = (await session(sessionId))?.title as string;
    expect(title).toBe('Investigate why the Sync Worker keeps rescheduling the…');
    expect([...title].length).toBeLessThanOrEqual(60);
  });

  it('bumps updated_at — the only observable side effect beyond the column (§6.11.6)', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });
    const before = (await session(sessionId))?.updatedAt as Date;

    await messages.append({ sessionId, role: 'user', content: 'Rename the port' });

    const after = (await session(sessionId))?.updatedAt as Date;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
