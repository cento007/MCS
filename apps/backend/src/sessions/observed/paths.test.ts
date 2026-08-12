import { isAbsolute, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeConfigDir,
  computeTranscriptPath,
  encodeProjectDirectory,
  isUsableTranscriptPath,
} from './paths.js';

/**
 * Path resolution (TDS 07 §5.4: *"encoded-cwd path computation tested for both
 * `~/.claude/projects/...` and `%USERPROFILE%\\.claude\\projects\\...`, honoring
 * `CLAUDE_CONFIG_DIR` (F1.5) — pure-function unit tests, both separators"*).
 *
 * The *platform* is injected so the "which environment variable names the home directory"
 * decision is tested on both OSes from either OS. Path **mechanics** (`join`, `isAbsolute`)
 * deliberately stay host-native: the Backend reads these files on the machine it runs on, so a
 * Windows drive letter resolved on Linux is a case that cannot occur — and pretending to
 * support it would mean carrying a second, untested path implementation.
 */

describe('claudeConfigDir', () => {
  it('takes the home directory from HOME on POSIX', () => {
    const dir = claudeConfigDir({ platform: 'linux', env: { HOME: `${sep}home${sep}op` } });
    expect(dir).toBe(join(`${sep}home${sep}op`, '.claude'));
  });

  it('prefers USERPROFILE over HOME on Windows', () => {
    // Git Bash sets both; on Windows the profile is the one Claude Code uses (spike §8).
    const dir = claudeConfigDir({
      platform: 'win32',
      env: { USERPROFILE: `${sep}users${sep}op`, HOME: `${sep}msys${sep}home` },
    });

    expect(dir).toBe(join(`${sep}users${sep}op`, '.claude'));
    expect(dir).not.toContain('msys');
  });

  it('honours CLAUDE_CONFIG_DIR over the home directory', () => {
    const override = resolve(sep, 'srv', 'claude');
    expect(claudeConfigDir({ platform: 'linux', env: { CLAUDE_CONFIG_DIR: override } })).toBe(
      override,
    );
    expect(
      claudeConfigDir({
        platform: 'win32',
        env: { CLAUDE_CONFIG_DIR: override, USERPROFILE: sep },
      }),
    ).toBe(override);
  });

  it('ignores an empty CLAUDE_CONFIG_DIR rather than resolving it to nothing', () => {
    const dir = claudeConfigDir({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: '', HOME: `${sep}home${sep}op` },
    });
    expect(dir).toBe(join(`${sep}home${sep}op`, '.claude'));
  });

  it('resolves a relative CLAUDE_CONFIG_DIR against home instead of the process cwd', () => {
    const dir = claudeConfigDir({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: 'claude-alt', HOME: `${sep}home${sep}op` },
    });
    expect(dir).toBe(join(`${sep}home${sep}op`, 'claude-alt'));
  });
});

describe('encodeProjectDirectory', () => {
  it('maps every non-alphanumeric character to a dash — Windows form', () => {
    expect(encodeProjectDirectory('D:\\Repos\\MCS')).toBe('D--Repos-MCS');
  });

  it('maps every non-alphanumeric character to a dash — POSIX form', () => {
    expect(encodeProjectDirectory('/home/op/proj')).toBe('-home-op-proj');
  });

  it('is positional, not collapsing: a doubled separator stays two dashes', () => {
    expect(encodeProjectDirectory('/a//b')).toBe('-a--b');
  });

  it('encodes dots and spaces too — the runtime keeps only [A-Za-z0-9]', () => {
    expect(encodeProjectDirectory('/home/op/my proj.v2')).toBe('-home-op-my-proj-v2');
  });
});

describe('computeTranscriptPath', () => {
  it('builds <config-dir>/projects/<encoded-cwd>/<runtime-session-id>.jsonl', () => {
    const configDir = resolve(sep, 'srv', 'claude');
    const path = computeTranscriptPath('/home/op/proj', 'abc-123', {
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    expect(path).toBe(join(configDir, 'projects', '-home-op-proj', 'abc-123.jsonl'));
    expect(isAbsolute(path)).toBe(true);
  });
});

describe('isUsableTranscriptPath', () => {
  it('accepts an absolute .jsonl path', () => {
    expect(isUsableTranscriptPath(resolve(sep, 'home', 'op', 'abc.jsonl'))).toBe(true);
  });

  it('rejects a relative path, a non-JSONL path and a non-string', () => {
    // The value arrives on the wire from a hook POST and is handed to `fs.open`. This is not a
    // sandbox — the token scope is — but obvious nonsense never reaches the filesystem.
    expect(isUsableTranscriptPath('relative/path.jsonl')).toBe(false);
    expect(isUsableTranscriptPath(resolve(sep, 'etc', 'shadow'))).toBe(false);
    expect(isUsableTranscriptPath(42)).toBe(false);
    expect(isUsableTranscriptPath('')).toBe(false);
    expect(isUsableTranscriptPath(null)).toBe(false);
  });
});
