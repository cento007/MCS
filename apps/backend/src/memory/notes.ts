import {
  type ChunkBudget,
  type Db,
  type EmbeddingPort,
  type EmbeddingStamp,
  indexSource,
  parseFrontMatter,
  projectNote,
  purgeSource,
  readObsidianSettings,
  type ScanBounds,
  scanVault,
  schema,
  type VectorStorePort,
} from '@mc/shared';
import { and, eq, notInArray } from 'drizzle-orm';

/**
 * Indexing the operator's own Obsidian notes (PRD §6.3 "Obsidian Notes").
 *
 * ## Only unmanaged notes, and that is the whole design
 *
 * The vault's `Projects/`, `Sessions/` and `ADRs/` folders are **generated** by the Phase 2 sync
 * from rows this index already covers. Indexing them too would put the same knowledge in the
 * store twice under two source types, and a top-5 would routinely spend two slots saying the
 * same thing in two formats. So a note is indexed **only when it carries no Mission Control
 * `mc-id`** — which is exactly the operator's own writing, and exactly the knowledge that exists
 * nowhere else in this database.
 *
 * The scan therefore covers the whole vault rather than the managed folders: an operator's notes
 * live wherever they put them, and restricting to the folders Mission Control writes would index
 * only the notes we have decided to skip.
 *
 * ## Why this stage is in the Backend and not in `@mc/shared`'s backfill
 *
 * It is a bounded filesystem walk against an operator-supplied path, with its own five bounds
 * and its own way of being absent (no vault configured is normal, not a failure). `backfill.ts`
 * is a keyset sweep over database tables; giving it a stage that means something completely
 * different would make its `stage` vocabulary a lie. The run row carries `notesDone` instead.
 *
 * ## Deletion
 *
 * A note that has vanished from the vault, or acquired an `mc-id` since it was indexed, must
 * stop answering queries. Both are caught by the same sweep: everything indexed under
 * `obsidian_note` whose `source_ref` is not in the current unmanaged set is purged. That makes
 * the rule derivable from a scan rather than from a filesystem watcher that has to have been
 * running.
 */

/** One pass, capped. A vault larger than this indexes its first `MAX_NOTES` and says so. */
export const MAX_INDEXED_NOTES = 2_000;

/** Tighter than the sync engine's: this runs inside a queue job with a 900 s lease. */
const NOTE_SCAN_BOUNDS: ScanBounds = { deadlineMs: 30_000, maxFiles: 5_000 };

/** Whole-vault scan: `['']` is "start at the root" rather than the managed folder list. */
const WHOLE_VAULT: readonly string[] = [''];

export interface NoteStageOptions {
  readonly db: Db;
  readonly embedder: EmbeddingPort;
  readonly store: VectorStorePort;
  readonly stamp: EmbeddingStamp;
  readonly budget: ChunkBudget;
  readonly now?: (() => Date) | undefined;
  readonly bounds?: ScanBounds | undefined;
  readonly maxNotes?: number | undefined;
}

export interface NoteStageResult {
  readonly seen: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly embedded: number;
  readonly purged: number;
  readonly failures: number;
  readonly lastError: string | null;
  /** Set when a dependency failed — the caller fails the run rather than continuing. */
  readonly halt: string | null;
}

const EMPTY: NoteStageResult = {
  seen: 0,
  indexed: 0,
  skipped: 0,
  embedded: 0,
  purged: 0,
  failures: 0,
  lastError: null,
  halt: null,
};

export async function indexVaultNotes(options: NoteStageOptions): Promise<NoteStageResult> {
  const settings = await readObsidianSettings(options.db);
  const vaultPath = settings.vaultPath?.trim() ?? '';
  // No vault configured is the normal state of a fresh install, not a failure: skip silently.
  if (vaultPath.length === 0) return EMPTY;

  const scan = await scanVault(vaultPath, options.bounds ?? NOTE_SCAN_BOUNDS, WHOLE_VAULT);

  const maxNotes = options.maxNotes ?? MAX_INDEXED_NOTES;
  const unmanaged = scan.files
    .filter((file) => file.identity === null && file.note !== null && file.problem === null)
    .slice(0, maxNotes);

  let indexed = 0;
  let skipped = 0;
  let embedded = 0;
  const failures = 0;
  const lastError: string | null = null;

  for (const file of unmanaged) {
    const outcome = await indexSource({
      db: options.db,
      embedder: options.embedder,
      store: options.store,
      stamp: options.stamp,
      budget: options.budget,
      projection: projectNote({
        vaultPath: file.vaultPath,
        // `ParsedNote` is a *structured* view (title, preamble, sections) built for the sync
        // engine's diffing; retrieval wants the prose. Re-splitting the raw text is one pass
        // over a string already in memory, and it keeps front matter out of the vector.
        body: parseFrontMatter(file.text ?? '').body,
        mtime: file.mtime,
      }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    switch (outcome.kind) {
      case 'indexed':
        indexed += 1;
        embedded += outcome.embedded;
        break;
      case 'skipped':
        skipped += 1;
        break;
      default:
        // A dependency failure would repeat for every remaining note; stop and let the run fail
        // with a reason rather than accumulating two thousand identical errors.
        return {
          seen: unmanaged.length,
          indexed,
          skipped,
          embedded,
          purged: 0,
          failures: failures + 1,
          lastError: outcome.reason,
          halt: outcome.reason,
        };
    }
  }

  const purged = await purgeVanishedNotes(
    options,
    unmanaged.map((file) => file.vaultPath),
    // A truncated scan proves nothing about what is absent, so the purge is skipped: deleting
    // every note the scan did not reach would empty the index on a vault one file too large.
    scan.truncated,
  );

  return {
    seen: unmanaged.length,
    indexed,
    skipped,
    embedded,
    purged,
    failures,
    lastError,
    halt: null,
  };
}

/**
 * Forget notes that are no longer unmanaged notes in the vault — deleted, renamed, or newly
 * carrying an `mc-id`.
 *
 * Skipped outright when the scan truncated: "this path was not in the scan" then means "the
 * scan stopped early", not "the file is gone", and acting on the difference would delete the
 * tail of the index every run.
 */
async function purgeVanishedNotes(
  options: NoteStageOptions,
  present: readonly string[],
  scanTruncated: boolean,
): Promise<number> {
  if (scanTruncated) return 0;

  const stale = await options.db
    .selectDistinct({ sourceRef: schema.memoryItems.sourceRef })
    .from(schema.memoryItems)
    .where(
      present.length === 0
        ? eq(schema.memoryItems.sourceType, 'obsidian_note')
        : and(
            eq(schema.memoryItems.sourceType, 'obsidian_note'),
            notInArray(schema.memoryItems.sourceRef, [...present]),
          ),
    );

  let purged = 0;
  for (const row of stale) {
    if (row.sourceRef === null) continue;
    const result = await purgeSource({
      db: options.db,
      store: options.store,
      key: { sourceType: 'obsidian_note', sourceId: null, sourceRef: row.sourceRef },
    });
    purged += result.deleted;
  }
  return purged;
}
