import { describe, expect, it, vi } from 'vitest';
import {
  type ExecutorDeps,
  testClaudeCode,
  testGithub,
  testObsidian,
  testTelegram,
} from './executors.js';
import {
  type CommandProbeOutcome,
  type HttpProbeOutcome,
  type PathProbeOutcome,
  redactSecret,
  withTimeout,
} from './ports.js';

/**
 * The §7.4 executors against stubbed transports — **no network, no filesystem, no child
 * process** (TDS 07 §1). Three paths per executor, because all three are things an operator
 * hits: it works, it says no, and it never answers at all.
 *
 * The timeout cases matter most. `POST /sessions/{id}/start` once hung for 45 s behind an
 * unbounded call; a stub that never resolves is how that regression is prevented from here on,
 * and it only works because the bound is enforced in this process rather than by the far end.
 */

const NEVER = new Promise<never>(() => undefined);

function deps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    http: overrides.http ?? (() => NEVER),
    path: overrides.path ?? (() => NEVER),
    command: overrides.command ?? (() => NEVER),
    // A monotone fake clock: `latencyMs` becomes deterministic without waiting for anything.
    clock: overrides.clock ?? fakeClock(),
  };
}

function fakeClock(step = 25) {
  let now = 1_770_000_000_000;
  return {
    now(): number {
      const value = now;
      now += step;
      return value;
    },
  };
}

function http(outcome: HttpProbeOutcome): ExecutorDeps['http'] {
  return () => Promise.resolve(outcome);
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return http({ kind: 'response', status, headers, body: JSON.stringify(body) });
}

// ------------------------------------------------------------------------------------ github

describe('github (§7.4 — identity call)', () => {
  it('reports the authenticated account and the token scopes', async () => {
    const result = await testGithub(
      deps({ http: response(200, { login: 'cento007' }, { 'x-oauth-scopes': 'repo, read:org' }) }),
      { token: 'ghp_valid' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Authenticated as cento007');
    expect(result.detail).toEqual({ account: 'cento007', scopes: ['repo', 'read:org'] });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the PAT as a bearer token and nothing else', async () => {
    const probe = vi.fn<ExecutorDeps['http']>(async () => ({
      kind: 'response',
      status: 200,
      headers: {},
      body: '{"login":"cento007"}',
    }));

    await testGithub(deps({ http: probe }), { token: 'ghp_valid' });

    const request = probe.mock.calls[0]?.[0];
    expect(request?.url).toBe('https://api.github.com/user');
    expect(request?.headers?.['authorization']).toBe('Bearer ghp_valid');
    expect(request?.timeoutMs).toBe(5_000);
  });

  it('answers a rejected token as data, with the fix in the message', async () => {
    const result = await testGithub(deps({ http: response(401, { message: 'Bad credentials' }) }), {
      token: 'ghp_revoked',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('personal access token');
    expect(result.detail).toMatchObject({ reason: 'unauthorized' });
  });

  it('completes when the transport never does', async () => {
    const result = await testGithub(deps({ http: () => Promise.resolve({ kind: 'timeout' }) }), {
      token: 'ghp_valid',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out after 5000 ms');
    expect(result.detail).toMatchObject({ reason: 'timeout', timeoutMs: 5_000 });
  });

  it('reports an unreachable host without blaming the token', async () => {
    const result = await testGithub(
      deps({
        http: () => Promise.resolve({ kind: 'unreachable', reason: 'getaddrinfo ENOTFOUND' }),
      }),
      { token: 'ghp_valid' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not reach api.github.com');
    expect(result.message).toContain('ENOTFOUND');
  });

  it('never echoes the token, even when the far end does', async () => {
    const result = await testGithub(
      deps({ http: response(403, { message: 'token ghp_leaky is not allowed' }) }),
      { token: 'ghp_leaky' },
    );

    expect(JSON.stringify(result)).not.toContain('ghp_leaky');
    expect(result.message).toContain('«redacted»');
  });
});

// ---------------------------------------------------------------------------------- telegram

describe('telegram (§7.4 — getMe)', () => {
  it('reports the bot and states that no message was sent', async () => {
    const result = await testTelegram(
      deps({ http: response(200, { ok: true, result: { username: 'mc_bot', id: 42 } }) }),
      { botToken: '123:ABC', chatId: '-100123' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('Bot @mc_bot reachable');
    expect(result.message).toContain('no test message sent');
    expect(result.detail).toMatchObject({ botUsername: 'mc_bot', testMessageSent: false });
  });

  it('says when there is no chat id to deliver to', async () => {
    const result = await testTelegram(
      deps({ http: response(200, { ok: true, result: { username: 'mc_bot' } }) }),
      { botToken: '123:ABC', chatId: null },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('no chat ID configured');
    expect(result.detail).toMatchObject({ chatIdConfigured: false });
  });

  it('rejects a bad token as data', async () => {
    const result = await testTelegram(
      deps({ http: response(401, { ok: false, description: 'Unauthorized' }) }),
      { botToken: '123:BAD', chatId: null },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('BotFather');
  });

  it('completes on a stalled transport', async () => {
    const result = await testTelegram(deps({ http: () => Promise.resolve({ kind: 'timeout' }) }), {
      botToken: '123:ABC',
      chatId: null,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out');
  });

  it('never leaks the bot token, which travels in the URL', async () => {
    // The failure mode this guards: undici quotes the request URL in its error, and the URL
    // *is* `https://api.telegram.org/bot‹TOKEN›/getMe`.
    const result = await testTelegram(
      deps({
        http: () =>
          Promise.resolve({
            kind: 'unreachable',
            reason: 'request to https://api.telegram.org/bot123456:SECRETVALUE/getMe failed',
          }),
      }),
      { botToken: '123456:SECRETVALUE', chatId: null },
    );

    expect(JSON.stringify(result)).not.toContain('SECRETVALUE');
    expect(result.message).toContain('«redacted»');
  });
});

// ---------------------------------------------------------------------------------- obsidian

function path(outcome: PathProbeOutcome): ExecutorDeps['path'] {
  return () => Promise.resolve(outcome);
}

describe('obsidian (§7.4 — vault path)', () => {
  it('passes when the path is a readable, writable directory', async () => {
    const result = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: true,
          isDirectory: true,
          readable: true,
          writable: true,
        }),
      }),
      { vaultPath: 'D:\\Vaults\\Engineering' },
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toMatchObject({ path: 'D:\\Vaults\\Engineering', isDirectory: true });
  });

  it('distinguishes missing, not-a-directory and not-writable', async () => {
    const missing = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: false,
          isDirectory: false,
          readable: false,
          writable: false,
        }),
      }),
      { vaultPath: 'D:\\nope' },
    );
    const file = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: true,
          isDirectory: false,
          readable: true,
          writable: true,
        }),
      }),
      { vaultPath: 'D:\\vault.md' },
    );
    const readOnly = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: true,
          isDirectory: true,
          readable: true,
          writable: false,
        }),
      }),
      { vaultPath: 'D:\\Vaults\\Locked' },
    );

    expect(missing.message).toContain('does not exist');
    expect(file.message).toContain('is a file');
    // Two-way sync writes into the vault, so read-only is a failure and not a warning.
    expect(readOnly.ok).toBe(false);
    expect(readOnly.message).toContain('not writable');
  });

  it('completes when the filesystem stalls — a disconnected share must not hang the request', async () => {
    const result = await testObsidian(deps({ path: () => Promise.resolve({ kind: 'timeout' }) }), {
      vaultPath: '\\\\nas\\vault',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out');
    expect(result.message).toContain('network share');
  });
});

// ------------------------------------------------------------------------------- claude code

function command(outcome: CommandProbeOutcome): ExecutorDeps['command'] {
  return () => Promise.resolve(outcome);
}

describe('claude-code (§7.4 — CLI version probe)', () => {
  it('reports the version from a configured path', async () => {
    const probe = vi.fn<ExecutorDeps['command']>(async () => ({
      kind: 'exit',
      code: 0,
      stdout: '2.1.4 (Claude Code)\n',
      stderr: '',
    }));

    const result = await testClaudeCode(deps({ command: probe }), {
      cliPath: 'C:\\Users\\op\\claude.exe',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Claude Code CLI 2.1.4 (Claude Code)');
    expect(result.detail).toMatchObject({
      source: 'setting',
      executable: 'C:\\Users\\op\\claude.exe',
    });
    expect(probe).toHaveBeenCalledWith('C:\\Users\\op\\claude.exe', ['--version'], 10_000);
  });

  it('falls back to PATH when no path is configured, and says so', async () => {
    // `''` is the documented "use the binary the SDK ships with" (§7.2) — testing PATH is what
    // the runtime would actually do, so refusing with INTEGRATION_NOT_CONFIGURED would be a
    // refusal to answer a question that has an answer.
    const probe = vi.fn<ExecutorDeps['command']>(async () => ({
      kind: 'exit',
      code: 0,
      stdout: '2.1.4',
      stderr: '',
    }));

    const result = await testClaudeCode(deps({ command: probe }), { cliPath: '' });

    expect(result.ok).toBe(true);
    expect(result.detail).toMatchObject({ source: 'path_lookup', executable: 'claude' });
    expect(probe).toHaveBeenCalledWith('claude', ['--version'], 10_000);
  });

  it('reports a missing executable differently for a set path and for PATH', async () => {
    const configured = await testClaudeCode(deps({ command: command({ kind: 'not_found' }) }), {
      cliPath: 'C:\\wrong\\claude.exe',
    });
    const unconfigured = await testClaudeCode(deps({ command: command({ kind: 'not_found' }) }), {
      cliPath: '',
    });

    expect(configured.message).toBe('No executable at that path');
    expect(unconfigured.message).toContain('on PATH');
  });

  it('reports a nonzero exit with the CLI\u2019s own stderr, capped', async () => {
    const result = await testClaudeCode(
      deps({ command: command({ kind: 'exit', code: 1, stdout: '', stderr: 'boom\n' }) }),
      { cliPath: 'claude' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited 1');
    expect(result.detail).toMatchObject({ stderr: 'boom' });
  });

  it('completes when the CLI never exits', async () => {
    // Belt and braces: the port carries `execFile`'s own timeout AND the executor races it, so
    // a probe double that ignores the timeout still cannot hang the request. The bound is
    // shortened here so the assertion costs milliseconds rather than the real ten seconds.
    const result = await testClaudeCode(
      { ...deps({ command: () => NEVER }), timeouts: { commandMs: 20 } },
      { cliPath: 'claude' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('did not answer within 20 ms');
  });
});

// ------------------------------------------------------------------------------------ shared

describe('bounds and redaction', () => {
  it('withTimeout resolves the fallback when the work never settles', async () => {
    expect(await withTimeout(NEVER, 5, 'fallback')).toBe('fallback');
  });

  it('withTimeout resolves the fallback when the work rejects', async () => {
    expect(await withTimeout(Promise.reject(new Error('nope')), 1_000, 'fallback')).toBe(
      'fallback',
    );
  });

  it('redactSecret removes every occurrence and ignores trivially short values', () => {
    expect(redactSecret('a TOKEN and TOKEN again', 'TOKEN')).toBe(
      'a «redacted» and «redacted» again',
    );
    expect(redactSecret('nothing to do', null)).toBe('nothing to do');
    // A 3-character "secret" would redact half the message; that is noise, not protection.
    expect(redactSecret('abc def', 'abc')).toBe('abc def');
  });
});
