import { describe, expect, it } from 'vitest';
import { FILE_NAMING_TOOLS, renderText, toContentBlocks, toolFilePathOf } from './content.js';

/**
 * Content-block translation and the §6.10.2 tool-path extraction — pure functions, so they are
 * tested exhaustively here and only sampled through the pump.
 */

describe('toContentBlocks', () => {
  it('accepts the string form the API allows for user messages', () => {
    expect(toContentBlocks('just text')).toEqual([{ type: 'text', text: 'just text' }]);
    expect(toContentBlocks('')).toEqual([]);
  });

  it('maps the four §6.6 block types and drops everything else', () => {
    const blocks = toContentBlocks([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'image', source: { type: 'base64', data: '…' } },
      'not even an object',
      null,
    ]);

    expect(blocks).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'thinking', text: 'hmm' },
      { type: 'tool_use', toolUseId: 'toolu_1', toolName: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_result', toolUseId: 'toolu_1', output: 'file body', isError: false },
    ]);
  });

  it('flattens a tool_result whose content is a block array', () => {
    expect(
      toContentBlocks([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', source: {} },
            { type: 'text', text: 'line two' },
          ],
          is_error: true,
        },
      ]),
    ).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_2', output: 'line one\nline two', isError: true },
    ]);
  });

  it('drops blocks missing the fields their type is defined by', () => {
    expect(
      toContentBlocks([
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', id: 'toolu_3' },
        { type: 'tool_result' },
        { type: 'text' },
      ]),
    ).toEqual([]);
  });

  it('tolerates a non-array, non-string content field', () => {
    expect(toContentBlocks(undefined)).toEqual([]);
    expect(toContentBlocks(42)).toEqual([]);
    expect(toContentBlocks({ unexpected: true })).toEqual([]);
  });
});

describe('renderText (§6.11.2)', () => {
  it('concatenates text blocks in order and ignores every other type', () => {
    expect(
      renderText([
        { type: 'thinking', text: 'not this' },
        { type: 'text', text: 'first' },
        { type: 'tool_use', toolUseId: 't', toolName: 'Read', input: {} },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('is empty for a turn that produced only tool activity', () => {
    expect(renderText([{ type: 'tool_use', toolUseId: 't', toolName: 'Bash', input: {} }])).toBe(
      '',
    );
  });
});

describe('toolFilePathOf (§6.10.2)', () => {
  it('extracts the path for each file-naming tool', () => {
    for (const tool of FILE_NAMING_TOOLS) {
      expect(toolFilePathOf(tool, { file_path: 'C:\\repo\\src\\index.ts' })).toBe(
        'C:\\repo\\src\\index.ts',
      );
    }
  });

  it('handles NotebookEdit’s own key', () => {
    expect(toolFilePathOf('NotebookEdit', { notebook_path: '/repo/analysis.ipynb' })).toBe(
      '/repo/analysis.ipynb',
    );
  });

  it('returns null for tools whose input names no file', () => {
    // §6.10.2: "including them would turn 'files touched' into 'paths mentioned'".
    expect(toolFilePathOf('Bash', { command: 'cat src/index.ts' })).toBeNull();
    expect(toolFilePathOf('Grep', { pattern: 'x', path: '/repo' })).toBeNull();
    expect(toolFilePathOf('Glob', { pattern: '**/*.ts' })).toBeNull();
  });

  it('returns null — never throws — for an unrecognized payload shape', () => {
    // TDS 03 §3.11: "An unrecognized tool or payload shape leaves it NULL and must never fail
    // the ingest."
    expect(toolFilePathOf('Read', null)).toBeNull();
    expect(toolFilePathOf('Read', 'a string')).toBeNull();
    expect(toolFilePathOf('Read', { file_path: 42 })).toBeNull();
    expect(toolFilePathOf('Read', { file_path: '' })).toBeNull();
    expect(toolFilePathOf('Read', {})).toBeNull();
  });
});
