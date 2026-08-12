/**
 * `messages.tool_file_path` extraction (TDS 04 §6.10.2, TDS 03 §3.11).
 *
 * WS2 §6.10.2 owns the list of tools that count as touching a file, and pins where the
 * knowledge lives: *"The list is runtime-version-dependent, so it lives in WS1's
 * version-tolerant adapter (F1.5), never in SQL."* This module is that place — one exported
 * predicate, one exported extractor, both pure, both total.
 *
 * `Glob`/`Grep` take a directory or a pattern and `Bash` is opaque; including them would turn
 * "files touched" into "paths mentioned". An unrecognized tool or payload shape yields `null`
 * and must never fail an ingest write (TDS 03 §3.11).
 */

/** The five file-naming tools (TDS 04 §6.10.2, verbatim). */
export const FILE_NAMING_TOOLS = Object.freeze([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
] as const);

export type FileNamingTool = (typeof FILE_NAMING_TOOLS)[number];

/**
 * Keys a tool input may use for its path, in preference order. `notebook_path` is
 * `NotebookEdit`'s spelling; `path` is accepted because it is the shape a future tool is most
 * likely to use and reading one extra key costs nothing.
 */
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/** Absolute native paths can be long, but not this long — a guard against a pathological blob. */
const MAX_PATH_LENGTH = 4096;

export function isFileNamingTool(toolName: unknown): toolName is FileNamingTool {
  return (
    typeof toolName === 'string' && (FILE_NAMING_TOOLS as readonly string[]).includes(toolName)
  );
}

/**
 * The absolute native path a tool invocation named, or `null`.
 *
 * `MultiEdit` counts **once per invocation**, not once per inner edit (§6.10.2), which falls
 * out of this returning a single path rather than a list.
 */
export function toolFilePathFrom(toolName: unknown, toolInput: unknown): string | null {
  if (!isFileNamingTool(toolName)) return null;
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return null;

  const input = toolInput as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH) {
      return value;
    }
  }
  return null;
}
