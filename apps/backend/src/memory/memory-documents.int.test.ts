import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createFakeEmbedder,
  createInMemoryVectorStore,
  documentSourceRef,
  type FakeEmbeddingPort,
  type InMemoryVectorStore,
  newId,
  schema,
  settingKey,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  seedProject,
  seedUser,
  setSetting,
  type TestApp,
  testDatabase,
  testWorkingDirectory,
  truncateAll,
} from '../../test/integration/harness.js';
import { indexRepositoryDocuments } from './documents.js';

/**
 * PRD §6.3's sixth source, end to end against real PostgreSQL and a real filesystem.
 *
 * What only this tier can prove:
 *
 *  - a documentation file becomes a **`project`-tier row that the database accepts** — the tier
 *    and its scope columns have to satisfy `ck_memory_items_tier_scope`, which no unit test of a
 *    pure projection can demonstrate;
 *  - **idempotence**: a second run over unchanged files makes zero embedding calls, and an
 *    edited file re-embeds only itself;
 *  - **deletion sticks**, in both stores, for a file that was removed, a repository that was
 *    deleted, and a repository that lost its Project;
 *  - the **vault precedence** actually holds, with a real vault path pointing at a real
 *    directory inside a real repository — the situation that motivated the rule.
 *
 * Fixtures are built under the OS temp root (`testWorkingDirectory`), never in this repository:
 * a test that scanned `D:\Repos\MCS` would index the very file it lives in and would behave
 * differently on every machine.
 */

const MODEL = 'nomic-embed-text';
const DIMENSION = 768;

let embedder: FakeEmbeddingPort;
let store: InMemoryVectorStore;
let embedBaseline = 0;

function chunksEmbedded(): number {
  return embedder.calls.reduce((total, batch) => total + batch.length, 0) - embedBaseline;
}

function markEmbedBaseline(): void {
  embedBaseline = embedder.calls.reduce((total, batch) => total + batch.length, 0);
}

async function configuredApp(): Promise<TestApp> {
  await setSetting('integrations', settingKey('integrations.qdrant.embeddingModel'), MODEL);
  embedder = createFakeEmbedder({ model: MODEL, dimension: DIMENSION, recordCalls: true });
  store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
  embedBaseline = 0;
  return createTestApp({ memoryClients: () => ({ embedder, store }) });
}

/** A repository working tree on disk, with a row pointing at it. */
async function seedWorkingTree(
  projectId: string | null,
  files: Record<string, string>,
): Promise<{ repositoryId: string; root: string }> {
  const root = testWorkingDirectory();
  writeFiles(root, files);

  const rows = await testDatabase()
    .db.insert(schema.repositories)
    .values({
      id: newId(),
      ...(projectId === null ? {} : { projectId }),
      name: 'fixture',
      localPath: root,
    })
    .returning({ id: schema.repositories.id });

  return { repositoryId: rows[0]?.id ?? '', root };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, ...relativePath.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** Run the documentation stage against a ready runtime. */
async function runStage(app: TestApp) {
  const state = await app.memory.runtime.ready();
  if (state.kind !== 'ready') throw new Error(`runtime not ready: ${state.kind}`);
  return indexRepositoryDocuments({
    db: testDatabase().db,
    embedder: state.embedder,
    store: state.store,
    stamp: state.stamp,
    budget: state.budget,
  });
}

async function documentRows() {
  return testDatabase()
    .db.select()
    .from(schema.memoryItems)
    .where(eq(schema.memoryItems.sourceType, 'document'))
    .orderBy(schema.memoryItems.sourceRef, schema.memoryItems.chunkOrdinal);
}

const PROSE = '# Deployment\n\nUnit files live in deploy/systemd and are never imported.\n';

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await truncateAll();
});

describe('indexing repository documentation', () => {
  it('writes project-tier rows the database accepts, keyed by repository and path', async () => {
    const { projectId } = await seedProject();
    const { repositoryId } = await seedWorkingTree(projectId, {
      'README.md': '# Mission Control\n\nA self-hosted command center.\n',
      'docs/deployment.md': PROSE,
      'src/app.ts': 'export const x = 1;\n',
      'node_modules/pkg/README.md': '# never indexed\n',
    });

    const app = await configuredApp();
    const result = await runStage(app);

    expect(result.repositories).toBe(1);
    expect(result.indexed).toBe(2);

    const rows = await documentRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      // `project` requires exactly this scope combination; the CHECK is the authority.
      expect(row.tier).toBe('project');
      expect(row.projectId).toBe(projectId);
      expect(row.sessionId).toBeNull();
      expect(row.sourceId).toBeNull();
      expect(row.sourceRef?.startsWith(`${repositoryId}/`)).toBe(true);
      expect(row.indexedAt).not.toBeNull();
    }

    const refs = new Set(rows.map((row) => row.sourceRef));
    expect(refs.has(documentSourceRef(repositoryId, 'README.md'))).toBe(true);
    expect(refs.has(documentSourceRef(repositoryId, 'docs/deployment.md'))).toBe(true);
    // The rule, proved rather than described: source-adjacent and vendored Markdown is not
    // documentation.
    expect([...refs].some((ref) => ref?.includes('node_modules'))).toBe(false);
    expect([...refs].some((ref) => ref?.includes('src/'))).toBe(false);

    // Both stores agree.
    expect(store.points).toHaveLength(rows.length);
  });

  it('RE-RUNNING OVER UNCHANGED FILES MAKES ZERO EMBEDDING CALLS', async () => {
    const { projectId } = await seedProject();
    await seedWorkingTree(projectId, { 'docs/a.md': PROSE, 'docs/b.md': PROSE.repeat(4) });

    const app = await configuredApp();
    await runStage(app);
    expect(chunksEmbedded()).toBeGreaterThan(0);
    const before = await documentRows();

    markEmbedBaseline();
    await runStage(app);

    expect(chunksEmbedded()).toBe(0);
    // Nothing was rewritten either — the skip happened before the write.
    expect((await documentRows()).map((row) => row.updatedAt.toISOString())).toEqual(
      before.map((row) => row.updatedAt.toISOString()),
    );
  });

  it('re-embeds only the file that changed', async () => {
    const { projectId } = await seedProject();
    const { root } = await seedWorkingTree(projectId, {
      'docs/stable.md': PROSE,
      'docs/edited.md': PROSE,
    });

    const app = await configuredApp();
    await runStage(app);
    const first = await documentRows();

    markEmbedBaseline();
    writeFiles(root, { 'docs/edited.md': '# Edited\n\nA completely different paragraph now.\n' });
    await runStage(app);

    expect(chunksEmbedded()).toBeGreaterThan(0);
    expect(chunksEmbedded()).toBeLessThan(first.length);
  });

  it('PURGES A DELETED FILE FROM BOTH STORES', async () => {
    const { projectId } = await seedProject();
    const { root, repositoryId } = await seedWorkingTree(projectId, {
      'docs/kept.md': PROSE,
      'docs/removed.md': PROSE,
    });

    const app = await configuredApp();
    await runStage(app);
    expect(await documentRows()).not.toHaveLength(0);

    rmSync(join(root, 'docs', 'removed.md'));
    const result = await runStage(app);

    expect(result.purged).toBeGreaterThan(0);
    const refs = new Set((await documentRows()).map((row) => row.sourceRef));
    expect(refs.has(documentSourceRef(repositoryId, 'docs/removed.md'))).toBe(false);
    expect(refs.has(documentSourceRef(repositoryId, 'docs/kept.md'))).toBe(true);
    expect(store.points).toHaveLength((await documentRows()).length);
  });

  it('purges the documents of a repository row that has been deleted', async () => {
    const { projectId } = await seedProject();
    const { repositoryId } = await seedWorkingTree(projectId, { 'docs/a.md': PROSE });

    const app = await configuredApp();
    await runStage(app);
    expect(await documentRows()).not.toHaveLength(0);

    // `source_ref` carries no FK, so nothing cascades — this sweep is the only thing that
    // clears them.
    await testDatabase()
      .db.delete(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId));
    await runStage(app);

    expect(await documentRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });

  it('purges the documents of a repository that lost its Project', async () => {
    const { projectId } = await seedProject();
    const { repositoryId } = await seedWorkingTree(projectId, { 'docs/a.md': PROSE });

    const app = await configuredApp();
    await runStage(app);
    expect(await documentRows()).not.toHaveLength(0);

    // The rows are `project`-tier. Left behind, they would keep naming a Project the repository
    // is no longer part of.
    await testDatabase()
      .db.update(schema.repositories)
      .set({ projectId: null })
      .where(eq(schema.repositories.id, repositoryId));
    await runStage(app);

    expect(await documentRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });

  it('does not index a repository that has no Project — its scope is undecided, not global', async () => {
    await seedWorkingTree(null, { 'docs/a.md': PROSE, 'README.md': PROSE });

    const app = await configuredApp();
    const result = await runStage(app);

    expect(result.repositories).toBe(0);
    expect(await documentRows()).toEqual([]);
  });

  it('A PATH THAT IS NOT ON THIS MACHINE IS NORMAL — skipped, and never purged', async () => {
    const { projectId } = await seedProject();
    const { root, repositoryId } = await seedWorkingTree(projectId, { 'docs/a.md': PROSE });

    const app = await configuredApp();
    await runStage(app);
    const before = await documentRows();
    expect(before).not.toHaveLength(0);

    // The checkout moves, or its drive is unplugged. "The scan did not see it" is not "it is
    // gone", and only one of those justifies deleting an operator's embeddings.
    rmSync(root, { recursive: true, force: true });
    const result = await runStage(app);

    expect(result.repositoriesMissing).toBe(1);
    expect(result.purged).toBe(0);
    expect(await documentRows()).toHaveLength(before.length);
    expect(
      (await documentRows()).every((row) => row.sourceRef?.startsWith(`${repositoryId}/`)),
    ).toBe(true);
  });
});

describe('overlap with the Obsidian vault', () => {
  it('DOES NOT INDEX A FILE INSIDE THE CONFIGURED VAULT — the vault wins', async () => {
    const { projectId } = await seedProject();
    const { root, repositoryId } = await seedWorkingTree(projectId, {
      'README.md': PROSE,
      'docs/tds/01-foundation.md': PROSE,
    });

    // The exact situation that motivated the rule: an operator points the vault at a
    // repository's `docs/` directory to get a corpus.
    await setSetting(
      'integrations',
      settingKey('integrations.obsidian.vaultPath'),
      join(root, 'docs'),
    );

    const app = await configuredApp();
    await runStage(app);

    const refs = new Set((await documentRows()).map((row) => row.sourceRef));
    // The root README is outside the vault and is still a document.
    expect(refs.has(documentSourceRef(repositoryId, 'README.md'))).toBe(true);
    // Everything under the vault is the note stage's, and is not indexed twice.
    expect(refs.has(documentSourceRef(repositoryId, 'docs/tds/01-foundation.md'))).toBe(false);
  });

  it('skips a repository that is itself inside the vault, whole', async () => {
    const { projectId } = await seedProject();
    const { root } = await seedWorkingTree(projectId, { 'README.md': PROSE, 'docs/a.md': PROSE });
    await setSetting('integrations', settingKey('integrations.obsidian.vaultPath'), root);

    const app = await configuredApp();
    const result = await runStage(app);

    expect(result.repositories).toBe(0);
    expect(await documentRows()).toEqual([]);
  });
});

describe('the backfill wiring', () => {
  it('runs the documentation stage as part of a backfill and records it on the run', async () => {
    const { projectId } = await seedProject();
    await seedWorkingTree(projectId, { 'docs/a.md': PROSE });
    await seedUser();

    const app = await configuredApp();
    const run = await app.memory.indexing.trigger({ mode: 'incremental' });
    for (let slice = 0; slice < 40; slice += 1) {
      await app.memory.indexing.handle({ kind: 'backfill', runId: run.id });
      const status = await app.memory.indexing.status();
      if (status.state === 'completed' || status.state === 'failed') break;
    }

    const status = await app.memory.indexing.status();
    expect(status.state).toBe('completed');
    expect(status.progress?.documentsDone).toBe(true);
    expect(status.progress?.failures).toBe(0);
    expect(await documentRows()).not.toHaveLength(0);
  });
});
