import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeSdkMessage } from './normalize.js';
import type { RuntimeEvent } from './runtime-events.js';

/**
 * Contract tests (TDS 07 §5.3) — these pin **our parsing of the runtime's wire format**, which
 * the mock runtime by construction cannot.
 *
 * The corpus lives in `test/fixtures/claude/recorded/*.jsonl`, one JSON object per line exactly
 * as `--output-format stream-json` emits them, with a `_fixture_meta` first line recording
 * provenance and the SDK/Claude Code version the shapes were taken from.
 *
 * **Provenance, stated plainly:** these lines were authored from the installed SDK's own type
 * declarations (`sdk.d.ts` at 0.3.228 / Claude Code 2.1.228), not captured from a live run —
 * nothing in this repository may call the Anthropic API. That is weaker evidence than a
 * recording and it is still the strongest available offline: the shapes come from the vendor's
 * published types rather than from anyone's memory, and the version pin below turns an SDK bump
 * into a failing test rather than a silent drift. The `refresh` field on every fixture says how
 * to replace them with a real capture when credentials are available.
 */

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/claude/recorded',
);

interface FixtureMeta {
  readonly type: '_fixture_meta';
  readonly sdkVersion: string;
  readonly claudeCodeVersion: string;
  readonly scenario: string;
}

interface Fixture {
  readonly name: string;
  readonly meta: FixtureMeta;
  readonly messages: readonly unknown[];
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .map((file) => {
      const lines = readFileSync(join(FIXTURE_DIR, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const [meta, ...messages] = lines;
      if (meta?.['type'] !== '_fixture_meta') {
        throw new Error(`${file} must start with a _fixture_meta line`);
      }
      return { name: file, meta: meta as unknown as FixtureMeta, messages };
    });
}

const fixtures = loadFixtures();

function normalizeAll(fixture: Fixture): RuntimeEvent[] {
  return fixture.messages.flatMap((message) => normalizeSdkMessage(message));
}

function fixtureNamed(name: string): Fixture {
  const found = fixtures.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`fixture ${name} is missing from the corpus`);
  return found;
}

describe('corpus version pin (TDS 07 §10.3)', () => {
  it('matches the installed SDK version, so a bump cannot land without a corpus refresh', () => {
    // The SDK's `exports` map does not expose `./package.json`, so the manifest is read from
    // beside the resolved entry point instead.
    const require = createRequire(import.meta.url);
    const manifestPath = join(
      dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
      'package.json',
    );
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string;
      claudeCodeVersion?: string;
    };

    for (const fixture of fixtures) {
      expect(
        fixture.meta.sdkVersion,
        `${fixture.name}: recorded against SDK ${fixture.meta.sdkVersion} but ${installed.version} is installed — re-record the corpus in the same PR as the bump (TDS 07 §5.3)`,
      ).toBe(installed.version);
      expect(fixture.meta.claudeCodeVersion).toBe(installed.claudeCodeVersion);
    }
  });

  it('has a fixture for each shape the pump acts on', () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      'forward-compatibility.jsonl',
      'happy-turn.jsonl',
      'rate-limited-turn.jsonl',
      'tool-use-turn.jsonl',
    ]);
  });
});

describe('happy-turn.jsonl — init, partial deltas, completed message, result', () => {
  const events = normalizeAll(fixtureNamed('happy-turn.jsonl'));

  it('produces exactly the event sequence the pump expects', () => {
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'message_started',
      'stream_delta',
      'stream_delta',
      'message_completed',
      'result',
    ]);
  });

  it('extracts the runtime-native session id and version from system/init', () => {
    expect(events[0]).toEqual({
      type: 'session_started',
      runtimeSessionId: '9d7f6a1e-8b2c-4d3e-9f10-2a3b4c5d6e7f',
      model: 'claude-sonnet-4-5-20250929',
      claudeVersion: '2.1.228',
      cwd: 'D:\\Repos\\MCS',
      permissionMode: 'acceptEdits',
      tools: [
        'Task',
        'Bash',
        'Glob',
        'Grep',
        'Read',
        'Edit',
        'Write',
        'WebFetch',
        'TodoWrite',
        'WebSearch',
      ],
    });
  });

  it('accumulates text deltas in order, and only from content_block_delta', () => {
    const deltas = events.filter((event) => event.type === 'stream_delta');
    expect(deltas.map((delta) => delta.text).join('')).toBe('Refactoring the queue consumer.');
    expect(deltas.every((delta) => delta.deltaType === 'text_delta')).toBe(true);
    // `message_start`/`content_block_start`/`content_block_stop`/`message_delta`/`message_stop`
    // produce no browser-visible delta — §14.5's payload has no shape for them.
    expect(deltas).toHaveLength(2);
  });

  it('keeps the runtime uuid as the dedupe key and the timestamp as occurredAt', () => {
    const completed = events.find((event) => event.type === 'message_completed');
    expect(completed).toMatchObject({
      role: 'assistant',
      uuid: '1a2b3c4d-0000-4000-8000-000000000009',
      text: 'Refactoring the queue consumer.',
      model: 'claude-sonnet-4-5-20250929',
      aborted: false,
      stopReason: 'end_turn',
      occurredAt: '2026-08-12T09:14:02.881Z',
    });
  });

  it('extracts cost and usage from the result (F1.5 canonical cost source)', () => {
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      isError: false,
      totalCostUsd: 0.0217,
      numTurns: 1,
      durationMs: 5231,
      durationApiMs: 4880,
      rateLimited: false,
      usage: {
        input_tokens: 1240,
        output_tokens: 42,
        cache_read_input_tokens: 8600,
        cache_creation_input_tokens: 0,
      },
    });
  });
});

describe('tool-use-turn.jsonl — tool_use, tool_result, thinking', () => {
  const events = normalizeAll(fixtureNamed('tool-use-turn.jsonl'));

  it('maps tool_use blocks onto the §6.6 vocabulary with the accumulated input', () => {
    const assistant = events.filter((event) => event.type === 'message_completed')[0];
    expect(assistant?.blocks).toEqual([
      { type: 'text', text: 'Reading the file.' },
      {
        type: 'tool_use',
        toolUseId: 'toolu_01QwErTyUiOp',
        toolName: 'Read',
        input: { file_path: '/home/operator/repo/src/queue.ts' },
      },
    ]);
  });

  it('maps the runtime’s echoed user message onto a tool_result block', () => {
    const toolResult = events
      .filter((event) => event.type === 'message_completed')
      .find((event) => event.role === 'user');
    expect(toolResult?.blocks).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'toolu_01QwErTyUiOp',
        output: 'export const queue = 1;',
        isError: false,
      },
    ]);
  });

  it('renames the API’s `thinking` field to §6.6’s `text` and keeps it out of rendered text', () => {
    const closing = events.filter((event) => event.type === 'message_completed').at(-1);
    expect(closing?.blocks[0]).toEqual({
      type: 'thinking',
      text: 'One export; nothing else to check.',
    });
    // §6.11.2: only `text` blocks are rendered text — thinking never leaks into a title.
    expect(closing?.text).toBe('It exports one binding.');
  });

  it('streams tool input as input_json_delta fragments', () => {
    const json = events
      .filter((event) => event.type === 'stream_delta')
      .filter((event) => event.deltaType === 'input_json_delta');
    expect(json.map((delta) => delta.partialJson).join('')).toBe(
      '{"file_path":"/home/operator/repo/src/queue.ts"}',
    );
    expect(json.every((delta) => delta.text === null)).toBe(true);
  });
});

describe('rate-limited-turn.jsonl — WS1 §4.3 classification', () => {
  const events = normalizeAll(fixtureNamed('rate-limited-turn.jsonl'));

  it('classifies the advisory rate_limit_event', () => {
    expect(events.find((event) => event.type === 'rate_limit')).toEqual({
      type: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_786_530_000,
      rateLimitType: 'five_hour',
    });
  });

  it('classifies the assistant error as rate_limited rather than a crash', () => {
    const error = events.find((event) => event.type === 'runtime_error');
    expect(error?.reason).toBe('rate_limited');
  });

  it('marks the result rateLimited, which is what stops it failing the Session', () => {
    const result = events.find((event) => event.type === 'result');
    expect(result).toMatchObject({ isError: true, rateLimited: true, stopReason: 'rate_limit' });
  });

  it('still captures the cost accrued before the limit', () => {
    const result = events.find((event) => event.type === 'result');
    expect(result?.totalCostUsd).toBe(0.0031);
  });
});

describe('forward-compatibility.jsonl — F1.5 version tolerance', () => {
  const fixture = fixtureNamed('forward-compatibility.jsonl');

  it('never throws on unknown types, unknown deltas or unknown fields', () => {
    expect(() => normalizeAll(fixture)).not.toThrow();
  });

  it('drops what it cannot act on and keeps what it can', () => {
    const events = normalizeAll(fixture);
    expect(events.map((event) => event.type)).toEqual([
      // `status`, `session_state_changed`, `hook_started`, `task_started`, `compact_boundary`,
      // an invented top-level type, `signature_delta` and an invented delta kind: all dropped.
      'stream_delta',
      'message_completed',
      'result',
    ]);
    expect(events[0]).toMatchObject({
      deltaType: 'thinking_delta',
      text: 'Weighing two approaches',
    });
  });

  it('keeps the known blocks of a message that also carries unknown ones', () => {
    const completed = normalizeAll(fixture).find((event) => event.type === 'message_completed');
    // `redacted_thinking` and `server_tool_use` have no §6.6 representation, so they are skipped
    // — but skipping them must not cost us the `text` block sitting between them.
    expect(completed?.blocks).toEqual([{ type: 'text', text: 'Weighed it.' }]);
    expect(completed?.text).toBe('Weighed it.');
  });
});
