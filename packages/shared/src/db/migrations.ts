import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db, DbTransaction } from './index.js';

/**
 * "Is this database the one this build was compiled against?" — asked once, at startup.
 *
 * ## The failure this exists to replace
 *
 * Migration `0012` added `agent_workflow_run_steps.waiting_notified_at`. It was committed and
 * never applied, so the Backend started, queried the column during its stranded-prompt sweep, and
 * **threw before it bound its port** — leaving a `tsx watch` supervisor alive with a dead app
 * inside it. The operator saw a raw `DrizzleQueryError` in a log they were not watching, and in
 * the browser "Mission Control returned a response this client could not read", because Vite was
 * proxying to nothing. Three layers away from the one fact that mattered: *run `pnpm db:migrate`*.
 *
 * `DATABASE_SCHEMA_MISMATCH` (`http/errors.ts`) already turns this class of mistake into an
 * actionable answer **during a request** — a CHECK constraint rejecting a value that is a
 * compile-time constant. It cannot help at startup, because there is no request to answer and the
 * process is gone before it could. This is the same idea one layer earlier.
 *
 * ## Why the journal, and not a hand-written list
 *
 * The expectation is `drizzle/meta/_journal.json` — the file drizzle-kit writes and `db:migrate`
 * reads — so it cannot drift from what the migrator would do. A constant listing the migrations
 * this build expects would be a second statement of the same fact, and this codebase has paid for
 * those repeatedly (a `SYNC_RUN_KINDS` that said `['obsidian']` for two phases; binding refusals
 * transcribed into the frontend). The folder ships wherever the Backend does, because production
 * runs `pnpm db:migrate` from it (`deploy/systemd/README.md`).
 *
 * `created_at` in `drizzle.__drizzle_migrations` is a **bigint holding the journal's `when`**, so
 * the comparison is an exact set match rather than a heuristic about counts.
 *
 * ## What it deliberately does not do
 *
 * It does not check that the *columns* are right — only that every migration the build knows
 * about has been applied. A database edited by hand is out of scope; `db:migrate` is the only
 * supported path, and a check that tried to verify the whole schema would be a second, weaker
 * implementation of the migrator.
 */

export interface MigrationJournalEntry {
  readonly tag: string;
  /** Epoch milliseconds. drizzle stores this verbatim as `__drizzle_migrations.created_at`. */
  readonly when: number;
}

export type SchemaVersionState =
  /** Every journal entry is applied. */
  | 'ok'
  /** The database is missing migrations this build ships. **Fatal** — see `describeSchemaVersion`. */
  | 'behind'
  /** The database has migrations this build does not ship: an older Backend against a newer DB. */
  | 'ahead'
  /** The journal could not be read. Reported, never fatal — see below. */
  | 'unknown';

export interface SchemaVersionReport {
  readonly state: SchemaVersionState;
  /** Journal tags absent from the database, in journal order. */
  readonly pending: readonly string[];
  readonly appliedCount: number;
  readonly expectedCount: number;
  /** Why the state could not be determined, when it could not. */
  readonly detail: string | null;
}

/**
 * The comparison, as a pure function.
 *
 * Separated from the query so the interesting half is testable without a database — the same
 * reason `disallowedToolsFor` and `affectsMemoryRuntime` are pure.
 */
export function compareMigrations(
  journal: readonly MigrationJournalEntry[],
  appliedWhen: readonly number[],
): SchemaVersionReport {
  const applied = new Set(appliedWhen);
  const pending = journal.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag);

  const expected = new Set(journal.map((entry) => entry.when));
  const unknownToThisBuild = appliedWhen.filter((when) => !expected.has(when));

  // `behind` outranks `ahead`: if both are true the database is simply a different lineage, and
  // the missing migrations are the half an operator can act on.
  const state: SchemaVersionState =
    pending.length > 0 ? 'behind' : unknownToThisBuild.length > 0 ? 'ahead' : 'ok';

  return {
    state,
    pending,
    appliedCount: appliedWhen.length,
    expectedCount: journal.length,
    detail:
      state === 'ahead'
        ? `${String(unknownToThisBuild.length)} applied migration(s) are not in this build's journal`
        : null,
  };
}

/**
 * Read `drizzle/meta/_journal.json`, relative to this module.
 *
 * `../../` resolves to the package root from **both** layouts — `src/db/` under `tsx`, and
 * `dist/db/` once built — because the two mirror each other.
 */
export function readMigrationJournal(): readonly MigrationJournalEntry[] | null {
  try {
    const path = fileURLToPath(new URL('../../drizzle/meta/_journal.json', import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return null;

    return entries
      .filter(
        (entry): entry is { tag: string; when: number } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { tag?: unknown }).tag === 'string' &&
          typeof (entry as { when?: unknown }).when === 'number',
      )
      .map((entry) => ({ tag: entry.tag, when: entry.when }));
  } catch {
    return null;
  }
}

/**
 * Ask the database which migrations it has, and compare.
 *
 * Never throws. A missing `drizzle.__drizzle_migrations` is not an error — it is a database that
 * has never been migrated at all, which is `behind` with everything pending, and is exactly what
 * a fresh install looks like before its first `db:migrate`.
 */
export async function checkSchemaVersion(db: Db | DbTransaction): Promise<SchemaVersionReport> {
  const journal = readMigrationJournal();
  if (journal === null) {
    return {
      state: 'unknown',
      pending: [],
      appliedCount: 0,
      expectedCount: 0,
      detail: 'drizzle/meta/_journal.json could not be read',
    };
  }

  let appliedWhen: number[];
  try {
    const rows = await db.execute<{ created_at: string | number }>(
      sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    // bigint arrives as a string through `pg` (it does not fit a JS number safely in general);
    // these are epoch milliseconds, which do.
    appliedWhen = rows.rows.map((row) => Number(row.created_at));
  } catch {
    // The table is created by the first `db:migrate`. Absent means none have run.
    appliedWhen = [];
  }

  return compareMigrations(journal, appliedWhen);
}

/**
 * One line an operator can act on, or `null` when there is nothing to say.
 *
 * The whole point of this module is that the answer fits on one line and names the command. A
 * stack trace naming `waiting_notified_at` is a true statement about a query; it is not an
 * answer to "what do I do".
 */
export function describeSchemaVersion(report: SchemaVersionReport): string | null {
  switch (report.state) {
    case 'behind': {
      const missing = report.pending.length;
      const first = report.pending[0] ?? 'unknown';
      const rest = missing > 1 ? ` (and ${String(missing - 1)} more)` : '';
      return (
        `The database is behind this build: ${String(missing)} migration(s) have not been applied, ` +
        `starting with ${first}${rest}. Run \`pnpm db:migrate\` and start again.`
      );
    }
    case 'ahead':
      return (
        `The database has ${String(report.appliedCount - report.expectedCount)} migration(s) this ` +
        `build does not ship — it was migrated by a newer version. Deploy that version, or check ` +
        `out the matching commit.`
      );
    case 'unknown':
      return `Could not verify the database schema version: ${report.detail ?? 'no detail'}.`;
    default:
      return null;
  }
}
