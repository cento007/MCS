import { describe, expect, it } from 'vitest';
import {
  describeMemoryConsequences,
  memoryConsequences,
  readMemorySettings,
  retentionDraftKey,
  sourceDraftKey,
  toMemoryBody,
  toMemoryDraft,
} from './panels/memory-shape.js';
import { makeMemorySettings } from './test-support.js';

/**
 * Settings → Memory, without a DOM.
 *
 * The claim under test is the one the panel cannot make on its own: **a control exists only for a
 * key the Backend served, everything served survives a save, and a document is written back in
 * the dialect it arrived in.** The first two are consequences of full-category replace (A14) — an
 * omitted field is a reset, not a no-op. The third is the difference between "never expire" and
 * "expire everything now": the Backend spells never as `0` under `retentionDays`, the contract
 * this screen was specified against spelled it `null` under `retention`, and writing one dialect
 * into the other is either a rejected save or a silent deletion.
 */

describe('what the Backend actually served', () => {
  it('reads the Backend’s shape into one row per key, in vocabulary order', () => {
    const shape = readMemorySettings(makeMemorySettings());

    expect(shape.retention.map((row) => row.tier)).toEqual(['session', 'project', 'global']);
    // `0` under `retentionDays` is never-expire, and is carried internally as `null`.
    expect(shape.retention.map((row) => row.days)).toEqual([90, null, null]);
    expect(shape.dialect).toEqual({ field: 'retentionDays', never: 0 });
    expect(shape.sources.map((row) => row.sourceType)).toEqual([
      'session',
      'commit',
      'adr',
      'obsidian_note',
      'pull_request',
      'document',
    ]);
    // Derived from the shared vocabulary, not hand-listed: `pull_request` is `pullRequest`.
    expect(shape.sources.map((row) => row.field)).toContain('pullRequest');
    expect(shape.unrecognised).toEqual([]);
    expect(shape.empty).toBe(false);
  });

  it('reads the `retention` / `null` dialect too, without mixing the two', () => {
    const shape = readMemorySettings({ retention: { session: 90, global: null } });

    expect(shape.dialect).toEqual({ field: 'retention', never: null });
    expect(shape.retention.map((row) => row.days)).toEqual([90, null]);
  });

  it('keeps a literal `0` under the `retention` dialect as zero days, not as "never"', () => {
    // In that dialect `null` is never, so `0` is a real (alarming) window and must not be
    // silently promoted to the safest value the operator did not choose.
    const shape = readMemorySettings({ retention: { session: 0 } });

    expect(shape.retention[0]?.days).toBe(0);
  });

  it('reports the Backend that predates these keys — which serves `{}` — as empty', () => {
    const shape = readMemorySettings({});

    expect(shape.empty).toBe(true);
    expect(shape.retention).toEqual([]);
    expect(shape.sources).toEqual([]);
    expect(shape.dialect).toBeNull();
    expect(shape.hasIndexedSources).toBe(false);
  });

  it('renders half a contract as half a panel, not as a whole one with holes', () => {
    const shape = readMemorySettings({ indexedSources: { session: true, commit: false } });

    expect(shape.dialect).toBeNull();
    expect(shape.retention).toEqual([]);
    expect(shape.sources.map((row) => row.sourceType)).toEqual(['session', 'commit']);
    expect(shape.empty).toBe(false);
  });

  it('refuses to coerce a value it cannot read, and says which one', () => {
    // A string where a day count belongs is not 30 days and is not "never". Rendering either
    // would show the operator a value the server does not hold.
    const shape = readMemorySettings({
      retentionDays: { session: '30', project: 30 },
      indexedSources: { commit: 'yes', adr: true },
    });

    expect(shape.retention.map((row) => row.tier)).toEqual(['project']);
    expect(shape.sources.map((row) => row.sourceType)).toEqual(['adr']);
    expect(shape.unrecognised).toContain('retentionDays.session');
    expect(shape.unrecognised).toContain('indexedSources.commit');
  });

  it('names keys from a newer Backend rather than dropping them silently', () => {
    const shape = readMemorySettings({
      retentionDays: { session: 30, journal: 10 },
      indexedSources: { adr: true, sketch: true },
      pruneOnDisable: true,
    });

    expect(shape.unrecognised).toEqual(
      expect.arrayContaining(['pruneOnDisable', 'retentionDays.journal', 'indexedSources.sketch']),
    );
  });
});

describe('the replacement body (A14 full-category replace)', () => {
  it('carries every served field, not only the changed one', () => {
    const document = makeMemorySettings();
    const shape = readMemorySettings(document);
    const draft = { ...toMemoryDraft(shape), [sourceDraftKey('commit')]: false };

    expect(toMemoryBody(document, shape, draft)).toEqual({
      retentionDays: { session: 90, project: 0, global: 0 },
      indexedSources: {
        session: true,
        commit: false,
        adr: true,
        obsidianNote: true,
        pullRequest: true,
        document: true,
      },
    });
  });

  it('writes "never" back in the dialect it was read in', () => {
    const backend = makeMemorySettings({ retentionDays: { session: 90 } });
    const backendShape = readMemorySettings(backend);
    const backendBody = toMemoryBody(backend, backendShape, {
      ...toMemoryDraft(backendShape),
      [retentionDraftKey('session')]: 'never',
    });
    // `null` here would be a 400 against `integer, minimum: 0`.
    expect(backendBody['retentionDays']).toEqual({ session: 0 });

    const briefed = { retention: { session: 90 } };
    const briefedShape = readMemorySettings(briefed);
    const briefedBody = toMemoryBody(briefed, briefedShape, {
      ...toMemoryDraft(briefedShape),
      [retentionDraftKey('session')]: 'never',
    });
    // `0` here would mean "expire everything now" — the opposite of what was asked for.
    expect(briefedBody['retention']).toEqual({ session: null });
  });

  it('writes back a key it never rendered, because omitting it would reset it', () => {
    // The rollout order between the two apps is not controlled. An SPA that dropped an unknown
    // field would silently restore its default the first time anyone saved this category.
    const document = {
      ...makeMemorySettings(),
      pruneOnDisable: true,
      retentionDays: { session: 30, journal: 10 },
    };
    const shape = readMemorySettings(document);
    const body = toMemoryBody(document, shape, toMemoryDraft(shape));

    expect(body['pruneOnDisable']).toBe(true);
    expect(body['retentionDays']).toEqual({ session: 30, journal: 10 });
  });

  it('sends nothing shaped like settings when the Backend served nothing', () => {
    expect(toMemoryBody({}, readMemorySettings({}), {})).toEqual({});
  });
});

describe('consequences, computed before the write', () => {
  const document = makeMemorySettings({ retentionDays: { session: 90, project: 0, global: 365 } });
  const shape = readMemorySettings(document);
  const clean = toMemoryDraft(shape);

  it('counts a shorter window as a deletion', () => {
    const consequences = memoryConsequences(shape, {
      ...clean,
      [retentionDraftKey('session')]: '30',
    });

    expect(consequences.any).toBe(true);
    expect(consequences.narrowed).toEqual([
      { tier: 'session', label: 'Session memory', from: 90, to: 30 },
    ]);
  });

  it('counts "never" → a window as a deletion, because never is the widest window there is', () => {
    const consequences = memoryConsequences(shape, {
      ...clean,
      [retentionDraftKey('project')]: '365',
    });

    expect(consequences.narrowed).toHaveLength(1);
    expect(consequences.narrowed[0]?.from).toBeNull();
  });

  it('does not stop a widening — nothing is lost by keeping more', () => {
    const widened = memoryConsequences(shape, {
      ...clean,
      [retentionDraftKey('session')]: '365',
      [retentionDraftKey('global')]: 'never',
    });

    expect(widened.any).toBe(false);
  });

  it('counts a source switched off, and only in that direction', () => {
    const off = memoryConsequences(shape, { ...clean, [sourceDraftKey('commit')]: false });
    expect(off.disabled.map((row) => row.sourceType)).toEqual(['commit']);

    const alreadyOff = readMemorySettings({ indexedSources: { commit: false } });
    const on = memoryConsequences(alreadyOff, { [sourceDraftKey('commit')]: true });
    expect(on.any).toBe(false);
  });

  it('states both numbers and the real cost of undoing it', () => {
    const sentence = describeMemoryConsequences(
      memoryConsequences(shape, { ...clean, [retentionDraftKey('session')]: '30' }),
    );

    // "Are you sure?" without the old value asks the operator to remember what they replaced.
    expect(sentence).toContain('90 days');
    expect(sentence).toContain('30 days');
    expect(sentence).toContain('re-embedding');
  });

  it('does not call a disabled source a deletion', () => {
    const sentence = describeMemoryConsequences(
      memoryConsequences(shape, { ...clean, [sourceDraftKey('adr')]: false }),
    );

    expect(sentence).toContain('stops it being indexed');
    expect(sentence).toContain('Nothing already indexed is deleted');
    expect(sentence).not.toContain('deletes stored chunks');
  });
});
