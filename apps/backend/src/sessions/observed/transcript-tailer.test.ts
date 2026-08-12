import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TailCursorAdvance,
  TailState,
  TailStateStore,
  TranscriptRecord,
  TranscriptSink,
} from './ports.js';
import { TranscriptTailer } from './transcript-tailer.js';

/**
 * The tailer (TDS 07 §5.4), with **no database**: `TailStateStore` and `TranscriptSink` are the
 * two seams `ports.ts` exists to provide, and everything that matters about the tailer — the
 * restart-safe cursor, the partial trailing line, the drift counter, and A11's terminal
 * degradation — is provable through them on a real filesystem.
 *
 * Temp directories under the OS temp root, removed in teardown (TDS 07 §4 / F8.1: never
 * repo-relative paths).
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

const SESSION_ID = '01890000-0000-7000-8000-000000000001';

/** An in-memory `TailStateStore` that keeps the sticky-degradation contract honestly. */
function createFakeStore(): TailStateStore & {
  readonly rows: Map<string, TailState>;
  readonly degradeCalls: { sessionId: string; reason: string; driftCount: number }[];
} {
  const rows = new Map<string, TailState>();
  const degradeCalls: { sessionId: string; reason: string; driftCount: number }[] = [];

  return {
    rows,
    degradeCalls,
    async attach(input) {
      const existing = rows.get(input.sessionId);
      if (existing !== undefined) return existing;

      const created: TailState = {
        sessionId: input.sessionId,
        transcriptPath: input.transcriptPath,
        byteOffset: 0,
        lineNo: 0,
        driftCount: 0,
        degraded: false,
        lastError: null,
      };
      rows.set(input.sessionId, created);
      return created;
    },
    async load(sessionId) {
      return rows.get(sessionId) ?? null;
    },
    async advance(sessionId: string, advance: TailCursorAdvance) {
      const existing = rows.get(sessionId);
      if (existing === undefined) return;
      rows.set(sessionId, {
        ...existing,
        byteOffset: advance.byteOffset,
        lineNo: advance.lineNo,
        driftCount: advance.driftCount,
        lastError: advance.lastError ?? existing.lastError,
      });
    },
    async degrade(sessionId, reason, driftCount) {
      degradeCalls.push({ sessionId, reason, driftCount });
      const existing = rows.get(sessionId);
      if (existing === undefined) return false;
      // The false -> true flip is the emit-once decision, exactly as the SQL predicate is.
      if (existing.degraded) return false;
      rows.set(sessionId, { ...existing, degraded: true, lastError: reason, driftCount });
      return true;
    },
    async listResumable() {
      return [...rows.values()].filter((row) => !row.degraded);
    },
  };
}

function createFakeSink(): TranscriptSink & {
  readonly appended: TranscriptRecord[];
  observable: boolean;
} {
  const appended: TranscriptRecord[] = [];
  return {
    appended,
    observable: true,
    async append(_sessionId, record) {
      appended.push(record);
    },
    async isObservable() {
      return this.observable;
    },
  };
}

let directory: string;
let transcript: string;
let store: ReturnType<typeof createFakeStore>;
let sink: ReturnType<typeof createFakeSink>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mc-tail-'));
  transcript = join(directory, 'session.jsonl');
  store = createFakeStore();
  sink = createFakeSink();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function tailer(overrides: Partial<ConstructorParameters<typeof TranscriptTailer>[0]> = {}) {
  return new TranscriptTailer({ store, sink, watch: false, ...overrides });
}

describe('happy path', () => {
  it('ingests every conversation line and skips the ones it recognises as non-messages', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'happy-session.jsonl')));
    const tail = tailer();
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });

    const burst = await tail.drain(SESSION_ID);

    expect(burst?.drifted).toBe(0);
    // Five message lines; the `summary` line is recognised and skipped.
    expect(sink.appended).toHaveLength(5);
    expect(sink.appended.map((record) => record.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    await tail.stop();
  });
});

describe('incremental append and the partial trailing line', () => {
  it('emits events only for complete lines, and consumes the rest when it lands', async () => {
    const [first, second] = readFileSync(join(FIXTURES, 'happy-session.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

    // A chunk ending mid-line — TDS 07 §5.4's incremental-append case.
    writeFileSync(transcript, `${first as string}\n${(second as string).slice(0, 40)}`);

    const tail = tailer();
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });

    const firstBurst = await tail.drain(SESSION_ID);
    expect(sink.appended).toHaveLength(1);
    expect(firstBurst?.drifted).toBe(0);
    // The cursor stopped at the last newline: the partial line was not consumed and is NOT drift.
    expect(store.rows.get(SESSION_ID)?.byteOffset).toBe(Buffer.byteLength(`${first as string}\n`));

    appendFileSync(transcript, `${(second as string).slice(40)}\n`);
    await tail.drain(SESSION_ID);

    expect(sink.appended).toHaveLength(2);
    expect(store.rows.get(SESSION_ID)?.driftCount).toBe(0);
    await tail.stop();
  });
});

describe('restart resume (TDS 03 §3.15)', () => {
  it('resumes from the persisted cursor instead of replaying the file', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'happy-session.jsonl')));

    const first = tailer();
    await first.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    await first.drain(SESSION_ID);
    await first.stop();

    const offsetAfterFirstRun = store.rows.get(SESSION_ID)?.byteOffset ?? 0;
    expect(sink.appended).toHaveLength(5);
    expect(offsetAfterFirstRun).toBeGreaterThan(0);

    // A new process over the same persisted state — the whole point of the table.
    const second = tailer();
    const attached = await second.resume();
    expect(attached).toBe(1);

    const burst = await second.drain(SESSION_ID);

    // Nothing new past the cursor, so there is no burst at all — not a burst of zero lines.
    expect(burst).toBeNull();
    expect(sink.appended).toHaveLength(5); // nothing replayed
    expect(store.rows.get(SESSION_ID)?.byteOffset).toBe(offsetAfterFirstRun);

    // …and it picks up only what arrived while it was gone.
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'and after the restart' },
        uuid: 'after-restart',
      })}\n`,
    );
    await second.drain(SESSION_ID);

    expect(sink.appended).toHaveLength(6);
    expect(sink.appended[5]?.content).toBe('and after the restart');
    await second.stop();
  });
});

describe('drift and degradation (WS1 §6.3, arbitration A11)', () => {
  it('degrades to hook-only on a drifted fixture, without crashing or touching the Session', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'forward-compatibility.jsonl')));

    const degradations: { sessionId: string; reason: string; driftCount: number }[] = [];
    const tail = tailer({
      driftThreshold: 3,
      onDegraded: (info) => degradations.push(info),
    });

    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    const burst = await tail.drain(SESSION_ID);

    // Four drifted lines: two unknown types, one invalid JSON, one changed `message` shape.
    expect(burst?.drifted).toBe(4);
    expect(burst?.degraded).toBe(true);

    // …and the three well-formed lines around them were still ingested. Degrading is not
    // discarding: everything the tailer could read, it read.
    expect(sink.appended.map((record) => record.content)).toEqual([
      'Rename the queue module',
      'On it.',
      'Renamed it.',
    ]);

    const state = store.rows.get(SESSION_ID);
    expect(state?.degraded).toBe(true);
    expect(state?.driftCount).toBe(4);
    expect(state?.lastError).toContain('drift');

    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.sessionId).toBe(SESSION_ID);

    // The tailer detached. Nothing here transitioned the Session — the fake sink was never
    // asked to change state, and there is no path from this module to `sessions.state`.
    expect(tail.attached).toEqual([]);
    await tail.stop();
  });

  it('leaves the truncated trailing line unconsumed even while degrading', async () => {
    const raw = readFileSync(join(FIXTURES, 'forward-compatibility.jsonl'));
    writeFileSync(transcript, raw);

    const tail = tailer({ driftThreshold: 3 });
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    await tail.drain(SESSION_ID);

    const lastNewline = raw.lastIndexOf(0x0a);
    expect(store.rows.get(SESSION_ID)?.byteOffset).toBe(lastNewline + 1);
    expect(store.rows.get(SESSION_ID)?.byteOffset).toBeLessThan(raw.length);
    await tail.stop();
  });

  it('keeps full fidelity below the threshold', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'forward-compatibility.jsonl')));

    const tail = tailer({ driftThreshold: 25 });
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    const burst = await tail.drain(SESSION_ID);

    expect(burst?.drifted).toBe(4);
    expect(burst?.degraded).toBe(false);
    expect(store.rows.get(SESSION_ID)?.degraded).toBe(false);
    expect(tail.attached).toEqual([SESSION_ID]);
    await tail.stop();
  });

  it('is sticky: a degraded Session cannot be re-attached, in this process or the next', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'forward-compatibility.jsonl')));

    const tail = tailer({ driftThreshold: 3 });
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    await tail.drain(SESSION_ID);

    // A11: no re-attach contract. A later hook carrying the same transcript path must not
    // resurrect the tailer, and a restart must not either.
    const reattached = await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    expect(reattached).toBeNull();
    expect(tail.attached).toEqual([]);
    await tail.stop();

    const afterRestart = tailer({ driftThreshold: 3 });
    expect(await afterRestart.resume()).toBe(0);
    expect(afterRestart.attached).toEqual([]);
    await afterRestart.stop();

    // Exactly one degradation decision was ever reached — the event fires once per Session.
    expect(store.degradeCalls).toHaveLength(1);
  });

  it('does not count a persistence failure as drift', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'happy-session.jsonl')));

    const errors: unknown[] = [];
    sink.append = async () => {
      throw new Error('database unavailable');
    };

    const tail = tailer({
      driftThreshold: 1,
      onError: (error) => errors.push(error),
    });
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    const burst = await tail.drain(SESSION_ID);

    // A transient database blip is ours, not the format's; degrading over it would retire the
    // fidelity channel for the life of the Session over an outage that lasted a second.
    expect(burst?.drifted).toBe(0);
    expect(burst?.degraded).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    await tail.stop();
  });
});

describe('robustness', () => {
  it('never throws when the transcript does not exist', async () => {
    const tail = tailer();
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: join(directory, 'absent.jsonl') });

    await expect(tail.drain(SESSION_ID)).resolves.toBeNull();
    expect(sink.appended).toHaveLength(0);
    await tail.stop();
  });

  it('restarts from zero when the file is replaced by a shorter one', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'happy-session.jsonl')));
    const tail = tailer();
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });
    await tail.drain(SESSION_ID);
    expect(sink.appended).toHaveLength(5);

    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fresh' }, uuid: 'f1' })}\n`,
    );
    await tail.drain(SESSION_ID);

    // Re-read from 0; `(session_id, runtime_message_id)` absorbs anything we have seen before.
    expect(sink.appended).toHaveLength(6);
    expect(sink.appended[5]?.content).toBe('fresh');
    await tail.stop();
  });

  it('lets go of a Session that stopped being observable, without an error', async () => {
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'happy-session.jsonl')));
    const tail = tailer();
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });

    sink.observable = false;
    await tail.drain(SESSION_ID);

    expect(sink.appended).toHaveLength(0);
    expect(tail.attached).toEqual([]);
    await tail.stop();
  });

  it('detaches idempotently and stops cleanly with nothing attached', async () => {
    const tail = tailer();
    await expect(tail.detach('unknown')).resolves.toBeUndefined();
    await expect(tail.drain('unknown')).resolves.toBeNull();
    await expect(tail.stop()).resolves.toBeUndefined();
  });
});

describe('real filesystem watcher (dual-OS parity, WS1 §12 note 4)', () => {
  it('picks up an append without anybody calling drain', async () => {
    writeFileSync(transcript, '');
    const tail = new TranscriptTailer({ store, sink, watch: true, pollIntervalMs: 20 });
    await tail.attach({ sessionId: SESSION_ID, transcriptPath: transcript });

    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'watched' },
        uuid: 'w1',
      })}\n`,
    );

    // Watcher OR interval — the design deliberately does not depend on which fires first, and
    // neither does this assertion. Windows and Linux disagree about the answer.
    await vi.waitFor(() => {
      expect(sink.appended).toHaveLength(1);
    }, 5_000);

    expect(sink.appended[0]?.content).toBe('watched');
    await tail.stop();
  });
});
