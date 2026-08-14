import { describe, expect, it } from 'vitest';
import {
  compareMigrations,
  describeSchemaVersion,
  type MigrationJournalEntry,
  readMigrationJournal,
} from './migrations.js';

/**
 * The startup schema check.
 *
 * What it replaces: migration `0012` was committed and never applied, so the Backend threw a raw
 * `DrizzleQueryError` about `waiting_notified_at` **before binding its port**. In the browser that
 * surfaced as "Mission Control returned a response this client could not read" — Vite proxying to
 * a dead process — three layers from the fact that mattered, which was `pnpm db:migrate`.
 *
 * The comparison is a pure function precisely so the interesting half needs no database, the same
 * split `disallowedToolsFor` and `affectsMemoryRuntime` use.
 */

const entry = (tag: string, when: number): MigrationJournalEntry => ({ tag, when });

const JOURNAL: readonly MigrationJournalEntry[] = [
  entry('0000_blue_cyclops', 1_000),
  entry('0001_include_and_fillfactor', 2_000),
  entry('0002_odd_whistler', 3_000),
];

describe('compareMigrations', () => {
  it('is ok when every journal entry has been applied', () => {
    const report = compareMigrations(JOURNAL, [1_000, 2_000, 3_000]);
    expect(report.state).toBe('ok');
    expect(report.pending).toEqual([]);
    expect(describeSchemaVersion(report)).toBeNull();
  });

  it('is behind when the newest migration is missing — the case that shipped', () => {
    // Exactly the 0012 shape: everything applied except the last one committed.
    const report = compareMigrations(JOURNAL, [1_000, 2_000]);
    expect(report.state).toBe('behind');
    expect(report.pending).toEqual(['0002_odd_whistler']);
  });

  it('is behind on a database that has never been migrated', () => {
    const report = compareMigrations(JOURNAL, []);
    expect(report.state).toBe('behind');
    expect(report.pending).toHaveLength(3);
  });

  it('catches a gap in the middle, not just a missing tail', () => {
    // A set comparison rather than "is the newest applied": a hand-repaired database can be
    // missing a middle migration while looking current by max(created_at).
    const report = compareMigrations(JOURNAL, [1_000, 3_000]);
    expect(report.state).toBe('behind');
    expect(report.pending).toEqual(['0001_include_and_fillfactor']);
  });

  it('is ahead when the database carries a migration this build does not ship', () => {
    const report = compareMigrations(JOURNAL, [1_000, 2_000, 3_000, 4_000]);
    expect(report.state).toBe('ahead');
    expect(report.pending).toEqual([]);
  });

  it('reports behind rather than ahead when both are true', () => {
    // A different lineage. Both facts hold, but only the missing half is something the operator
    // can act on, so that is the one the state names.
    const report = compareMigrations(JOURNAL, [1_000, 9_000]);
    expect(report.state).toBe('behind');
  });

  it('does not care what order the database returns them in', () => {
    expect(compareMigrations(JOURNAL, [3_000, 1_000, 2_000]).state).toBe('ok');
  });
});

describe('describeSchemaVersion', () => {
  it('names the command, not the column', () => {
    // The whole point. `column … does not exist` is a true statement about a query and not an
    // answer to "what do I do".
    const message = describeSchemaVersion(compareMigrations(JOURNAL, [1_000, 2_000])) ?? '';
    expect(message).toContain('pnpm db:migrate');
    expect(message).toContain('0002_odd_whistler');
  });

  it('counts the rest instead of listing all of them', () => {
    const message = describeSchemaVersion(compareMigrations(JOURNAL, [])) ?? '';
    expect(message).toContain('0000_blue_cyclops');
    expect(message).toContain('and 2 more');
  });

  it('says something different, and non-actionable, when the database is ahead', () => {
    const message = describeSchemaVersion(compareMigrations(JOURNAL, [1_000, 2_000, 3_000, 4_000]));
    expect(message).toContain('newer version');
    expect(message).not.toContain('pnpm db:migrate');
  });
});

describe('readMigrationJournal', () => {
  it('reads this package’s real journal', () => {
    // Proves the `../../` path resolves from wherever this module actually lives — the one part
    // of this file that would break silently under a build-layout change, and the reason a
    // missing journal is reported as `unknown` rather than crashing startup.
    const journal = readMigrationJournal();
    expect(journal).not.toBeNull();
    expect(journal?.length ?? 0).toBeGreaterThan(0);
    expect(journal?.[0]?.tag).toMatch(/^0000_/);
    // Every entry carries the `when` the database stores as `created_at`.
    expect(journal?.every((item) => Number.isFinite(item.when))).toBe(true);
  });
});
