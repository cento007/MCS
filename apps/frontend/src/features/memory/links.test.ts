import { describe, expect, it } from 'vitest';
import { chunkLabel, resultLink, sourceTypeLabel } from './links.js';
import {
  ADR_ID,
  COMMIT_ID,
  makeResult,
  PR_ID,
  PROJECT_ID,
  REPOSITORY_ID,
  SESSION_ID,
} from './test-support.js';

/**
 * Reaching the thing that matched.
 *
 * Three of the six source types have no route of their own — commits and pull requests are
 * rendered under a Repository under a Project, and file-backed sources live in a vault. The claim
 * under test is that **every result is either genuinely reachable or says why it is not**, and
 * that a link which lands one level away never claims to be the match itself.
 */

describe('sources with a route of their own', () => {
  it('reaches a session from its own id', () => {
    const link = resultLink(
      makeResult({
        sourceType: 'session',
        sourceId: SESSION_ID,
        context: { projectId: PROJECT_ID, repositoryId: null, sessionId: SESSION_ID },
      }),
    );
    expect(link).toEqual({ to: `/sessions/${SESSION_ID}`, label: 'Open session', reason: null });
  });

  it('reaches an ADR', () => {
    const link = resultLink(makeResult({ sourceType: 'adr', sourceId: ADR_ID }));
    expect(link.to).toBe(`/adrs/${ADR_ID}`);
    expect(link.reason).toBeNull();
  });
});

describe('commits, which have no route', () => {
  it('reaches the session panel that lists the commit when it is attributed', () => {
    // Exact, not approximate: the Session's Commits panel renders this commit, and `?panel=` is
    // how that panel is linked.
    const link = resultLink(
      makeResult({
        sourceType: 'commit',
        sourceId: COMMIT_ID,
        context: { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, sessionId: SESSION_ID },
      }),
    );
    expect(link.to).toBe(`/sessions/${SESSION_ID}?panel=commits`);
    expect(link.reason).toBeNull();
  });

  it('falls back to the project’s repositories and says the link is one level away', () => {
    const link = resultLink(
      makeResult({
        sourceType: 'commit',
        sourceId: COMMIT_ID,
        context: { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, sessionId: null },
      }),
    );
    expect(link.to).toBe(`/projects/${PROJECT_ID}?tab=repositories`);
    // The label names the destination, never the match: "Open commit" would promise a page that
    // does not exist.
    expect(link.label).not.toContain('commit');
    expect(link.reason).toContain('no route for a single commit');
  });

  it('offers no link at all when the commit has no project', () => {
    const link = resultLink(
      makeResult({
        sourceType: 'commit',
        sourceId: COMMIT_ID,
        context: { projectId: null, repositoryId: null, sessionId: null },
      }),
    );
    expect(link.to).toBeNull();
    expect(link.reason).not.toBeNull();
  });
});

describe('pull requests, whose read route is specified but unbuilt', () => {
  it('reaches the repository and states that the PR screen does not exist yet', () => {
    const link = resultLink(
      makeResult({
        sourceType: 'pull_request',
        sourceId: PR_ID,
        context: { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, sessionId: null },
      }),
    );
    expect(link.to).toBe(`/projects/${PROJECT_ID}?tab=repositories`);
    expect(link.reason).toContain('pull-requests');
  });
});

describe('file-backed sources, which live outside the app', () => {
  it('has no link and explains that, rather than offering a dead click', () => {
    const link = resultLink(
      makeResult({
        sourceType: 'obsidian_note',
        sourceId: null,
        sourceRef: 'Decisions/queue.md',
        tier: 'global',
        context: { projectId: null, repositoryId: null, sessionId: null },
      }),
    );
    expect(link.to).toBeNull();
    expect(link.reason).toContain('Obsidian vault');
  });
});

describe('labels', () => {
  it('spells the vocabulary for people without inventing new names', () => {
    expect(sourceTypeLabel('pull_request')).toBe('Pull request');
    expect(sourceTypeLabel('obsidian_note')).toBe('Obsidian note');
    // An unknown source type from a newer Backend degrades to its own token rather than crashing.
    expect(sourceTypeLabel('something_new')).toBe('something_new');
  });

  it('names the chunk only when a document has more than one', () => {
    expect(chunkLabel(makeResult({ chunkOrdinal: 0, chunkCount: 1 }))).toBeNull();
    expect(chunkLabel(makeResult({ chunkOrdinal: 3, chunkCount: 9 }))).toBe('chunk 4 of 9');
  });
});
