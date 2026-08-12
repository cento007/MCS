import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildHookEntry,
  HOOK_INGEST_PATH,
  hooksStatePath,
  installHookProfile,
  isMissionControlHookEntry,
  mergeHookProfile,
  readInstallState,
  removeHookProfile,
  resolveSettingsPath,
  uninstallHookProfile,
} from './hooks-installer.js';

/**
 * The settings-writer (TDS 02 §6.2).
 *
 * The property under test throughout is the one that matters to somebody who did not ask us to
 * touch their file: **an operator's own hooks and settings survive install, re-install and
 * uninstall byte-for-byte**, including shapes this code does not recognise. The merge is pure,
 * so most of that is provable without a disk; the last three cases exercise the real files,
 * the backup and the state record.
 */

const INGEST_URL = `http://127.0.0.1:8710${HOOK_INGEST_PATH}`;
const TOKEN = 'mct_notarealtoken_0123456789';

/** A settings file with the operator's own hooks in it, plus keys we know nothing about. */
function operatorSettings(): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    model: 'claude-opus-4',
    permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm *)'] },
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'pnpm lint:fix' }],
        },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'audit.sh' }] }],
    },
    statusLine: { type: 'command', command: 'my-status-line' },
  };
}

describe('isMissionControlHookEntry', () => {
  it('identifies our entries by the ingest URL, not by a marker we invented', () => {
    expect(isMissionControlHookEntry(buildHookEntry(INGEST_URL, TOKEN))).toBe(true);
    // §6.2's identity rule survives the operator changing MC_HOST/MC_PORT — otherwise a port
    // change would orphan the old entries and every session would fire two hooks.
    expect(
      isMissionControlHookEntry({ type: 'http', url: `https://mc.lan:9000${HOOK_INGEST_PATH}` }),
    ).toBe(true);
    expect(isMissionControlHookEntry({ type: 'http', url: `${INGEST_URL}?v=2` })).toBe(true);
  });

  it("never claims somebody else's hook", () => {
    expect(isMissionControlHookEntry({ type: 'command', command: 'pnpm lint' })).toBe(false);
    expect(isMissionControlHookEntry({ type: 'http', url: 'http://example.test/hooks' })).toBe(
      false,
    );
    expect(isMissionControlHookEntry(null)).toBe(false);
    expect(isMissionControlHookEntry('a string')).toBe(false);
  });
});

describe('mergeHookProfile (pure)', () => {
  it('adds our five hooks and preserves every other setting verbatim', () => {
    const before = operatorSettings();
    const { settings } = mergeHookProfile(before, { entry: buildHookEntry(INGEST_URL, TOKEN) });

    expect(settings['model']).toBe('claude-opus-4');
    expect(settings['permissions']).toEqual(before['permissions']);
    expect(settings['statusLine']).toEqual(before['statusLine']);
    expect(settings['$schema']).toBe(before['$schema']);

    const hooks = settings['hooks'] as Record<string, unknown[]>;
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(hooks[event]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("leaves the operator's own hook entries in place, alongside ours", () => {
    const { settings } = mergeHookProfile(operatorSettings(), {
      entry: buildHookEntry(INGEST_URL, TOKEN),
    });
    const hooks = settings['hooks'] as Record<string, unknown[]>;

    expect(JSON.stringify(hooks['PostToolUse'])).toContain('pnpm lint:fix');
    expect(JSON.stringify(hooks['SessionStart'])).toContain('echo hello');
    // An event we never touch is not even reordered.
    const before = operatorSettings()['hooks'] as Record<string, unknown>;
    expect(hooks['PreToolUse']).toEqual(before['PreToolUse']);
  });

  it('replaces our own entries on re-install instead of duplicating them', () => {
    const once = mergeHookProfile(operatorSettings(), {
      entry: buildHookEntry(INGEST_URL, TOKEN),
    });
    const twice = mergeHookProfile(once.settings, {
      entry: buildHookEntry(INGEST_URL, 'mct_a_rotated_token'),
    });

    expect(twice.replaced).toBe(5);

    const serialized = JSON.stringify(twice.settings);
    expect(serialized.split(HOOK_INGEST_PATH).length - 1).toBe(5);
    expect(serialized).toContain('mct_a_rotated_token');
    expect(serialized).not.toContain(TOKEN);
  });

  it('installs into an empty or absent settings object', () => {
    expect(
      mergeHookProfile(undefined, { entry: buildHookEntry(INGEST_URL, TOKEN) }).settings,
    ).toHaveProperty('hooks');
    expect(
      mergeHookProfile({}, { entry: buildHookEntry(INGEST_URL, TOKEN) }).settings,
    ).toHaveProperty('hooks');
  });

  it('preserves a hook shape it does not understand rather than normalising it', () => {
    const weird = { hooks: { Stop: { somethingUnexpected: true } } };
    const { settings } = mergeHookProfile(weird, { entry: buildHookEntry(INGEST_URL, TOKEN) });
    const stop = (settings['hooks'] as Record<string, unknown[]>)['Stop'] as unknown[];

    expect(stop[0]).toEqual({ somethingUnexpected: true });
    expect(stop).toHaveLength(2);
  });

  it('carries the token in a header, never in the URL', () => {
    const entry = buildHookEntry(INGEST_URL, TOKEN);
    expect(entry.url).not.toContain(TOKEN);
    expect(entry.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('emits a matcher only for the tool hook', () => {
    const { settings } = mergeHookProfile({}, { entry: buildHookEntry(INGEST_URL, TOKEN) });
    const hooks = settings['hooks'] as Record<string, Record<string, unknown>[]>;

    expect(hooks['PostToolUse']?.[0]?.['matcher']).toBe('*');
    expect(hooks['SessionStart']?.[0]).not.toHaveProperty('matcher');
  });
});

describe('removeHookProfile (pure)', () => {
  it("restores the operator's settings exactly", () => {
    const before = operatorSettings();
    const installed = mergeHookProfile(before, { entry: buildHookEntry(INGEST_URL, TOKEN) });
    const { settings, removed } = removeHookProfile(installed.settings);

    expect(removed).toBe(5);
    expect(settings).toEqual(before);
  });

  it('is a no-op on a file we never touched', () => {
    const before = operatorSettings();
    const { settings, removed } = removeHookProfile(before);

    expect(removed).toBe(0);
    expect(settings).toEqual(before);
  });

  it('drops the `hooks` key entirely when it existed only because of us', () => {
    const installed = mergeHookProfile(
      { model: 'x' },
      {
        entry: buildHookEntry(INGEST_URL, TOKEN),
      },
    );
    expect(removeHookProfile(installed.settings).settings).toEqual({ model: 'x' });
  });

  it('keeps a mixed group, minus our entry', () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'mine' }, buildHookEntry(INGEST_URL, TOKEN)],
          },
        ],
      },
    };

    const { settings, removed } = removeHookProfile(mixed);
    expect(removed).toBe(1);
    expect(settings).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
    });
  });
});

describe('resolveSettingsPath', () => {
  it('puts a project-scoped profile in <projectRoot>/.claude/settings.json', () => {
    const root = join(sep, 'repos', 'mcs');
    expect(resolveSettingsPath({ scope: 'project', projectRoot: root })).toBe(
      join(root, '.claude', 'settings.json'),
    );
  });

  it('puts a user-scoped profile under the Claude config dir, honouring CLAUDE_CONFIG_DIR', () => {
    const configDir = join(sep, 'srv', 'claude');
    expect(
      resolveSettingsPath({
        scope: 'user',
        platform: 'linux',
        env: { CLAUDE_CONFIG_DIR: configDir },
      }),
    ).toBe(join(configDir, 'settings.json'));
  });

  it('refuses a project scope with no project root', () => {
    expect(() => resolveSettingsPath({ scope: 'project' })).toThrow(/projectRoot/);
  });
});

describe('install / uninstall on the real filesystem', () => {
  let dataDir: string;
  let claudeDir: string;
  let settingsPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mc-data-'));
    claudeDir = mkdtempSync(join(tmpdir(), 'mc-claude-'));
    mkdirSync(claudeDir, { recursive: true });
    settingsPath = join(claudeDir, 'settings.json');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  async function install(token = TOKEN): Promise<Awaited<ReturnType<typeof installHookProfile>>> {
    return installHookProfile({
      ingestUrl: INGEST_URL,
      token,
      scope: 'user',
      settingsPath,
      dataDir,
    });
  }

  function readSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  }

  it('merges into an existing settings file, backs it up, and records the install', async () => {
    writeFileSync(settingsPath, `${JSON.stringify(operatorSettings(), null, 2)}\n`);

    const result = await install();

    expect(result.createdSettingsFile).toBe(false);
    expect(result.backupPath).not.toBeNull();
    // The backup is the file as it was, not as we left it.
    expect(JSON.parse(readFileSync(result.backupPath as string, 'utf8'))).toEqual(
      operatorSettings(),
    );

    const written = readSettings();
    expect(written['model']).toBe('claude-opus-4');
    expect(JSON.stringify(written)).toContain('pnpm lint:fix');
    expect(JSON.stringify(written)).toContain(TOKEN);

    const state = await readInstallState(dataDir);
    expect(state.installs).toHaveLength(1);
    expect(state.installs[0]).toMatchObject({
      scope: 'user',
      settingsPath,
      ingestUrl: INGEST_URL,
      tokenPrefix: TOKEN.slice(0, 8),
      hookToken: TOKEN,
    });
    // TDS 02 §6.2 / §1.2: the state file lives under MC_DATA_DIR/hooks/.
    expect(result.statePath).toBe(hooksStatePath(dataDir));
    expect(result.statePath).toBe(join(dataDir, 'hooks', 'state.json'));
  });

  it('creates the settings file when there is none, and takes no backup', async () => {
    const result = await install();

    expect(result.createdSettingsFile).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(Object.keys(readSettings())).toEqual(['hooks']);
  });

  it("can be reverted, leaving the operator's file as it was", async () => {
    writeFileSync(settingsPath, `${JSON.stringify(operatorSettings(), null, 2)}\n`);
    await install();

    const result = await uninstallHookProfile({ dataDir });

    expect(result.removedFrom).toEqual([settingsPath]);
    expect(result.entriesRemoved).toBe(5);
    expect(readSettings()).toEqual(operatorSettings());
    expect((await readInstallState(dataDir)).installs).toHaveLength(0);
  });

  it('is idempotent — re-installing repairs rather than duplicates', async () => {
    writeFileSync(settingsPath, `${JSON.stringify(operatorSettings(), null, 2)}\n`);
    await install();
    await install('mct_rotated_0123456789');

    const serialized = JSON.stringify(readSettings());
    expect(serialized.split(HOOK_INGEST_PATH).length - 1).toBe(5);
    expect(serialized).toContain('mct_rotated_0123456789');
    expect(serialized).not.toContain(TOKEN);

    // One install record per settings file, not one per run.
    expect((await readInstallState(dataDir)).installs).toHaveLength(1);

    await uninstallHookProfile({ dataDir });
    expect(readSettings()).toEqual(operatorSettings());
  });

  it('refuses to write a settings file it could not parse', async () => {
    writeFileSync(settingsPath, '{ this is not json');

    await expect(install()).rejects.toThrow(/not valid JSON/);
    // The unreadable file is still exactly as the operator left it.
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ this is not json');
  });

  it('reports a settings file that no longer holds our hooks instead of rewriting it', async () => {
    await install();
    writeFileSync(settingsPath, `${JSON.stringify({ model: 'edited by hand' }, null, 2)}\n`);

    const result = await uninstallHookProfile({ dataDir });

    expect(result.removedFrom).toEqual([]);
    expect(result.missing).toEqual([settingsPath]);
    expect(readSettings()).toEqual({ model: 'edited by hand' });
  });

  it('treats an absent state file as "nothing installed"', async () => {
    const state = await readInstallState(dataDir);
    expect(state.installs).toEqual([]);

    const result = await uninstallHookProfile({ dataDir });
    expect(result.removedFrom).toEqual([]);
  });
});
