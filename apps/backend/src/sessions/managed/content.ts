import type { RuntimeContentBlock } from './runtime-events.js';

/**
 * Content-block translation: the runtime's blocks -> the §6.6 `Message.content` vocabulary,
 * plus the two derived values the `messages` table stores alongside them — the rendered text
 * (TDS 03 §3.11 `content`) and the file path a tool named (§6.10.2 `tool_file_path`).
 *
 * Everything here is **lenient by construction** (F1.5 "version-tolerant parser isolated in an
 * adapter"): a block type we do not know is skipped rather than fatal, a missing field falls
 * back rather than throws. A runtime that grows a new block type must not be able to break
 * message persistence — the alternative is losing a whole turn because one block was novel.
 */

/**
 * Tools whose input names a file (§6.10.2, verbatim: "Only invocations whose input names a
 * file"). `Glob`/`Grep` take patterns and `Bash` is opaque, so including them would turn "files
 * touched" into "paths mentioned".
 *
 * The list is runtime-version-dependent, which is exactly why it lives in this adapter and not
 * in SQL (§6.10.2 storage note).
 */
export const FILE_NAMING_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

/** Input keys those tools use for the path, in precedence order. */
const FILE_PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * Map one runtime content block onto the API vocabulary, or `null` when it is not one of the
 * four §6.6 shapes (`redacted_thinking`, `server_tool_use`, images, …).
 */
export function toContentBlock(value: unknown): RuntimeContentBlock | null {
  if (!isRecord(value)) return null;
  const type = value['type'];

  switch (type) {
    case 'text': {
      const text = value['text'];
      return typeof text === 'string' ? { type: 'text', text } : null;
    }
    case 'thinking': {
      // The API names the field `thinking`; §6.6 names it `text`. The rename happens here,
      // once, rather than in every renderer.
      const text = value['thinking'] ?? value['text'];
      return typeof text === 'string' ? { type: 'thinking', text } : null;
    }
    case 'tool_use': {
      const toolUseId = value['id'];
      const toolName = value['name'];
      if (typeof toolUseId !== 'string' || typeof toolName !== 'string') return null;
      return { type: 'tool_use', toolUseId, toolName, input: value['input'] ?? null };
    }
    case 'tool_result': {
      const toolUseId = value['tool_use_id'];
      if (typeof toolUseId !== 'string') return null;
      return {
        type: 'tool_result',
        toolUseId,
        output: renderToolResultOutput(value['content']),
        isError: value['is_error'] === true,
      };
    }
    default:
      return null;
  }
}

/**
 * A whole message's content. Accepts the string form the API allows for user messages as well
 * as the block array form.
 */
export function toContentBlocks(content: unknown): RuntimeContentBlock[] {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const blocks: RuntimeContentBlock[] = [];
  for (const entry of content) {
    const block = toContentBlock(entry);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/**
 * The canonical rendered text (§6.11.2): `type: 'text'` blocks concatenated in order.
 * `thinking`, `tool_use` and `tool_result` are ignored — the same rule the title derivation
 * applies, kept in one place so `content` and the derived title can never disagree.
 */
export function renderText(blocks: readonly RuntimeContentBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<RuntimeContentBlock, { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * `messages.tool_file_path` (§6.10.2): the absolute native path a file-naming tool was pointed
 * at, or `null`. An unrecognized tool or payload shape leaves it NULL and **must never fail the
 * ingest** (TDS 03 §3.11).
 */
export function toolFilePathOf(toolName: string, input: unknown): string | null {
  if (!FILE_NAMING_TOOLS.includes(toolName)) return null;
  if (!isRecord(input)) return null;

  for (const key of FILE_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A tool result's text, flattened. Non-text parts are dropped rather than JSON-dumped. */
function renderToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }
    if (isRecord(entry) && entry['type'] === 'text' && typeof entry['text'] === 'string') {
      parts.push(entry['text']);
    }
  }
  return parts.join('\n');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
