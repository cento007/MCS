import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

/**
 * Where Claude Code keeps its state, and how it names a session transcript (spike §3, §8).
 *
 * Pure path arithmetic, deliberately: it is the one part of the observed-session pipeline we
 * can pin with unit tests on both OSes without a runtime, and the fallback we need whenever a
 * hook payload arrives without a `transcript_path`.
 *
 *   <config-dir>/projects/<encoded-cwd>/<runtime-session-id>.jsonl
 *
 * `<config-dir>` is `CLAUDE_CONFIG_DIR` when set, else `~/.claude` — `%USERPROFILE%\.claude`
 * on Windows (F8.1 path rules: absolute native paths, no POSIX assumptions).
 */

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Sub-directory of the config dir that holds one directory per encoded working directory. */
export const CLAUDE_PROJECTS_DIR = 'projects';

export const TRANSCRIPT_EXTENSION = '.jsonl';

export interface ClaudePathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

/**
 * The Claude Code configuration directory.
 *
 * `CLAUDE_CONFIG_DIR` wins outright (spike §3) and is honoured even when relative — resolving
 * it here rather than rejecting it keeps a mis-set env var a *wrong path* the operator can see
 * in the error, not a silent fall-back to a directory they never configured.
 */
export function claudeConfigDir(options: ClaudePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const override = env[CLAUDE_CONFIG_DIR_ENV];
  if (override !== undefined && override.length > 0) {
    return isAbsolute(override) ? override : join(resolveHome(options, env, platform), override);
  }

  return join(resolveHome(options, env, platform), '.claude');
}

function resolveHome(
  options: ClaudePathOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (options.home !== undefined && options.home.length > 0) return options.home;

  if (platform === 'win32') {
    const profile = env['USERPROFILE'];
    if (profile !== undefined && profile.length > 0) return profile;
  }

  const home = env['HOME'];
  if (home !== undefined && home.length > 0) return home;

  return homedir();
}

/**
 * The runtime's directory name for a working directory: every non-alphanumeric character
 * becomes `-` (spike §3).
 *
 *   `D:\Repos\MCS`   -> `D--Repos-MCS`
 *   `/home/me/proj`  -> `-home-me-proj`
 *
 * Lossy and not reversible — two different directories can collide — which is exactly why the
 * hook payload's own `transcript_path` is preferred and this is only the fallback.
 */
export function encodeProjectDirectory(workingDirectory: string): string {
  return workingDirectory.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The computed transcript path for a session, used when the hook payload omits one. */
export function computeTranscriptPath(
  workingDirectory: string,
  runtimeSessionId: string,
  options: ClaudePathOptions = {},
): string {
  return join(
    claudeConfigDir(options),
    CLAUDE_PROJECTS_DIR,
    encodeProjectDirectory(workingDirectory),
    `${runtimeSessionId}${TRANSCRIPT_EXTENSION}`,
  );
}

/**
 * Accept a transcript path from a hook payload only if it is absolute and names a JSONL file.
 *
 * The path is used to open a file on the Backend host, so an unvalidated value from the wire
 * would be a file-read primitive for anything holding an ingest token. Absolute-and-`.jsonl`
 * is not a sandbox — it is the cheap gate that keeps obvious nonsense out of `fs.open`; the
 * real containment is the token scope plus systemd's `ReadOnlyPaths` (TDS 02 §9.1).
 */
export function isUsableTranscriptPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    value.toLowerCase().endsWith(TRANSCRIPT_EXTENSION)
  );
}
