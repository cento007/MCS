import { describe, expect, it } from 'vitest';
import {
  BACKFILL_SOURCE_ORDER,
  describeProgress,
  emptyProgress,
  isBackfillSourceType,
  readProgress,
  runBackfillSlice,
} from './backfill.js';

/**
 * Backfill progress — the part that has to survive a restart.
 *
 * `sync_runs.stats` is untyped JSONB written by this build and read by whatever build is running
 * next. `readProgress` is the boundary, and the tests below are about one property: **a value it
 * cannot understand must resolve to something safe, never to something that re-embeds the whole
 * corpus.** The slice loop itself is exercised against a real database in
 * `apps/backend/src/memory/memory-ingest.int.test.ts`, because its interesting behaviour is
 * keyset pagination over four tables.
 */

describe('the sweep order', () => {
  it('walks cheapest-and-densest first, so a half-done backfill is half useful', () => {
    // ADRs and PRs are short and decision-shaped; sessions are the long tail. A backfill that
    // is 30 % done should be able to answer "when did we decide X".
    expect([...BACKFILL_SOURCE_ORDER]).toEqual(['adr', 'pull_request', 'commit', 'session']);
  });

  it('starts at the first stage', () => {
    expect(emptyProgress().stage).toBe('adr');
    expect(emptyProgress().cursor).toBeNull();
    expect(emptyProgress().notesDone).toBe(false);
  });

  it('does not admit `obsidian_note` as a stage — it is not a table to page through', () => {
    expect(isBackfillSourceType('obsidian_note')).toBe(false);
    expect(isBackfillSourceType('adr')).toBe(true);
  });
});

describe('readProgress — untrusted JSONB in, safe progress out', () => {
  it('round-trips a progress object written by this build', () => {
    const progress = {
      ...emptyProgress(),
      stage: 'commit' as const,
      cursor: '018f6b2e-1111-7abc-8def-0123456789ab',
      sourcesSeen: 12,
      sourcesIndexed: 10,
      chunksEmbedded: 44,
      notesDone: true,
    };
    expect(readProgress(progress)).toEqual(progress);
  });

  it('resolves an unrecognised stage to "finished" rather than to the beginning', () => {
    // `"sessions"` (plural) is a plausible hand-edit. Guessing it meant `session` would restart
    // the most expensive stage; guessing it meant `adr` would re-embed the entire corpus.
    // Ending the run costs one operator click and nothing else.
    expect(readProgress({ stage: 'sessions' }).stage).toBeNull();
    expect(readProgress({ stage: 42 }).stage).toBeNull();
  });

  it('survives null, a non-object, and an empty object', () => {
    for (const stats of [null, undefined, 'nonsense', 7, []]) {
      const progress = readProgress(stats);
      expect(progress.stage).toBeNull();
      expect(progress.sourcesSeen).toBe(0);
      expect(progress.notesDone).toBe(false);
    }
  });

  it('rejects a negative or fractional counter instead of carrying it forward', () => {
    const progress = readProgress({ sourcesSeen: -5, chunksEmbedded: 3.7, failures: 'many' });
    expect(progress.sourcesSeen).toBe(0);
    expect(progress.chunksEmbedded).toBe(3);
    expect(progress.failures).toBe(0);
  });

  it('keeps an empty-string cursor out — it would restart the stage silently', () => {
    expect(readProgress({ stage: 'adr', cursor: '' }).cursor).toBeNull();
  });

  it('reads notesDone only from a real boolean', () => {
    expect(readProgress({ notesDone: 'yes' }).notesDone).toBe(false);
    expect(readProgress({ notesDone: true }).notesDone).toBe(true);
  });

  it('reads documentsDone the same way, and defaults it to "not yet run"', () => {
    // A run row written by a build that predates the documentation stage has no such key. It
    // must read as `false` so the stage runs once, not as `true` — which would silently skip
    // PRD §6.3's sixth source on every install that upgraded rather than started fresh.
    expect(readProgress({ stage: null }).documentsDone).toBe(false);
    expect(readProgress({ documentsDone: 'yes' }).documentsDone).toBe(false);
    expect(readProgress({ documentsDone: true }).documentsDone).toBe(true);
  });
});

describe('the indexed-source toggles gate the sweep', () => {
  /**
   * Only the *stage selection* is exercised here — no database, so no page is loaded. The
   * assertion is that a disabled stage advances the cursor to the next one instead of reading
   * it, which is what makes `settings.memory.indexedSources` a switch the backfill obeys rather
   * than a label. The end-to-end proof (nothing written for a disabled source) is in
   * `apps/backend/src/memory/memory-policy.int.test.ts`.
   */
  const NOT_REACHED = {
    db: null as never,
    embedder: null as never,
    store: null as never,
    stamp: { model: 'x', dimension: 3 },
    budget: { maxBytes: 1_800, contextTokens: 2_048, contextDeclared: true },
  } as const;

  it('steps over a disabled stage without touching the database', async () => {
    const slice = await runBackfillSlice({
      ...NOT_REACHED,
      progress: { ...emptyProgress(), stage: 'adr' },
      enabledSources: ['session', 'commit'],
    });

    // It reached the next stage without dereferencing `db` — which is `null` here precisely so
    // that "did it read the table" is answered by whether this line was reached at all.
    expect(slice.progress.stage).toBe('pull_request');
    expect(slice.progress.cursor).toBeNull();
    expect(slice.done).toBe(false);
    expect(slice.halt).toBeNull();
  });

  it('walks off the end when every stage is disabled, rather than looping', async () => {
    let progress = { ...emptyProgress() };
    for (let step = 0; step < BACKFILL_SOURCE_ORDER.length; step += 1) {
      progress = (await runBackfillSlice({ ...NOT_REACHED, progress, enabledSources: [] }))
        .progress;
    }
    expect(progress.stage).toBeNull();
  });

  it('reads an omitted `enabledSources` as "all of them" — the default policy', async () => {
    // The existing callers and every test that predates the toggles pass nothing; that must
    // keep meaning "index everything", not "index nothing". With `db: null` the only way to
    // observe "it tried to read the table" is that dereferencing it threw — which is exactly
    // the outcome the two cases above must NOT produce.
    await expect(
      runBackfillSlice({ ...NOT_REACHED, progress: { ...emptyProgress(), stage: 'adr' } }),
    ).rejects.toThrow();
  });
});

describe('describeProgress', () => {
  it('names the counts an operator asked for and the stage it is on', () => {
    const summary = describeProgress({
      ...emptyProgress(),
      stage: 'commit',
      sourcesIndexed: 120,
      chunksEmbedded: 480,
      sourcesSkipped: 3,
      failures: 1,
    });

    expect(summary).toContain('120 indexed');
    expect(summary).toContain('480 chunks embedded');
    expect(summary).toContain('1 failed');
    expect(summary).toContain('(at commit)');
  });

  it('reports failures even on an otherwise successful run', () => {
    // A run that indexed nine hundred sources and failed on one did not succeed on all nine
    // hundred and one; the count is what stops the summary from lying.
    expect(describeProgress({ ...emptyProgress(), failures: 2 })).toContain('2 failed');
  });
});
