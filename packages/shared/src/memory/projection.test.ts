import { describe, expect, it } from 'vitest';
import {
  adrLabel,
  documentSourceRef,
  MAX_PROJECTED_COMMIT_FILES,
  parseDocumentSourceRef,
  projectAdr,
  projectCommit,
  projectDocument,
  projectNote,
  projectPullRequest,
  projectSession,
} from './projection.js';

/**
 * The projections — what text stands for an entity.
 *
 * These are the cheapest tests in the memory layer and the most consequential: a projection that
 * drops the changed paths off a commit, or folds tool output into a session, produces an index
 * that is *populated and wrong*, which no downstream test can detect.
 *
 * They are also the reason the projections are pure. Every case here is rows in, string out.
 */

const AT = new Date('2026-08-13T10:00:00.000Z');

describe('projectSession', () => {
  const base = {
    sessionId: '018f6b2e-1111-7abc-8def-0123456789ab',
    projectId: '018f6b2e-2222-7abc-8def-0123456789ab',
    title: 'Adopt pg-boss for the job queue',
    occurredAt: AT,
  };

  it('scopes to the session tier while still carrying the project', () => {
    const projection = projectSession({ ...base, turns: [{ role: 'user', content: 'hello' }] });

    expect(projection.tier).toBe('session');
    expect(projection.sessionId).toBe(base.sessionId);
    // Denormalized so "everything this project remembers" needs no join — `memory_items` header.
    expect(projection.projectId).toBe(base.projectId);
  });

  it('leads with the title and labels every turn by role', () => {
    const projection = projectSession({
      ...base,
      turns: [
        { role: 'user', content: 'Should we use Redis?' },
        { role: 'assistant', content: 'No — no native Windows build.' },
      ],
    });

    expect(projection.text).toBe(
      'Adopt pg-boss for the job queue\n\n' +
        'user: Should we use Redis?\n\n' +
        'assistant: No — no native Windows build.',
    );
  });

  it('drops blank turns rather than embedding a bare role label', () => {
    const projection = projectSession({
      ...base,
      turns: [
        { role: 'user', content: '   ' },
        { role: 'assistant', content: 'answer' },
      ],
    });
    expect(projection.text).not.toContain('user:');
  });

  it('produces nothing for a session with no title and no turns', () => {
    expect(projectSession({ ...base, title: null, turns: [] }).text).toBe('');
  });

  it('names an untitled session so a hit is still listable', () => {
    const projection = projectSession({
      ...base,
      title: null,
      turns: [{ role: 'user', content: 'x' }],
    });
    expect(projection.title).toBe('Untitled session');
  });
});

describe('projectCommit', () => {
  const base = {
    commitId: '018f6b2e-3333-7abc-8def-0123456789ab',
    projectId: '018f6b2e-2222-7abc-8def-0123456789ab',
    sha: '3a70d1d9f4c2b81e5a6d0c7f2b9e1a4d8c3f5601',
    message: 'Close the last Phase 2 gaps\n\nOpenAPI, strict bodies, worker event relay.',
    authorName: 'cento007',
    branch: 'DEV',
    committedAt: AT,
  };

  it('is project-tier even though a commit can be attributed to a session', () => {
    // PRD §6.1 calls project memory "repository-specific"; a commit outlives the conversation
    // that produced it, and session-scoping would hide it from every project-wide question.
    const projection = projectCommit({ ...base, files: [] });
    expect(projection.tier).toBe('project');
    expect(projection.sessionId).toBeNull();
  });

  it('carries the changed paths — "the change to the websocket hub" is a path memory', () => {
    const projection = projectCommit({
      ...base,
      files: [
        { path: 'apps/backend/src/ws/hub.ts', status: 'modified', additions: 4, deletions: 1 },
        { path: 'apps/backend/src/ws/channels.ts', status: 'modified', additions: 9, deletions: 0 },
      ],
    });

    expect(projection.text).toContain(
      'Files: apps/backend/src/ws/hub.ts, apps/backend/src/ws/channels.ts',
    );
  });

  it('omits line stats — noise in a vector, and they churn on every rebase', () => {
    const projection = projectCommit({
      ...base,
      files: [{ path: 'a.ts', status: 'modified', additions: 42, deletions: 13 }],
    });
    expect(projection.text).not.toContain('42');
  });

  it('does NOT project the SHA — 35 junk tokens nobody recalls in prose', () => {
    const projection = projectCommit({ ...base, files: [] });
    expect(projection.text).not.toContain(base.sha);
  });

  it('caps the file list so one merge commit cannot dominate the index', () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      path: `src/file-${String(i)}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));
    const projection = projectCommit({ ...base, files });

    expect(projection.text).toContain(`src/file-${String(MAX_PROJECTED_COMMIT_FILES - 1)}.ts`);
    expect(projection.text).not.toContain(`src/file-${String(MAX_PROJECTED_COMMIT_FILES)}.ts`);
  });

  it('titles by subject line, falling back to the short SHA', () => {
    expect(projectCommit({ ...base, files: [] }).title).toBe('Close the last Phase 2 gaps');
    expect(projectCommit({ ...base, message: '', files: [] }).title).toBe('3a70d1d (no message)');
  });

  it('produces nothing for an empty commit with no files', () => {
    expect(projectCommit({ ...base, message: '  ', files: [] }).text).toBe('');
  });
});

describe('projectAdr', () => {
  const base = {
    adrId: '018f6b2e-4444-7abc-8def-0123456789ab',
    projectId: '018f6b2e-2222-7abc-8def-0123456789ab',
    adrNumber: 7,
    title: 'Use pg-boss instead of Redis',
    status: 'accepted',
    context: 'Redis has no official native Windows build.',
    decision: 'PostgreSQL is the single stateful substrate.',
    alternatives: 'Memurai on Windows; an in-process queue.',
    consequences: 'WS3 vendors the pgboss schema.',
    updatedAt: AT,
  };

  it('keeps the four PRD §7.3 sections separate, under their own headings', () => {
    const text = projectAdr(base).text;

    // Separate headings mean a long ADR chunks along its own section boundaries rather than
    // mid-argument — the reason these are four columns in the first place.
    expect(text).toContain('## Context\nRedis has no official native Windows build.');
    expect(text).toContain('## Decision\nPostgreSQL is the single stateful substrate.');
    expect(text).toContain('## Alternatives\n');
    expect(text).toContain('## Consequences\n');
  });

  it('leads with the label operators actually use', () => {
    expect(projectAdr(base).title).toBe('ADR-0007 — Use pg-boss instead of Redis');
    expect(projectAdr(base).text.startsWith('ADR-0007 — Use pg-boss instead of Redis')).toBe(true);
  });

  it('omits an empty section rather than embedding a bare heading', () => {
    const text = projectAdr({ ...base, alternatives: '', consequences: '   ' }).text;
    expect(text).not.toContain('## Alternatives');
    expect(text).not.toContain('## Consequences');
  });

  it('produces nothing for an ADR that is only a title and a status', () => {
    const text = projectAdr({
      ...base,
      context: '',
      decision: '',
      alternatives: '',
      consequences: '',
    }).text;
    expect(text).toBe('');
  });

  it('formats the label with four digits', () => {
    expect(adrLabel(7)).toBe('ADR-0007');
    expect(adrLabel(1234)).toBe('ADR-1234');
  });
});

describe('projectPullRequest', () => {
  const base = {
    pullRequestId: '018f6b2e-5555-7abc-8def-0123456789ab',
    projectId: '018f6b2e-2222-7abc-8def-0123456789ab',
    number: 42,
    title: 'Fix the relay gap policy',
    description: 'Close every websocket connection so clients refetch.',
    state: 'merged',
    updatedAt: AT,
  };

  it('projects the number, the title and the description', () => {
    const projection = projectPullRequest(base);
    expect(projection.title).toBe('#42 Fix the relay gap policy');
    expect(projection.text).toBe(
      '#42 Fix the relay gap policy\n\nClose every websocket connection so clients refetch.',
    );
  });

  it('still indexes a PR with no description — the title is the memory', () => {
    const projection = projectPullRequest({ ...base, description: null });
    expect(projection.text).toBe('#42 Fix the relay gap policy');
  });
});

describe('projectNote', () => {
  it('is global-tier and addressed by vault-relative path', () => {
    const projection = projectNote({
      vaultPath: 'Ideas/Deployment checklist.md',
      body: 'Check the systemd units first.',
      mtime: AT,
    });

    expect(projection.tier).toBe('global');
    expect(projection.sourceId).toBeNull();
    expect(projection.sourceRef).toBe('Ideas/Deployment checklist.md');
    expect(projection.projectId).toBeNull();
  });

  it('leads with the filename — Obsidian users title by filename', () => {
    const projection = projectNote({
      vaultPath: 'Ideas/Deployment checklist.md',
      body: 'Check the systemd units first.',
      mtime: AT,
    });

    expect(projection.title).toBe('Deployment checklist');
    // Without this, a note called `Deployment checklist.md` is invisible to "deployment".
    expect(projection.text.startsWith('Deployment checklist')).toBe(true);
  });

  it('produces nothing for an empty note', () => {
    expect(projectNote({ vaultPath: 'Empty.md', body: '\n\n', mtime: AT }).text).toBe('');
  });
});

describe('projectDocument — PRD §6.3 "Documentation"', () => {
  const REPOSITORY = '018f6b2e-3333-7abc-8def-0123456789ab';
  const PROJECT = '018f6b2e-4444-7abc-8def-0123456789ab';

  it('is project-tier and carries the Project, so it satisfies ck_memory_items_tier_scope', () => {
    const projection = projectDocument({
      repositoryId: REPOSITORY,
      projectId: PROJECT,
      relativePath: 'docs/tds/03-database-schema.md',
      body: 'Every table has created_at and updated_at.',
      mtime: AT,
    });

    // `project` requires exactly this combination; anything else is a row the database refuses
    // or a memory that is visible to nobody.
    expect(projection.tier).toBe('project');
    expect(projection.projectId).toBe(PROJECT);
    expect(projection.sessionId).toBeNull();
    expect(projection.sourceType).toBe('document');
    expect(projection.sourceId).toBeNull();
  });

  it('leads with the repo-relative path, which is half of what makes a doc findable', () => {
    const projection = projectDocument({
      repositoryId: REPOSITORY,
      projectId: PROJECT,
      relativePath: 'docs/deployment/systemd.md',
      body: 'Unit files live in deploy/systemd.',
      mtime: AT,
    });

    expect(projection.title).toBe('docs/deployment/systemd.md');
    // "deployment" is in the path and not in the body; a bare basename would lose it.
    expect(projection.text.startsWith('docs/deployment/systemd.md')).toBe(true);
    expect(projection.text).toContain('Unit files live in deploy/systemd.');
  });

  it('produces nothing for an empty file, so it is skipped rather than indexed as a title', () => {
    expect(
      projectDocument({
        repositoryId: REPOSITORY,
        projectId: PROJECT,
        relativePath: 'docs/empty.md',
        body: '\n\n  \n',
        mtime: AT,
      }).text,
    ).toBe('');
  });

  it('keys on (repository, path), so two repositories keep their own README', () => {
    const other = '018f6b2e-5555-7abc-8def-0123456789ab';
    expect(documentSourceRef(REPOSITORY, 'README.md')).not.toBe(
      documentSourceRef(other, 'README.md'),
    );
    // Without the repository id, `ux_memory_items_source_ref_chunk` would make the second
    // repository's README overwrite the first's.
    expect(parseDocumentSourceRef(documentSourceRef(REPOSITORY, 'docs/a/b.md'))).toEqual({
      repositoryId: REPOSITORY,
      relativePath: 'docs/a/b.md',
    });
  });

  it('never puts an absolute path in the source ref', () => {
    const projection = projectDocument({
      repositoryId: REPOSITORY,
      projectId: PROJECT,
      relativePath: 'README.md',
      body: 'Hello.',
      mtime: AT,
    });

    // The column's own rule: an absolute path breaks when the repository moves and leaks the
    // operator's directory layout into an API response.
    expect(projection.sourceRef).toBe(`${REPOSITORY}/README.md`);
    expect(projection.sourceRef).not.toMatch(/^[a-zA-Z]:[\\/]/);
    expect(projection.sourceRef?.startsWith('/')).toBe(false);
  });

  it('refuses to parse a ref that is not one of ours', () => {
    // A ref from an older build or a hand edit must not resolve to a repository id we invented,
    // because the purge acts on that id.
    expect(parseDocumentSourceRef('README.md')).toBeNull();
    expect(parseDocumentSourceRef('/leading-slash')).toBeNull();
    expect(parseDocumentSourceRef(`${REPOSITORY}/`)).toBeNull();
  });
});

describe('purity', () => {
  it('projects identically twice — a drifting projection re-embeds the whole corpus', () => {
    const input = {
      sessionId: '018f6b2e-1111-7abc-8def-0123456789ab',
      projectId: '018f6b2e-2222-7abc-8def-0123456789ab',
      title: 'x',
      turns: [{ role: 'user', content: 'y' }],
      occurredAt: AT,
    };
    expect(projectSession(input)).toEqual(projectSession(input));
  });
});
