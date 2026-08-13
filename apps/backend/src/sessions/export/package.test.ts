import { parseNote } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import type { EmptyReason, MemorySearchResponse, MemorySearchResult } from '../../memory/index.js';
import type { SessionFilesReadModel } from '../files.js';
import type { CommitRead, PromptRead } from './evidence.js';
import {
  type ContextPackageInput,
  type PackageWorkingTree,
  type RelatedContext,
  renderContextPackage,
} from './package.js';
import type { ExportSessionFacts } from './render.js';
import { toRelatedContext } from './service.js';

/**
 * The Context package, rendered from fixtures, plus the pure half of its one outbound edge.
 *
 * Two claims carry the feature and both are tested here, with no database and no network:
 *
 *   1. **Nothing is invented.** Every section with no source says it has no source; none of them
 *      is filled with a plausible sentence.
 *   2. **A degraded memory layer is named, never omitted.** Six retrieval outcomes and a
 *      timeout, each producing a warning callout with a reason and an action — because a package
 *      that silently lacks half its content looks complete and is not.
 */

const SESSION_ID = '0199a3f1-2b4c-7def-8012-3456789abcde';
const OTHER_SESSION_ID = '0199a3f1-9999-7def-8012-3456789abcde';

function facts(overrides: Partial<ExportSessionFacts> = {}): ExportSessionFacts {
  return {
    id: SESSION_ID,
    title: 'Fix the login redirect',
    projectId: '0199a3f1-0000-7def-8012-3456789abcde',
    projectName: 'Mission Control',
    repositoryName: 'MCS',
    state: 'failed',
    sessionType: 'managed',
    runtime: 'claude_code',
    runtimeSessionId: null,
    runtimeVersion: null,
    model: 'claude-opus-4',
    machine: null,
    environment: null,
    branch: 'DEV',
    workingDir: 'D:\\Repos\\MCS',
    notes: null,
    failureReason: 'backend_restart',
    totalCostUsd: '0.412300',
    numTurns: 7,
    durationMs: 185_000,
    resumedFromSessionId: null,
    lineageKind: null,
    createdAt: new Date('2026-08-13T09:00:00.000Z'),
    startedAt: new Date('2026-08-13T09:01:00.000Z'),
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

const NO_PROMPTS: PromptRead = { head: [], tail: [], omitted: 0, total: 0 };

const NO_FILES: SessionFilesReadModel = {
  root: 'D:\\Repos\\MCS',
  files: [],
  totalFiles: 0,
  truncated: false,
  commitsAsOf: null,
  completeness: 'complete',
  completenessReason: null,
};

const NO_RELATED: RelatedContext = {
  query: 'Fix the login redirect',
  items: [],
  gap: { reason: 'index_empty', detail: 'Nothing is indexed for this scope yet.' },
  embeddingModel: 'nomic-embed-text',
  minScore: 0.52,
  ownChunksDropped: 0,
};

function render(overrides: Partial<ContextPackageInput> = {}): string {
  return renderContextPackage({
    session: facts(),
    prompts: NO_PROMPTS,
    finalMessage: null,
    files: NO_FILES,
    commits: { commits: [], total: 0 } satisfies CommitRead,
    adrs: [],
    tools: [],
    workingTree: null,
    related: NO_RELATED,
    generatedAt: new Date('2026-08-13T10:00:00.000Z'),
    ...overrides,
  });
}

function sections(content: string): string[] {
  return parseNote(content).sections.map((section) => section.heading);
}

function body(content: string, heading: string): string {
  return (
    parseNote(content)
      .sections.find((section) => section.heading === heading)
      ?.lines.join('\n') ?? ''
  );
}

describe('the shape of the package', () => {
  it('has the nine content sections plus the omissions list, in order', () => {
    expect(sections(render())).toEqual([
      'How to read this',
      'Where this left off',
      'What was asked',
      'Where it stopped',
      'Working tree, as of now',
      'Files this session touched',
      'Commits',
      'Decisions already recorded',
      'Related context from other work',
      'What this package does not contain',
    ]);
  });

  it('does not contain the transcript, and says that it does not', () => {
    const content = render();
    expect(body(content, 'What this package does not contain')).toContain('**The transcript.**');
    expect(content).toContain('does not call a model, so writing one would be invention');
  });

  it('carries front matter the vault sync engine will not claim', () => {
    const keys = parseNote(render()).frontMatter?.entries.map((entry) => entry.key) ?? [];
    expect(keys).toContain('mcSessionId');
    expect(keys).not.toContain('mcId');
    expect(keys).not.toContain('mcType');
  });
});

describe('nothing is invented when a source is empty', () => {
  const content = render();

  it('names the absence in every empty section', () => {
    expect(body(content, 'What was asked')).toBe('_This session recorded no operator prompts._');
    expect(body(content, 'Where it stopped')).toBe('_This session recorded no assistant message._');
    expect(body(content, 'Files this session touched')).toBe(
      '_This session touched no files that Mission Control recorded._',
    );
    expect(body(content, 'Commits')).toBe('_No commits are attributed to this session._');
    expect(body(content, 'Decisions already recorded')).toBe(
      '_No ADR has been recorded from this session._',
    );
  });

  it('distinguishes "no Repository" from "git could not be read"', () => {
    expect(body(content, 'Working tree, as of now')).toContain('names no Repository');
  });

  it('reports the failure reason it has rather than describing the failure', () => {
    expect(body(content, 'Where this left off')).toContain('- **Failure reason:** backend_restart');
  });
});

describe('the prompt window', () => {
  it('renders every prompt in order when the session is short', () => {
    const content = render({
      prompts: { head: [], tail: ['first ask', 'second ask'], omitted: 0, total: 2 },
    });

    const asked = body(content, 'What was asked');
    expect(asked).toBe('> first ask\n\n> second ask');
  });

  it('keeps the opening and the most recent, and counts what fell between', () => {
    const content = render({
      prompts: {
        head: ['the original goal'],
        tail: ['the latest thread'],
        omitted: 40,
        total: 42,
      },
    });

    const asked = body(content, 'What was asked');
    expect(asked).toContain('> the original goal');
    expect(asked).toContain('> the latest thread');
    // The count is the honesty: a window that hid its own middle would misrepresent the session.
    expect(asked).toContain('_40 prompt(s) between the opening and the most recent are not');
    expect(body(content, 'What this package does not contain')).toContain(
      '**40 operator prompt(s)** from the middle of the session',
    );
  });
});

describe('the final assistant message', () => {
  it('is labelled as the last thing said, never as a summary', () => {
    const content = render({
      finalMessage: {
        content: 'I have changed the redirect but have not run the tests.',
        occurredAt: new Date('2026-08-13T09:03:00.000Z'),
      },
    });

    const stopped = body(content, 'Where it stopped');
    expect(stopped).toContain('_The last thing the assistant said');
    expect(stopped).toContain('It is not a summary of the session and may stop mid-thought._');
    expect(stopped).toContain('I have changed the redirect but have not run the tests.');
  });

  it('closes an unterminated fence so the rest of the package survives', () => {
    const content = render({
      finalMessage: {
        content: 'Patch:\n\n```diff\n- a\n+ b',
        occurredAt: new Date('2026-08-13T09:03:00.000Z'),
      },
    });

    expect(content).toContain('_[an unterminated code fence was closed here]_');
    expect(sections(content)).toContain('What this package does not contain');
  });
});

describe('the working tree', () => {
  const tree = (overrides: Partial<PackageWorkingTree>): PackageWorkingTree => ({
    localPath: 'D:\\Repos\\MCS',
    currentBranch: 'DEV',
    detachedHead: false,
    headSha: 'abc1234def5678',
    uncommittedFiles: 12,
    ahead: 2,
    behind: 0,
    unavailableReason: null,
    detail: null,
    checkedAt: new Date('2026-08-13T10:00:00.000Z'),
    ...overrides,
  });

  it('reports the uncommitted count — the fact no transcript can carry', () => {
    const read = body(render({ workingTree: tree({}) }), 'Working tree, as of now');

    expect(read).toContain('- **Branch:** DEV');
    expect(read).toContain('- **Uncommitted entries:** 12');
    expect(read).toContain('- **Ahead of upstream:** 2');
    expect(read).toContain('true at that instant and no longer');
  });

  it('reports git\u2019s own reason when the tree could not be read, and invents none', () => {
    const read = body(
      render({
        workingTree: tree({
          unavailableReason: 'not_a_git_repository',
          detail: 'fatal: not a git repository',
        }),
      }),
      'Working tree, as of now',
    );

    expect(read).toContain('- **Could not be read:** not_a_git_repository');
    expect(read).toContain('fatal: not a git repository');
    expect(read).not.toContain('Uncommitted entries');
  });
});

describe('ADRs are pointed at, not copied', () => {
  it('lists number, title and status and says to read the real one', () => {
    const content = render({
      adrs: [
        {
          adrNumber: 7,
          title: 'Use pg-boss for the job queue',
          status: 'accepted',
          updatedAt: new Date('2026-08-12T10:00:00.000Z'),
        },
      ],
    });

    const decisions = body(content, 'Decisions already recorded');
    expect(decisions).toContain('**ADR-0007** — Use pg-boss for the job queue (`accepted`');
    expect(decisions).toContain('only the pointer is here');
    expect(body(content, 'What this package does not contain')).toContain(
      '**The bodies of the ADRs listed above**',
    );
  });
});

// ------------------------------------------------------------------ the honesty requirement

function result(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    memoryItemId: '0199a3f1-1111-7def-8012-3456789abcde',
    score: 0.71,
    tier: 'project',
    sourceType: 'adr',
    sourceId: null,
    sourceRef: null,
    title: 'ADR-0007 — Use pg-boss',
    content: 'Redis has no official native Windows build, so the queue is pg-boss on PostgreSQL.',
    chunkOrdinal: 1,
    chunkCount: 4,
    occurredAt: '2026-08-12T10:00:00.000Z',
    context: { projectId: null, repositoryId: null, sessionId: null },
    ...overrides,
  };
}

function response(overrides: Partial<MemorySearchResponse> = {}): MemorySearchResponse {
  return {
    results: [],
    emptyReason: 'none',
    detail: null,
    minScore: 0.52,
    embeddingModel: 'nomic-embed-text',
    candidatesConsidered: 0,
    ...overrides,
  };
}

describe('related context — memory configured and answering', () => {
  const related = toRelatedContext(
    'Fix the login redirect',
    response({ results: [result()] }),
    SESSION_ID,
  );
  const content = render({ related });

  it('renders the hits with their scores and the model that produced them', () => {
    const section = body(content, 'Related context from other work');

    expect(related.gap).toBeNull();
    expect(section).toContain('#### ADR-0007 — Use pg-boss');
    expect(section).toContain('score 0.710');
    expect(section).toContain('chunk 2 of 4');
    expect(section).toContain('Retrieved with `nomic-embed-text` at a relevance floor of 0.52');
    // Cosine similarity is not confidence, and a package that implied it was would mislead.
    expect(section).toContain('Scores are cosine similarity, not confidence.');
  });

  it('echoes the query, so an empty or odd answer is interpretable', () => {
    expect(body(content, 'Related context from other work')).toContain(
      '_Searched semantic memory for:_ `Fix the login redirect`',
    );
  });

  it('collapses a multi-line query to one line for the echo, without shortening the search', () => {
    // The real query is `title\n\nfirst prompt`, which cannot sit inside an inline code span.
    const multiline = toRelatedContext(
      `Fix the login redirect\n\n${'the guard loops '.repeat(20)}`,
      response({ results: [result()] }),
      SESSION_ID,
    );
    const echoed = body(render({ related: multiline }), 'Related context from other work')
      .split('\n')
      .find((line) => line.startsWith('_Searched semantic memory for:_'));

    expect(echoed).toBeDefined();
    expect(echoed).not.toContain('\n');
    expect(echoed).toContain('Fix the login redirect the guard loops');
    expect(echoed).toContain('…');
  });

  it('drops this session\u2019s own chunks and says how many', () => {
    const withOwn = toRelatedContext(
      'q',
      response({
        results: [
          result({ context: { projectId: null, repositoryId: null, sessionId: SESSION_ID } }),
          result({
            memoryItemId: '0199a3f1-2222-7def-8012-3456789abcde',
            title: 'Earlier session',
            sourceType: 'session',
            context: { projectId: null, repositoryId: null, sessionId: OTHER_SESSION_ID },
          }),
        ],
      }),
      SESSION_ID,
    );

    expect(withOwn.items.map((item) => item.title)).toEqual(['Earlier session']);
    expect(withOwn.ownChunksDropped).toBe(1);
    expect(render({ related: withOwn })).toContain(
      "1 further match(es) were this session's own transcript",
    );
  });
});

describe('related context — every degraded state is named, not omitted', () => {
  const cases: readonly {
    readonly label: string;
    readonly emptyReason: EmptyReason;
    readonly detail: string;
    readonly expectAdvice: string;
  }[] = [
    {
      label: 'memory is not configured',
      emptyReason: 'not_configured',
      detail: 'No embedding model is configured.',
      expectAdvice: 'Settings → Integrations → Memory',
    },
    {
      label: 'Ollama or Qdrant is unreachable',
      emptyReason: 'unavailable',
      detail: 'Could not reach http://127.0.0.1:11434.',
      expectAdvice: 'Settings → Services',
    },
    {
      label: 'the collection was built by a different model',
      emptyReason: 'stamp_mismatch',
      detail: 'Collection holds mxbai-embed-large/1024; configured model is nomic-embed-text/768.',
      expectAdvice: 'Rebuild the index',
    },
    {
      label: 'nothing is indexed yet',
      emptyReason: 'index_empty',
      detail: 'Nothing is indexed for this scope yet.',
      expectAdvice: 'Run a memory backfill',
    },
    {
      label: 'nothing cleared the relevance floor',
      emptyReason: 'below_threshold',
      detail: 'Nothing scored above 0.52.',
      expectAdvice: 'no comparable prior work was found',
    },
  ];

  for (const testCase of cases) {
    it(`says so when ${testCase.label}`, () => {
      const related = toRelatedContext(
        'Fix the login redirect',
        response({ emptyReason: testCase.emptyReason, detail: testCase.detail }),
        SESSION_ID,
      );
      const section = body(render({ related }), 'Related context from other work');

      expect(related.gap?.reason).toBe(testCase.emptyReason);
      // The reason, the detail the retrieval layer produced, and something to *do* about it.
      expect(section).toContain(`This section is incomplete — \`${testCase.emptyReason}\``);
      expect(section).toContain(testCase.detail);
      expect(section).toContain(testCase.expectAdvice);
    });
  }

  it('distinguishes "only my own transcript matched" from "nothing matched"', () => {
    const related = toRelatedContext(
      'q',
      response({
        results: [
          result({ context: { projectId: null, repositoryId: null, sessionId: SESSION_ID } }),
        ],
      }),
      SESSION_ID,
    );

    expect(related.gap?.reason).toBe('only_own_session');
    const section = body(render({ related }), 'Related context from other work');
    expect(section).toContain('`only_own_session`');
    expect(section).toContain('No other session, ADR, commit or note in the index');
  });

  it('names a retrieval timeout as such, and still produces the package', () => {
    const related: RelatedContext = {
      query: 'Fix the login redirect',
      items: [],
      gap: { reason: 'timed_out', detail: 'Semantic retrieval did not answer within 25000ms.' },
      embeddingModel: null,
      minScore: null,
      ownChunksDropped: 0,
    };
    const content = render({ related });

    expect(body(content, 'Related context from other work')).toContain('`timed_out`');
    // The rest of the document is unaffected — that is what a bounded dependency buys.
    expect(sections(content)).toHaveLength(10);
  });

  it('says there was nothing to search with when the session has no title and no prompt', () => {
    const related: RelatedContext = {
      query: null,
      items: [],
      gap: {
        reason: 'no_query',
        detail: 'This Session has no title and recorded no operator prompt.',
      },
      embeddingModel: null,
      minScore: null,
      ownChunksDropped: 0,
    };

    const section = body(render({ related }), 'Related context from other work');
    expect(section).toContain('`no_query`');
    expect(section).toContain('this is not an empty result');
    expect(section).not.toContain('_Searched semantic memory for:_');
  });
});
