import type { MessageRole } from '@mc/shared';
import type { TranscriptRecord } from './ports.js';
import { toolFilePathFrom } from './tool-files.js';

/**
 * The version-tolerant JSONL parser (F1.5, TDS 02 §6.3).
 *
 * **All** knowledge of Claude Code's internal transcript format lives here and nowhere else.
 * The format is internal and version-sensitive (spike §4), so the parser's contract is written
 * around being wrong rather than around being right:
 *
 *   - known fields are extracted, **unknown fields are ignored** — an added field is not drift;
 *   - **unknown line types are counted and skipped** — they are drift, because a type we do not
 *     recognise is content we are silently failing to ingest, and the drift counter exists to
 *     make exactly that measurable;
 *   - a syntactically invalid line is drift, never an exception.
 *
 * The function is total: every input string maps to one of the three outcomes and nothing
 * throws. That is what TDS 07 §5.4's mandatory forward-compatibility case asserts.
 */

export type ParsedTranscriptLine =
  | { readonly kind: 'record'; readonly record: TranscriptRecord }
  /** Recognised, deliberately not ingested (a summary, a meta notice). Not drift. */
  | { readonly kind: 'ignored'; readonly reason: string }
  /** Unparseable or unrecognised. Counted by the drift counter (TDS 02 §6.3). */
  | { readonly kind: 'drift'; readonly reason: string };

/** Line types that carry conversation content. */
const MESSAGE_TYPES = Object.freeze(['user', 'assistant'] as const);

/**
 * Line types we recognise and skip. Recognising them is the whole point: without this list
 * every `summary` line in a long transcript would read as drift and a healthy session would
 * degrade itself.
 */
const KNOWN_NON_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'summary',
  'system',
  'result',
  'stream_event',
  'file-history-snapshot',
  'progress',
  'attachment',
  'compact_boundary',
]);

/** Longest reason we keep; it lands in `transcript_tail_states.last_error` and a WS payload. */
const MAX_REASON_LENGTH = 200;

/** Guard against a pathological single line dominating memory. */
const MAX_CONTENT_LENGTH = 512 * 1024;

export function parseTranscriptLine(raw: string): ParsedTranscriptLine {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'ignored', reason: 'blank line' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return drift(`invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return drift('line is not a JSON object');
  }

  const line = parsed as Record<string, unknown>;
  const type = line['type'];

  if (typeof type !== 'string' || type.length === 0) {
    return drift('line has no string `type`');
  }
  if (KNOWN_NON_MESSAGE_TYPES.has(type)) {
    return { kind: 'ignored', reason: `known non-message type '${type}'` };
  }
  if (!(MESSAGE_TYPES as readonly string[]).includes(type)) {
    // The forward-compatibility case that matters: a type Claude Code added after this build.
    // Skipped, counted, never fatal.
    return drift(`unknown line type '${type}'`);
  }
  if (line['isMeta'] === true) {
    return { kind: 'ignored', reason: 'meta line' };
  }

  const message = line['message'];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return drift(`'${type}' line has no message object`);
  }

  return { kind: 'record', record: toRecord(line, message as Record<string, unknown>, type) };
}

function toRecord(
  line: Record<string, unknown>,
  message: Record<string, unknown>,
  type: string,
): TranscriptRecord {
  const blocks = normalizeBlocks(message['content']);
  const text = renderText(message['content'], blocks);
  const toolUse = firstBlockOfType(blocks, 'tool_use');
  const toolResult = firstBlockOfType(blocks, 'tool_result');

  const toolName = readString(toolUse, 'name');
  const toolInput = toolUse === null ? null : toolUse['input'];

  return {
    runtimeMessageId: readString(line, 'uuid'),
    role: roleFor(type, message, blocks, toolUse !== null, toolResult !== null, text),
    content: text.slice(0, MAX_CONTENT_LENGTH),
    contentBlocks: blocks,
    model: readString(message, 'model'),
    toolName,
    toolUseId: readString(toolUse, 'id') ?? readString(toolResult, 'tool_use_id'),
    toolPayload: toolPayloadFor(toolUse, toolResult),
    toolFilePath: toolFilePathFrom(toolName, toolInput),
    occurredAt: readDate(line, 'timestamp'),
  };
}

/**
 * `messages.role` for a transcript line (F4.1's four roles).
 *
 * One line is one Message — the line `uuid` is the dedupe key, so one uuid must mean one row —
 * which leaves the question of what a tool interaction is. A turn whose blocks are tool traffic
 * and nothing else is recorded as `tool`, so the timeline renders it as `tool_used`
 * (TDS 04 §6.7) rather than as an assistant turn with no visible text; a turn that also speaks
 * keeps its speaking role.
 */
function roleFor(
  type: string,
  message: Record<string, unknown>,
  blocks: unknown[] | null,
  hasToolUse: boolean,
  hasToolResult: boolean,
  text: string,
): MessageRole {
  if (blocks !== null && text.length === 0 && (hasToolUse || hasToolResult)) return 'tool';

  const declared = message['role'];
  if (declared === 'user' || declared === 'assistant' || declared === 'system') return declared;
  return type === 'assistant' ? 'assistant' : 'user';
}

function toolPayloadFor(
  toolUse: Record<string, unknown> | null,
  toolResult: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (toolUse === null && toolResult === null) return null;
  return {
    input: toolUse === null ? null : (toolUse['input'] ?? null),
    response: toolResult === null ? null : (toolResult['content'] ?? null),
  };
}

/**
 * `content` is a string in some runtime versions and a block array in others. Both are kept:
 * the array verbatim in `content_blocks` (faithful re-rendering, TDS 03 §3.11), the rendered
 * text in `content` (searchable, exportable, and the A13 title-derivation input).
 */
function normalizeBlocks(content: unknown): unknown[] | null {
  return Array.isArray(content) ? content : null;
}

function renderText(content: unknown, blocks: unknown[] | null): string {
  if (typeof content === 'string') return content;
  if (blocks === null) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry['type'] === 'text' && typeof entry['text'] === 'string') parts.push(entry['text']);
  }
  return parts.join('\n');
}

function firstBlockOfType(blocks: unknown[] | null, type: string): Record<string, unknown> | null {
  if (blocks === null) return null;
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry['type'] === type) return entry;
  }
  return null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readDate(source: Record<string, unknown>, key: string): Date | null {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function drift(reason: string): ParsedTranscriptLine {
  return { kind: 'drift', reason: reason.slice(0, MAX_REASON_LENGTH) };
}
