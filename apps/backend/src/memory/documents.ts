import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  type ChunkBudget,
  type Db,
  documentSourceRef,
  type EmbeddingPort,
  type EmbeddingStamp,
  indexSource,
  listDocumentRepositories,
  listRepositoryScopes,
  listSourceRefs,
  parseDocumentSourceRef,
  parseFrontMatter,
  projectDocument,
  purgeSource,
  readObsidianSettings,
  readTextFile,
  type VectorStorePort,
} from '@mc/shared';

/**
 * Indexing **repository documentation** — PRD §6.3's sixth source, "Documentation".
 *
 * `MEMORY_SOURCE_TYPES` has declared `document` since the vocabulary was written and nothing
 * produced one, so the Memory screen shipped a source filter that could never match. This is
 * the producer.
 *
 * `notes.ts` is the precedent and this file departs from it deliberately in three places; the
 * shape it keeps is the important part: a bounded filesystem walk against operator-supplied
 * paths, with its own bounds, its own "absent is normal", and its own run flag rather than a
 * member of `BACKFILL_SOURCE_ORDER` (that vocabulary means "a table this database holds").
 *
 * ## What counts as documentation
 *
 * A repository is not documentation, and "every Markdown file, recursively" is not a rule — it
 * is how `node_modules` ends up in a vector store. The rule is deliberately narrow and stated
 * in one place:
 *
 *   > A file is repository documentation when its extension is in {@link DOCUMENT_EXTENSIONS}
 *   > **and** it sits either at the repository root or anywhere beneath a root-level directory
 *   > named in {@link DOCUMENT_DIRECTORIES}.
 *
 * So `README.md`, `CONTRIBUTING.md`, `Requirements.md`, `docs/tds/03-database-schema.md` — yes.
 * `src/memory/README.md`, anything under `node_modules`, a package's own `CHANGELOG.md` — no. The walk
 * never descends anywhere else, so a repository with a 40 000-file `node_modules` costs one
 * `readdir` of its root. {@link NEVER_DESCEND} is applied *inside* the documentation directories
 * as well, because `docs/node_modules` (a docs site with its own dependencies) is a real thing.
 *
 * The narrow rule is a floor, not a ceiling: source-adjacent Markdown is the natural next
 * widening, and it belongs behind an explicit setting rather than behind a default that quietly
 * triples the corpus.
 *
 * ## Overlap with `obsidian_note` — the vault wins
 *
 * `notes.ts` indexes only *unmanaged* notes precisely so one piece of knowledge cannot occupy
 * two top-5 slots under two source types. The same hazard exists here and it is not
 * hypothetical: a previous agent pointed the Obsidian vault path at `D:\Repos\MCS\docs` to get
 * a corpus, which would have made every TDS file both an `obsidian_note` (global tier) and a
 * `document` (project tier).
 *
 * **A file inside the configured vault is not indexed as a document.** The precedence is one
 * direction and it is this one for two reasons. The vault path is something an operator
 * *declared*; the documentation set is *derived* from repository rows, and a derived rule should
 * yield to a declared one. And reversing it would make the note stage depend on the
 * `repositories` table — "index my vault" would then depend on GitHub discovery having run,
 * which is a coupling that does not exist today and should not.
 *
 * The same file reachable through two repositories (one checked out inside another's `docs/`)
 * is indexed once, under the first repository in id order; the second sees it already claimed
 * and skips.
 *
 * ## Absent is normal
 *
 * `repositories.local_path` is `NOT NULL`, so there is no such thing as a repository without a
 * path — but there is very much such a thing as a path that is not on *this* machine: a checkout
 * on an unplugged drive, a directory the operator moved, a repository registered on the server
 * and read on the laptop. That is skipped silently and **its indexed documents are not purged**,
 * for the same reason `notes.ts` skips its purge after a truncated scan: "the scan did not see
 * it" and "it is gone" are different statements, and only one of them justifies deleting work.
 *
 * Two things *are* purged, because both are facts this database holds rather than guesses about
 * a filesystem: documents of a repository row that has been **deleted**, and documents of a
 * repository that has been **unassigned from its Project** (its rows are `project`-tier and
 * would otherwise keep naming a Project the repository no longer belongs to).
 */

/** Root-level directories whose entire subtree counts as documentation. */
export const DOCUMENT_DIRECTORIES: readonly string[] = Object.freeze([
  'docs',
  'doc',
  'documentation',
]);

/** Lowercase, including the dot. Markdown only — see the header. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze(['.md', '.markdown']);

/**
 * Directories never descended into, at any depth, matched case-insensitively by exact name.
 * The same denylist repository discovery uses, and for the same reason: never what the operator
 * meant, frequently the largest thing on disk.
 */
const NEVER_DESCEND: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'venv',
  '.venv',
  '.cache',
  '.next',
  '.turbo',
  'bin',
  'obj',
]);

/**
 * The bounds, each named and each with a stated consequence when it bites.
 *
 * The bound that makes the *model* safe is not here: it is `ChunkBudget`, and it applies to
 * every source alike (`chunk.ts` — Ollama answers `200` with a vector built from the opening
 * fraction of over-long input, so the input is bounded before the call rather than after it).
 * A file that is legitimately huge is chunked, and if it exceeds `DEFAULT_MAX_CHUNKS` the
 * indexer records `truncated` rather than cutting it silently.
 *
 * These bounds are about the *run*: what one operator-triggered backfill may spend on files.
 */

/** Files per repository. Beyond it the repository is `truncated` and **not purged**. */
export const MAX_DOCUMENTS_PER_REPOSITORY = 500;
/** Repositories per run. Those beyond it are neither scanned nor purged this run. */
export const MAX_DOCUMENT_REPOSITORIES = 50;
/** One file above this is recorded as `oversized` and never read — it is not prose. */
export const MAX_DOCUMENT_FILE_BYTES = 512 * 1024;
/** Bytes read per repository. Exceeding it truncates that repository (so: no purge). */
export const MAX_DOCUMENT_TOTAL_BYTES = 16 * 1024 * 1024;
/** Directory nesting below the repository root. Deeper subtrees truncate the repository. */
export const MAX_DOCUMENT_DEPTH = 8;
/** Entries read from any one directory before the repository is declared truncated. */
export const MAX_DOCUMENT_ENTRIES_PER_DIRECTORY = 2_000;
/** Wall clock for the whole stage, across every repository. Tighter than the 900 s job lease. */
export const DOCUMENT_SCAN_DEADLINE_MS = 30_000;

export interface DocumentScanBounds {
  readonly maxFilesPerRepository?: number | undefined;
  readonly maxRepositories?: number | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxEntriesPerDirectory?: number | undefined;
  readonly deadlineMs?: number | undefined;
  /** Injectable clock so the deadline is testable without waiting for one. */
  readonly now?: (() => number) | undefined;
}

export interface ScannedDocument {
  /** Repo-relative, forward slashes — the `source_ref` suffix. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly mtime: Date;
  readonly size: number;
  /** `null` when the file was too large or could not be read. */
  readonly text: string | null;
  /** Set when this one file could not be read; the scan continues regardless. */
  readonly problem: string | null;
}

export interface RepositoryDocumentScan {
  readonly files: readonly ScannedDocument[];
  readonly truncated: boolean;
  readonly truncatedReason: string | null;
  /** Files skipped because they exceeded `maxFileBytes`. Counted, never silent. */
  readonly oversized: number;
}

/**
 * Walk one repository's documentation set. Never throws for an ordinary filesystem condition.
 *
 * Exported so the walk is unit-testable against a temp directory with no database and no
 * embedder — the interesting half of this stage is which files it decides to look at.
 */
export async function scanRepositoryDocuments(
  repositoryRoot: string,
  bounds: DocumentScanBounds = {},
  isExcluded: (absolutePath: string) => boolean = () => false,
): Promise<RepositoryDocumentScan> {
  const now = bounds.now ?? (() => Date.now());
  const maxFiles = bounds.maxFilesPerRepository ?? MAX_DOCUMENTS_PER_REPOSITORY;
  const maxFileBytes = bounds.maxFileBytes ?? MAX_DOCUMENT_FILE_BYTES;
  const maxTotalBytes = bounds.maxTotalBytes ?? MAX_DOCUMENT_TOTAL_BYTES;
  const maxDepth = bounds.maxDepth ?? MAX_DOCUMENT_DEPTH;
  const maxEntries = bounds.maxEntriesPerDirectory ?? MAX_DOCUMENT_ENTRIES_PER_DIRECTORY;
  const deadline = now() + (bounds.deadlineMs ?? DOCUMENT_SCAN_DEADLINE_MS);

  const root = resolve(repositoryRoot);
  const files: ScannedDocument[] = [];
  let totalBytes = 0;
  let oversized = 0;
  let truncatedReason: string | null = null;

  const walk = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (truncatedReason !== null) return;
    if (depth > maxDepth) {
      truncatedReason = `documentation nesting exceeded ${String(maxDepth)} levels at ${relativeDirectory}`;
      return;
    }

    const absoluteDirectory =
      relativeDirectory === '' ? root : join(root, ...relativeDirectory.split('/'));

    let entries: Dirent[];
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      // A repository with no `docs/`, or a directory that vanished mid-walk, is ordinary. Any
      // other read failure is a per-directory fact, not a reason to abandon the run.
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return;
      return;
    }

    if (entries.length > maxEntries) {
      truncatedReason = `${relativeDirectory === '' ? '(root)' : relativeDirectory} holds more than ${String(maxEntries)} entries`;
      return;
    }

    // Sorted so a truncated scan truncates the same way twice and the "first repository wins"
    // dedupe is deterministic between runs.
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      if (truncatedReason !== null) return;
      if (now() > deadline) {
        truncatedReason = 'the documentation scan deadline elapsed';
        return;
      }

      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;

      if (entry.isDirectory()) {
        // At the root, only the documentation directories are descended into; below it, any
        // directory that is not on the denylist. `isDirectory()` is false for a directory
        // symlink — deliberately, as in the discovery scan: following them turns a bounded walk
        // into a cycle.
        if (entry.name.startsWith('.')) continue;
        if (NEVER_DESCEND.has(entry.name.toLowerCase())) continue;
        if (relativeDirectory === '' && !DOCUMENT_DIRECTORIES.includes(entry.name.toLowerCase())) {
          continue;
        }
        await walk(relativePath, depth + 1);
        continue;
      }

      if (!entry.isFile() || !isDocumentFile(entry.name)) continue;

      const absolutePath = join(absoluteDirectory, entry.name);
      if (isExcluded(absolutePath)) continue;

      if (files.length >= maxFiles) {
        truncatedReason = `the repository holds more than ${String(maxFiles)} documentation files`;
        return;
      }

      const scanned = await readDocument(absolutePath, relativePath, maxFileBytes);
      if (scanned.text === null && scanned.problem !== null && scanned.size > maxFileBytes) {
        oversized += 1;
        continue;
      }

      totalBytes += scanned.size;
      if (totalBytes > maxTotalBytes) {
        truncatedReason = `reading this repository's documentation exceeded ${String(maxTotalBytes)} bytes`;
        return;
      }

      files.push(scanned);
    }
  };

  await walk('', 1);

  return {
    files,
    truncated: truncatedReason !== null,
    truncatedReason,
    oversized,
  };
}

export function isDocumentFile(name: string): boolean {
  const lower = name.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function readDocument(
  absolutePath: string,
  relativePath: string,
  maxFileBytes: number,
): Promise<ScannedDocument> {
  try {
    const stats = await stat(absolutePath);
    if (stats.size > maxFileBytes) {
      return {
        relativePath,
        absolutePath,
        mtime: stats.mtime,
        size: stats.size,
        text: null,
        problem: `file is larger than ${String(maxFileBytes)} bytes and was not read`,
      };
    }

    return {
      relativePath,
      absolutePath,
      mtime: stats.mtime,
      size: stats.size,
      text: await readTextFile(absolutePath),
      problem: null,
    };
  } catch (error) {
    return {
      relativePath,
      absolutePath,
      mtime: new Date(0),
      size: 0,
      text: null,
      problem: errorCode(error) ?? String(error),
    };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Is `child` inside `parent`? Cross-platform, and case-insensitive where the platform is.
 *
 * `path.relative` does the case folding win32 needs and the byte comparison posix needs, which
 * is why this is not a `startsWith` on two resolved strings — `D:\Repos\MCS` and
 * `d:\repos\mcs\docs` are the same directory on the development machine and different strings.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !/^[a-zA-Z]:[\\/]/.test(rel);
}

// ------------------------------------------------------------------------------- the stage

export interface DocumentStageOptions {
  readonly db: Db;
  readonly embedder: EmbeddingPort;
  readonly store: VectorStorePort;
  readonly stamp: EmbeddingStamp;
  readonly budget: ChunkBudget;
  readonly now?: (() => Date) | undefined;
  readonly bounds?: DocumentScanBounds | undefined;
}

export interface DocumentStageResult {
  readonly repositories: number;
  /** Repositories skipped because their `local_path` is not on this machine. */
  readonly repositoriesMissing: number;
  readonly seen: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly embedded: number;
  readonly purged: number;
  /** Files above `maxFileBytes`, counted rather than silently dropped. */
  readonly oversized: number;
  readonly failures: number;
  readonly lastError: string | null;
  /** Set when a dependency failed — the caller fails the run rather than continuing. */
  readonly halt: string | null;
}

const EMPTY: DocumentStageResult = {
  repositories: 0,
  repositoriesMissing: 0,
  seen: 0,
  indexed: 0,
  skipped: 0,
  embedded: 0,
  purged: 0,
  oversized: 0,
  failures: 0,
  lastError: null,
  halt: null,
};

export async function indexRepositoryDocuments(
  options: DocumentStageOptions,
): Promise<DocumentStageResult> {
  const maxRepositories = options.bounds?.maxRepositories ?? MAX_DOCUMENT_REPOSITORIES;

  const repositories = await listDocumentRepositories(options.db, maxRepositories);
  const scopes = await listRepositoryScopes(options.db);
  const allRepositoryIds = new Set(scopes.map((scope) => scope.id));
  const assignedRepositoryIds = new Set(
    scopes.filter((scope) => scope.projectId !== null).map((scope) => scope.id),
  );

  // The vault is read once, not per repository: it is one setting, and re-reading it per
  // repository would let it change halfway through a stage.
  const vaultPath = (await readObsidianSettings(options.db)).vaultPath?.trim() ?? '';
  const excludeVault =
    vaultPath.length === 0
      ? () => false
      : (absolutePath: string): boolean => isInside(vaultPath, absolutePath);

  // Absolute paths already indexed in this stage — the "one checkout inside another" dedupe.
  const claimed = new Set<string>();
  const presentByRepository = new Map<string, Set<string>>();
  const scannedRepositoryIds = new Set<string>();

  let result: DocumentStageResult = { ...EMPTY };
  const deadline =
    (options.bounds?.now?.() ?? Date.now()) +
    (options.bounds?.deadlineMs ?? DOCUMENT_SCAN_DEADLINE_MS);

  for (const repository of repositories) {
    // The stage-wide deadline. Repositories not reached are neither scanned nor purged.
    if ((options.bounds?.now?.() ?? Date.now()) > deadline) break;

    const root = resolve(repository.localPath);
    if (!(await isReadableDirectory(root))) {
      result = { ...result, repositoriesMissing: result.repositoriesMissing + 1 };
      continue;
    }
    // A repository that *is* the vault (or lives inside it) is the vault's, whole.
    if (vaultPath.length > 0 && isInside(vaultPath, root)) {
      result = { ...result, repositoriesMissing: result.repositoriesMissing + 1 };
      continue;
    }

    const scan = await scanRepositoryDocuments(
      root,
      {
        ...(options.bounds ?? {}),
        // Whatever is left of the stage deadline, so one enormous repository cannot consume a
        // budget the ones after it need.
        deadlineMs: Math.max(0, deadline - (options.bounds?.now?.() ?? Date.now())),
      },
      excludeVault,
    );

    result = {
      ...result,
      repositories: result.repositories + 1,
      oversized: result.oversized + scan.oversized,
    };

    const present = new Set<string>();
    for (const file of scan.files) {
      if (file.text === null) {
        result = {
          ...result,
          seen: result.seen + 1,
          failures: file.problem === null ? result.failures : result.failures + 1,
          lastError: file.problem ?? result.lastError,
        };
        continue;
      }
      if (claimed.has(file.absolutePath.toLowerCase())) continue;
      claimed.add(file.absolutePath.toLowerCase());

      const outcome = await indexSource({
        db: options.db,
        embedder: options.embedder,
        store: options.store,
        stamp: options.stamp,
        budget: options.budget,
        projection: projectDocument({
          repositoryId: repository.id,
          projectId: repository.projectId,
          relativePath: file.relativePath,
          body: parseFrontMatter(file.text).body,
          mtime: file.mtime,
        }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      present.add(documentSourceRef(repository.id, file.relativePath));
      result = { ...result, seen: result.seen + 1 };

      switch (outcome.kind) {
        case 'indexed':
          result = {
            ...result,
            indexed: result.indexed + 1,
            embedded: result.embedded + outcome.embedded,
          };
          break;
        case 'skipped':
          result = { ...result, skipped: result.skipped + 1 };
          break;
        default:
          // A dependency failure repeats for every remaining file; stop and let the run fail
          // with a reason rather than accumulating five hundred identical errors.
          return {
            ...result,
            failures: result.failures + 1,
            lastError: outcome.reason,
            halt: outcome.reason,
          };
      }
    }

    // A truncated repository proves nothing about what is absent from it, so it is excluded
    // from the purge — the same rule `notes.ts` applies to a truncated vault scan.
    if (!scan.truncated) {
      scannedRepositoryIds.add(repository.id);
      presentByRepository.set(repository.id, present);
    }
  }

  const purged = await purgeVanishedDocuments(options, {
    allRepositoryIds,
    assignedRepositoryIds,
    scannedRepositoryIds,
    presentByRepository,
  });

  return { ...result, purged };
}

async function isReadableDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Forget documents that are no longer documents of an indexable repository.
 *
 * Three rules, and the split between them is the whole of the "absent is normal" design:
 *
 *  1. The repository row is **gone** — purge. A database fact.
 *  2. The repository is **unassigned from its Project** — purge. Also a database fact, and its
 *     rows are `project`-tier: leaving them would keep naming a Project this repository is no
 *     longer part of.
 *  3. The repository was **scanned completely** and the file was not in it — purge. This is the
 *     only rule that depends on the filesystem, and it is applied only to repositories whose
 *     scan was neither truncated, nor skipped for a missing path, nor beyond the run's
 *     repository cap.
 */
async function purgeVanishedDocuments(
  options: DocumentStageOptions,
  sets: {
    readonly allRepositoryIds: ReadonlySet<string>;
    readonly assignedRepositoryIds: ReadonlySet<string>;
    readonly scannedRepositoryIds: ReadonlySet<string>;
    readonly presentByRepository: ReadonlyMap<string, ReadonlySet<string>>;
  },
): Promise<number> {
  const refs = await listSourceRefs(options.db, 'document');
  let purged = 0;

  for (const ref of refs) {
    const parsed = parseDocumentSourceRef(ref);
    // A ref this build did not write — an older shape, a hand edit. Left alone rather than
    // deleted on a guess about a repository id we did not recognise.
    if (parsed === null) continue;

    const stale =
      !sets.allRepositoryIds.has(parsed.repositoryId) ||
      !sets.assignedRepositoryIds.has(parsed.repositoryId) ||
      (sets.scannedRepositoryIds.has(parsed.repositoryId) &&
        sets.presentByRepository.get(parsed.repositoryId)?.has(ref) !== true);

    if (!stale) continue;

    const result = await purgeSource({
      db: options.db,
      store: options.store,
      key: { sourceType: 'document', sourceId: null, sourceRef: ref },
    });
    purged += result.deleted;
  }

  return purged;
}
