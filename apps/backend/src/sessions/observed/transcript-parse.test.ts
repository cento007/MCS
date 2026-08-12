import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTranscriptLine } from './transcript-parse.js';

/**
 * The version-tolerant parser (TDS 07 §5.4).
 *
 * The mandatory case is forward compatibility: *"fixtures containing (a) unknown top-level line
 * `type`s, (b) known types with extra unknown fields, (c) a syntactically invalid line mid-file
 * — the tailer must skip/ignore unknowns, keep tailing, and **never** throw"*. Everything below
 * is one of those three, or the happy path they are the exceptions to.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'claude',
  'transcripts',
);

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n');
}

describe('parseTranscriptLine — happy path', () => {
  const lines = fixtureLines('happy-session.jsonl');

  it('reads a user turn, keying it on the runtime line uuid', () => {
    const parsed = parseTranscriptLine(lines[0] as string);

    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record).toMatchObject({
      role: 'user',
      content: 'Add a health endpoint to the backend',
      runtimeMessageId: 'aaaaaaa1-0000-4000-8000-000000000001',
    });
    expect(parsed.record.occurredAt).toEqual(new Date('2026-08-12T10:00:00.000Z'));
  });

  it('reads an assistant turn with its model and its raw blocks', () => {
    const parsed = parseTranscriptLine(lines[1] as string);

    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.role).toBe('assistant');
    expect(parsed.record.model).toBe('claude-opus-4-20250514');
    expect(parsed.record.content).toBe("I'll read the router first.");
    // Blocks are kept verbatim for faithful re-rendering (TDS 03 §3.11).
    expect(parsed.record.contentBlocks).toEqual([
      { type: 'text', text: "I'll read the router first." },
    ]);
  });

  it('records a tool_use turn as role `tool` with the file path §6.10.2 needs', () => {
    const parsed = parseTranscriptLine(lines[2] as string);

    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record).toMatchObject({
      role: 'tool',
      toolName: 'Read',
      toolUseId: 'toolu_01',
      toolFilePath: '/home/op/proj/src/router.ts',
    });
  });

  it('records a tool_result turn as role `tool`, correlated by tool_use_id', () => {
    const parsed = parseTranscriptLine(lines[3] as string);

    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record).toMatchObject({ role: 'tool', toolUseId: 'toolu_01' });
  });

  it('ignores a `summary` line without counting it as drift', () => {
    // The distinction that keeps a healthy long session from degrading itself: recognised and
    // skipped is not the same as unrecognised and skipped.
    expect(parseTranscriptLine(lines[4] as string).kind).toBe('ignored');
  });
});

describe('parseTranscriptLine — forward compatibility (mandatory, TDS 07 §5.4)', () => {
  const lines = fixtureLines('forward-compatibility.jsonl');

  it('(b) ignores unknown FIELDS on a known type — an added field is not drift', () => {
    const parsed = parseTranscriptLine(lines[1] as string);

    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.content).toBe('On it.');
    expect(parsed.record.model).toBe('claude-opus-4-20250514');
  });

  it('(a) counts unknown top-level TYPES as drift and skips them', () => {
    const telemetry = parseTranscriptLine(lines[2] as string);
    const experimental = parseTranscriptLine(lines[3] as string);

    expect(telemetry.kind).toBe('drift');
    expect(experimental.kind).toBe('drift');
    if (telemetry.kind === 'drift') expect(telemetry.reason).toContain('telemetry_ping');
  });

  it('(c) counts a syntactically invalid line as drift instead of throwing', () => {
    const parsed = parseTranscriptLine(lines[4] as string);
    expect(parsed.kind).toBe('drift');
    if (parsed.kind === 'drift') expect(parsed.reason).toContain('invalid JSON');
  });

  it('counts a known type whose `message` changed shape as drift', () => {
    const parsed = parseTranscriptLine(lines[5] as string);
    expect(parsed.kind).toBe('drift');
  });

  it('keeps parsing after the drift — a bad line never poisons the ones after it', () => {
    const parsed = parseTranscriptLine(lines[6] as string);
    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.content).toBe('Renamed it.');
  });

  it('never throws, for any line in the fixture', () => {
    for (const line of lines) {
      expect(() => parseTranscriptLine(line)).not.toThrow();
    }
  });
});

describe('parseTranscriptLine — degenerate input', () => {
  it('treats blank lines as ignorable, not as drift', () => {
    expect(parseTranscriptLine('').kind).toBe('ignored');
    expect(parseTranscriptLine('   \t ').kind).toBe('ignored');
  });

  it('drifts on JSON that is not an object', () => {
    expect(parseTranscriptLine('[1,2,3]').kind).toBe('drift');
    expect(parseTranscriptLine('"a string"').kind).toBe('drift');
    expect(parseTranscriptLine('null').kind).toBe('drift');
  });

  it('drifts on an object with no string `type`', () => {
    expect(parseTranscriptLine('{"message":{"role":"user","content":"x"}}').kind).toBe('drift');
    expect(parseTranscriptLine('{"type":42}').kind).toBe('drift');
  });

  it('accepts a string `content` as well as a block array', () => {
    const parsed = parseTranscriptLine('{"type":"user","message":{"role":"user","content":"hi"}}');

    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.content).toBe('hi');
    expect(parsed.record.contentBlocks).toBeNull();
  });

  it('tolerates a line with no uuid — it simply has no dedupe key of its own', () => {
    const parsed = parseTranscriptLine('{"type":"user","message":{"role":"user","content":"hi"}}');
    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.runtimeMessageId).toBeNull();
  });

  it("skips meta lines the runtime injects on the user's behalf", () => {
    const line = '{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: …"}}';
    expect(parseTranscriptLine(line).kind).toBe('ignored');
  });

  it('keeps a turn that both speaks and calls a tool as an assistant turn', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
      uuid: 'u1',
    });

    const parsed = parseTranscriptLine(line);
    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.role).toBe('assistant');
    expect(parsed.record.toolFilePath).toBe('/a.ts');
  });
});
