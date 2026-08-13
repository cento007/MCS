import { describe, expect, it } from 'vitest';
import { settingKey } from '../settings/registry.js';
import {
  allMemorySourcesEnabled,
  enabledMemorySources,
  isSourceIndexed,
  type MemoryPolicy,
  parseMemoryPolicy,
  retentionCutoff,
  retentionDisabled,
} from './policy.js';

/**
 * The Settings → Memory policy (PRD §4.4 item 4), without a database.
 *
 * Everything here is about one property: **the safe direction of every repair is the one that
 * keeps data.** A row this parser cannot understand must not silently switch a source off (a
 * memory that stops being written is invisible) and must not silently shorten a retention
 * window (a memory that is deleted is gone). Both directions are asserted, because a parser
 * that fell back to `{}` would pass a test that only checked the happy path.
 *
 * The enforcement — the indexer, the sweep and retrieval actually obeying this — is proved
 * against a real database in `apps/backend/src/memory/memory-policy.int.test.ts`.
 */

const SOURCES = settingKey('memory.indexedSources');
const RETENTION = settingKey('memory.retentionDays');

function policyFrom(values: Record<string, unknown>): MemoryPolicy {
  return parseMemoryPolicy(new Map(Object.entries(values)));
}

describe('storage coordinates', () => {
  it('derives the §7.6 keys from the API paths', () => {
    expect(SOURCES).toBe('indexed_sources');
    expect(RETENTION).toBe('retention_days');
  });
});

describe('a database with no memory rows at all', () => {
  it('indexes every source and expires nothing', () => {
    const policy = policyFrom({});

    expect(allMemorySourcesEnabled(policy)).toBe(true);
    expect(enabledMemorySources(policy)).toEqual([
      'session',
      'commit',
      'adr',
      'obsidian_note',
      'pull_request',
      'document',
    ]);
    expect(retentionDisabled(policy)).toBe(true);
  });
});

describe('the source toggles', () => {
  it('maps `pull_request` onto the `pullRequest` field, derived not hand-listed', () => {
    const policy = policyFrom({ [SOURCES]: { pullRequest: false } });

    expect(isSourceIndexed(policy, 'pull_request')).toBe(false);
    expect(isSourceIndexed(policy, 'session')).toBe(true);
    expect(enabledMemorySources(policy)).not.toContain('pull_request');
  });

  it('reports "not all enabled" the moment one is off', () => {
    expect(allMemorySourcesEnabled(policyFrom({ [SOURCES]: { document: false } }))).toBe(false);
  });

  it('repairs junk to ON — a source silently switched off is an invisible failure', () => {
    const policy = policyFrom({ [SOURCES]: { commit: 'no', adr: 0, session: false } });

    expect(isSourceIndexed(policy, 'commit')).toBe(true);
    expect(isSourceIndexed(policy, 'adr')).toBe(true);
    // A real `false` is still honoured — the repair is for values that are not booleans.
    expect(isSourceIndexed(policy, 'session')).toBe(false);
  });

  it('survives a row that is not an object at all', () => {
    expect(allMemorySourcesEnabled(policyFrom({ [SOURCES]: 'everything' }))).toBe(true);
    expect(allMemorySourcesEnabled(policyFrom({ [SOURCES]: null }))).toBe(true);
  });
});

describe('the retention windows', () => {
  const NOW = new Date('2026-08-13T12:00:00.000Z');

  it('treats 0 as never expire, exactly as auditLogRetentionDays does', () => {
    const policy = policyFrom({ [RETENTION]: { session: 0, project: 0, global: 0 } });

    expect(retentionDisabled(policy)).toBe(true);
    expect(retentionCutoff(policy, 'session', NOW)).toBeNull();
  });

  it('computes a cutoff from the row’s own age, not from the source’s', () => {
    const policy = policyFrom({ [RETENTION]: { session: 30 } });

    expect(retentionCutoff(policy, 'session', NOW)?.toISOString()).toBe('2026-07-14T12:00:00.000Z');
    // The other two are untouched: one tier expiring must not expire the rest.
    expect(retentionCutoff(policy, 'project', NOW)).toBeNull();
    expect(retentionCutoff(policy, 'global', NOW)).toBeNull();
    expect(retentionDisabled(policy)).toBe(false);
  });

  it('repairs junk and negatives to "never", never to a shorter window', () => {
    const policy = policyFrom({ [RETENTION]: { session: 'thirty', project: -1, global: 1.5 } });

    expect(retentionCutoff(policy, 'session', NOW)).toBeNull();
    expect(retentionCutoff(policy, 'project', NOW)).toBeNull();
    // A non-integer is truncated by the registry's `integerValue`, not rounded up.
    expect(policy.retentionDays.global).toBe(1);
  });

  it('has no window for the `agent` tier, which nothing writes', () => {
    expect(Object.keys(policyFrom({}).retentionDays)).toEqual(['session', 'project', 'global']);
  });
});
