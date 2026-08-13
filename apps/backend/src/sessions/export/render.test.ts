import { parseNote } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import type { SessionFilesReadModel } from '../files.js';
import type { CommitRead, ExportMessage, MessageRead } from './evidence.js';
import { EXPORT_MAX_MESSAGE_CHARS } from './evidence.js';
import { type ExportSessionFacts, exportFilename, renderSessionExport } from './render.js';

/**
 * The Export document, rendered from fixtures. No database, no network (TDS 07 §2.1).
 *
 * The claims worth testing are the ones a reader cannot check by eye on a happy-path document:
 * that a session with nothing in it produces an honest document rather than a broken one, that
 * a tool-heavy session does not leak a payload, and that a message engineered to break Markdown
 * cannot swallow the sections after it.
 */

const SESSION_ID = '0199a3f1-2b4c-7def-8012-3456789abcde';

function facts(overrides: Partial<ExportSessionFacts> = {}): ExportSessionFacts {
  return {
    id: SESSION_ID,
    title: 'Fix the login redirect',
    projectId: '0199a3f1-0000-7def-8012-3456789abcde',
    projectName: 'Mission Control',
    repositoryName: 'MCS',
    state: 'completed',
    sessionType: 'managed',
    runtime: 'claude_code',
    runtimeSessionId: 'c0ffee00-0000-4000-8000-000000000000',
    runtimeVersion: '2.1.0',
    model: 'claude-opus-4',
    machine: 'mc-dev',
    environment: 'windows-dev',
    branch: 'DEV',
    workingDir: 'D:\\Repos\\MCS',
    notes: null,
    failureReason: null,
    totalCostUsd: '0.412300',
    numTurns: 7,
    durationMs: 185_000,
    resumedFromSessionId: null,
    lineageKind: null,
    createdAt: new Date('2026-08-13T09:00:00.000Z'),
    startedAt: new Date('2026-08-13T09:01:00.000Z'),
    completedAt: new Date('2026-08-13T09:04:05.000Z'),
    archivedAt: null,
    ...overrides,
  };
}

function message(overrides: Partial<ExportMessage> & { ordinal: number }): ExportMessage {
  return {
    role: 'assistant',
    status: 'complete',
    content: '',
    truncated: false,
    model: null,
    toolName: null,
    toolFilePath: null,
    toolFailed: null,
    occurredAt: new Date('2026-08-13T09:02:00.000Z'),
    ...overrides,
  };
}

const NO_FILES: SessionFilesReadModel = {
  root: 'D:\\Repos\\MCS',
  files: [],
  totalFiles: 0,
  truncated: false,
  commitsAsOf: null,
  completeness: 'complete',
  completenessReason: null,
};

const NO_COMMITS: CommitRead = { commits: [], total: 0 };

function render(
  transcript: MessageRead,
  overrides: {
    session?: Partial<ExportSessionFacts>;
    files?: SessionFilesReadModel;
    commits?: CommitRead;
  } = {},
) {
  return renderSessionExport({
    session: facts(overrides.session),
    transcript,
    files: overrides.files ?? NO_FILES,
    commits: overrides.commits ?? NO_COMMITS,
    generatedAt: new Date('2026-08-13T10:00:00.000Z'),
  });
}

describe('a session with no messages', () => {
  const document = render({ messages: [], total: 0 });

  it('says so rather than emitting an empty Transcript heading', () => {
    expect(document.content).toContain('_This session recorded no messages._');
  });

  it('still parses as a note with every section present', () => {
    const parsed = parseNote(document.content);

    expect(parsed.title).toBe('Fix the login redirect');
    expect(parsed.sections.map((section) => section.heading)).toEqual([
      'Session',
      'Notes',
      'Transcript',
      'Files touched',
      'Commits',
      'What this export leaves out',
    ]);
  });

  it('invents nothing for the empty sections', () => {
    const parsed = parseNote(document.content);
    const body = (heading: string) =>
      parsed.sections.find((section) => section.heading === heading)?.lines.join('\n');

    expect(body('Notes')).toBe('_Nothing recorded._');
    expect(body('Files touched')).toBe('_Nothing recorded._');
    expect(body('Commits')).toBe('_Nothing recorded._');
  });

  it('carries front matter that the vault sync engine will not claim', () => {
    // `mcId` + `mcType` are how `noteIdentity` adopts a note as a managed projection. An export
    // filed in the vault must stay the operator's file.
    const parsed = parseNote(document.content);
    const keys = parsed.frontMatter?.entries.map((entry) => entry.key) ?? [];

    expect(keys).toContain('mcSessionId');
    expect(keys).toContain('mcDocument');
    expect(keys).not.toContain('mcId');
    expect(keys).not.toContain('mcType');
  });
});

describe('a tool-heavy session', () => {
  const document = render({
    messages: [
      message({ ordinal: 0, role: 'user', content: 'Read the config and fix the redirect' }),
      message({ ordinal: 1, role: 'tool', toolName: 'Read', toolFilePath: 'src/config.ts' }),
      message({
        ordinal: 2,
        role: 'tool',
        content: 'THE ENTIRE FILE CAME BACK',
        toolFailed: false,
      }),
      message({ ordinal: 3, role: 'tool', toolName: 'Bash' }),
      message({
        ordinal: 4,
        role: 'tool',
        content: 'ANTHROPIC_API_KEY=sk-ant-not-a-real-key',
        toolFailed: true,
      }),
      message({ ordinal: 5, role: 'assistant', content: 'Fixed it.', model: 'claude-opus-4' }),
    ],
    total: 6,
  });

  it('lists each tool call by name and file', () => {
    expect(document.content).toContain('- **Tool** `Read` → `src/config.ts`');
    expect(document.content).toContain('- **Tool** `Bash`');
  });

  it('does not put a single tool result body in the document', () => {
    // The whole reason payloads are excluded: a `Bash` result is whatever the environment
    // printed, and that can be a credential.
    expect(document.content).not.toContain('THE ENTIRE FILE CAME BACK');
    expect(document.content).not.toContain('sk-ant-not-a-real-key');
  });

  it('keeps the one bit that matters — that a tool failed', () => {
    expect(document.content).toContain('- ↳ **the tool reported an error**');
  });

  it('states the exclusion with counts, in the document', () => {
    expect(document.content).toContain('2 tool call(s) are listed by name and file only');
    expect(document.content).toContain('1 tool result(s) are not shown at all');
  });
});

describe('a message that would break the format', () => {
  it('closes an unterminated fence so later sections are not swallowed', () => {
    const document = render({
      messages: [
        message({ ordinal: 0, role: 'assistant', content: 'Here:\n\n```ts\nconst a = 1;' }),
      ],
      total: 1,
    });

    expect(document.content).toContain('_[export closed a code fence this message left open]_');
    // The proof that it worked: the sections after the transcript are still real headings.
    const parsed = parseNote(document.content);
    expect(parsed.sections.map((section) => section.heading)).toContain('Commits');
    expect(parsed.sections.map((section) => section.heading)).toContain(
      'What this export leaves out',
    );
  });

  it('contains a prompt full of Markdown that would otherwise impersonate the document', () => {
    const hostile = ['---', '## Files touched', '- `/etc/passwd`', '```', 'unterminated'].join(
      '\n',
    );
    const document = render({
      messages: [message({ ordinal: 0, role: 'user', content: hostile })],
      total: 1,
    });

    const parsed = parseNote(document.content);
    // Every line of the prompt is quoted, so none of it became a heading of this document.
    expect(document.content).toContain('> ## Files touched');
    expect(parsed.sections.filter((section) => section.heading === 'Files touched')).toHaveLength(
      1,
    );
    expect(
      parsed.sections.find((section) => section.heading === 'Files touched')?.lines.join('\n'),
    ).toBe('_Nothing recorded._');
  });

  it('escapes control characters and reports how many', () => {
    const esc = String.fromCharCode(0x1b);
    const document = render({
      messages: [message({ ordinal: 0, role: 'assistant', content: `${esc}[31mred${esc}[0m` })],
      total: 1,
    });

    expect(document.content).toContain('<U+001B>[31mred<U+001B>[0m');
    expect(document.content).toContain('**2 control character(s)** were escaped');
  });

  it('marks a truncated body and counts it in the omissions', () => {
    const document = render({
      messages: [
        message({ ordinal: 0, role: 'assistant', content: 'x'.repeat(40), truncated: true }),
      ],
      total: 1,
    });

    expect(document.content).toContain(`_[truncated at ${String(EXPORT_MAX_MESSAGE_CHARS)}`);
    expect(document.content).toContain('**1 message body/bodies** exceeded');
  });
});

describe('bounds', () => {
  it('names how many messages the cap left out rather than trailing off', () => {
    const document = render({
      messages: [message({ ordinal: 0, role: 'user', content: 'first' })],
      total: 2_500,
    });

    expect(document.content).toContain('2499 later message(s) are not in this export');
    expect(document.content).toContain('**2499 message(s)** beyond the 2000-message export cap');
  });

  it('names how many commits and files it left out', () => {
    const document = render(
      { messages: [], total: 0 },
      {
        commits: {
          commits: [
            {
              sha: 'abcdef1234567890',
              subject: 'Fix the redirect',
              authorName: 'operator',
              committedAt: new Date('2026-08-13T09:03:00.000Z'),
              filesChanged: 2,
              additions: 10,
              deletions: 3,
            },
          ],
          total: 205,
        },
        files: {
          ...NO_FILES,
          files: [
            {
              path: 'src/config.ts',
              outsideRoot: false,
              touchCount: 3,
              toolTouchCount: 2,
              commitCount: 1,
              sources: ['tool', 'commit'],
              status: 'modified',
              additions: 10,
              deletions: 3,
              lastTouchedAt: '2026-08-13T09:03:00.000Z',
            },
          ],
          totalFiles: 240,
        },
      },
    );

    expect(document.content).toContain('- `abcdef1234` Fix the redirect');
    expect(document.content).toContain('_…and 204 more._');
    expect(document.content).toContain('- `src/config.ts` — 3 touch(es) [tool, commit] · +10 −3');
    expect(document.content).toContain('_…and 239 more._');
  });

  it('reports a degraded observed session as partial instead of implying completeness', () => {
    const document = render(
      { messages: [], total: 0 },
      {
        files: {
          ...NO_FILES,
          files: [
            {
              path: 'src/a.ts',
              outsideRoot: false,
              touchCount: 1,
              toolTouchCount: 1,
              commitCount: 0,
              sources: ['tool'],
              status: null,
              additions: null,
              deletions: null,
              lastTouchedAt: '2026-08-13T09:03:00.000Z',
            },
          ],
          totalFiles: 1,
          completeness: 'partial',
          completenessReason: 'observation_degraded',
        },
      },
    );

    expect(document.content).toContain('partial');
    expect(document.content).toContain('observation_degraded');
  });
});

describe('exportFilename', () => {
  it('is deterministic in the session, so a re-export replaces its predecessor', () => {
    const name = exportFilename(facts());
    expect(name).toBe(exportFilename(facts()));
    expect(name).toBe('session-2026-08-13-0199a3f1-Fix-the-login-redirect.md');
  });

  it('falls back to the short id when the session was never named', () => {
    expect(exportFilename(facts({ title: null }))).toBe(
      'session-2026-08-13-0199a3f1-Session-0199a3f1.md',
    );
  });

  it('is safe on both target platforms even for a title full of path characters', () => {
    const name = exportFilename(facts({ title: 'a/b\\c:d*e?f"g<h>i|j' }));
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
  });
});
