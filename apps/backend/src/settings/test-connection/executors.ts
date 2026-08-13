import type { TestConnectionResult } from '@mc/shared';
import {
  COMMAND_TIMEOUT_MS,
  type CommandProbe,
  type HttpProbe,
  NETWORK_TIMEOUT_MS,
  type PathProbe,
  redactSecret,
  withTimeout,
} from './ports.js';

/**
 * The Test Connection executors (TDS 04 §7.4) — one per integration, each a pure function over
 * the ports in `ports.ts` and the **persisted** settings it was handed.
 *
 * Rules every executor obeys:
 *
 *  1. **A failure is a result, not an exception.** §7.4: "a completed check is a 200 regardless
 *     of outcome — failure of the *integration* is data, not an API error". The operator is
 *     pressing this button precisely because something might be broken; answering 500 would
 *     turn the diagnostic into a second fault to diagnose.
 *  2. **The message names what was checked and what to do.** "Token rejected by GitHub (401)"
 *     is worth ten "Connection failed"s.
 *  3. **No secret leaves in a message or a detail.** Everything derived from a transport error
 *     goes through `redactSecret` first — the Telegram token travels in the URL.
 *  4. **The check tests persisted state** (WS5 §5.7.2): these functions receive values read
 *     from the database, never a request body. The UI disables the button while the panel is
 *     dirty for the same reason, and the result line says "Tested saved settings".
 */

export interface ProbeClock {
  now(): number;
}

const SYSTEM_CLOCK: ProbeClock = { now: () => Date.now() };

export interface ExecutorDeps {
  readonly http: HttpProbe;
  readonly path: PathProbe;
  readonly command: CommandProbe;
  readonly clock?: ProbeClock;
  /**
   * Overridable bounds; the defaults are the `ports.ts` constants.
   *
   * They exist so a test can prove the *timeout path* in milliseconds instead of waiting out a
   * real ten-second CLI bound — a suite that takes ten seconds to assert one thing is a suite
   * people stop running.
   */
  readonly timeouts?: { readonly networkMs?: number; readonly commandMs?: number };
}

function networkTimeout(deps: ExecutorDeps): number {
  return deps.timeouts?.networkMs ?? NETWORK_TIMEOUT_MS;
}

function commandTimeout(deps: ExecutorDeps): number {
  return deps.timeouts?.commandMs ?? COMMAND_TIMEOUT_MS;
}

interface ResultInput {
  readonly ok: boolean;
  readonly message: string;
  readonly detail?: Record<string, unknown> | null;
  readonly startedAt: number;
  readonly clock: ProbeClock;
}

function finish(input: ResultInput): TestConnectionResult {
  const finishedAt = input.clock.now();
  return {
    ok: input.ok,
    checkedAt: new Date(finishedAt).toISOString(),
    latencyMs: Math.max(0, finishedAt - input.startedAt),
    message: input.message,
    detail: input.detail ?? null,
  };
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------ github

export const GITHUB_IDENTITY_URL = 'https://api.github.com/user';

/**
 * §7.4: "authenticated API call with the stored PAT". `GET /user` is the smallest one that
 * proves the token is valid, names the account it belongs to, and — through
 * `x-oauth-scopes` — reports what it may actually do, which is the failure operators hit
 * second (a valid token missing `repo`).
 */
export async function testGithub(
  deps: ExecutorDeps,
  input: { readonly token: string },
): Promise<TestConnectionResult> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const startedAt = clock.now();

  const timeoutMs = networkTimeout(deps);
  const outcome = await deps.http({
    url: GITHUB_IDENTITY_URL,
    timeoutMs,
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub rejects requests without one, with a 403 that reads like an auth failure.
      'user-agent': 'mission-control',
    },
  });

  const redact = (text: string): string => redactSecret(text, input.token);

  if (outcome.kind === 'timeout') {
    return finish({
      ok: false,
      message: `Timed out after ${timeoutMs} ms contacting api.github.com`,
      detail: { reason: 'timeout', timeoutMs },
      startedAt,
      clock,
    });
  }
  if (outcome.kind === 'unreachable') {
    return finish({
      ok: false,
      message: `Could not reach api.github.com — ${redact(outcome.reason)}`,
      detail: { reason: 'unreachable' },
      startedAt,
      clock,
    });
  }

  const scopes = (outcome.headers['x-oauth-scopes'] ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  if (outcome.status === 200) {
    const body = parseJson(outcome.body);
    const account = typeof body?.['login'] === 'string' ? body['login'] : null;
    return finish({
      ok: true,
      message: account === null ? 'Authenticated with GitHub' : `Authenticated as ${account}`,
      detail: { account, scopes },
      startedAt,
      clock,
    });
  }

  if (outcome.status === 401) {
    return finish({
      ok: false,
      message:
        'Token rejected by GitHub (401). Create a new personal access token and save it here.',
      detail: { reason: 'unauthorized', status: 401 },
      startedAt,
      clock,
    });
  }

  const message =
    typeof parseJson(outcome.body)?.['message'] === 'string'
      ? String(parseJson(outcome.body)?.['message'])
      : null;

  return finish({
    ok: false,
    message: `GitHub answered ${outcome.status}${message === null ? '' : ` — ${redact(message)}`}`,
    detail: { reason: 'http_error', status: outcome.status, scopes },
    startedAt,
    clock,
  });
}

// ---------------------------------------------------------------------------------- telegram

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/**
 * §7.4: "`getMe` + optional test message". This runs `getMe` only.
 *
 * `getMe` proves the bot token is valid and names the bot. It deliberately does **not** send a
 * message, and the result says so — a "test" with an externally visible side effect the
 * operator cannot take back needs a stronger justification than confirming a chat id, and the
 * Telegram Worker (Phase 2) is not deployed to make use of the confirmation yet.
 */
export async function testTelegram(
  deps: ExecutorDeps,
  input: { readonly botToken: string; readonly chatId: string | null },
): Promise<TestConnectionResult> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const startedAt = clock.now();
  const redact = (text: string): string => redactSecret(text, input.botToken);

  // The credential is IN THE URL. Nothing built from this string may be logged or returned
  // without passing through `redact` first.
  const timeoutMs = networkTimeout(deps);
  const outcome = await deps.http({
    url: `${TELEGRAM_API_ORIGIN}/bot${input.botToken}/getMe`,
    timeoutMs,
    headers: { accept: 'application/json' },
  });

  const chatNote =
    input.chatId === null
      ? ' — no chat ID configured, so delivery is not verified'
      : ' — chat ID not verified (no test message sent)';

  if (outcome.kind === 'timeout') {
    return finish({
      ok: false,
      message: `Timed out after ${timeoutMs} ms contacting api.telegram.org`,
      detail: { reason: 'timeout', timeoutMs },
      startedAt,
      clock,
    });
  }
  if (outcome.kind === 'unreachable') {
    return finish({
      ok: false,
      message: `Could not reach api.telegram.org — ${redact(outcome.reason)}`,
      detail: { reason: 'unreachable' },
      startedAt,
      clock,
    });
  }

  const body = parseJson(outcome.body);
  const bot =
    typeof body?.['result'] === 'object' && body['result'] !== null
      ? (body['result'] as Record<string, unknown>)
      : null;
  const username = typeof bot?.['username'] === 'string' ? bot['username'] : null;

  if (outcome.status === 200 && body?.['ok'] === true) {
    return finish({
      ok: true,
      message: `${username === null ? 'Bot token accepted' : `Bot @${username} reachable`}${chatNote}`,
      detail: {
        botUsername: username,
        chatIdConfigured: input.chatId !== null,
        testMessageSent: false,
      },
      startedAt,
      clock,
    });
  }

  const description =
    typeof body?.['description'] === 'string' ? redact(body['description']) : null;

  return finish({
    ok: false,
    message:
      outcome.status === 401
        ? 'Bot token rejected by Telegram (401). Re-issue the token with @BotFather and save it here.'
        : `Telegram answered ${outcome.status}${description === null ? '' : ` — ${description}`}`,
    detail: {
      reason: outcome.status === 401 ? 'unauthorized' : 'http_error',
      status: outcome.status,
    },
    startedAt,
    clock,
  });
}

// ---------------------------------------------------------------------------------- obsidian

/** §7.4: "vault path exists/readable/writable". No file is created to prove writability. */
export async function testObsidian(
  deps: ExecutorDeps,
  input: { readonly vaultPath: string },
): Promise<TestConnectionResult> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const startedAt = clock.now();

  const outcome = await deps.path(input.vaultPath);

  if (outcome.kind === 'timeout') {
    return finish({
      ok: false,
      message: 'Timed out reading the vault path — is it on a disconnected network share?',
      detail: { reason: 'timeout', path: input.vaultPath },
      startedAt,
      clock,
    });
  }
  if (outcome.kind === 'error') {
    return finish({
      ok: false,
      message: `Could not read the vault path — ${outcome.reason}`,
      detail: { reason: 'unreadable', path: input.vaultPath },
      startedAt,
      clock,
    });
  }
  if (!outcome.exists) {
    return finish({
      ok: false,
      message: 'Vault path does not exist on this machine',
      detail: { reason: 'missing', path: input.vaultPath },
      startedAt,
      clock,
    });
  }
  if (!outcome.isDirectory) {
    return finish({
      ok: false,
      message: 'Vault path is a file, not a directory',
      detail: { reason: 'not_a_directory', path: input.vaultPath },
      startedAt,
      clock,
    });
  }
  if (!outcome.readable || !outcome.writable) {
    return finish({
      ok: false,
      // Two-way sync writes into the vault, so read-only is a real failure and not a warning.
      message: outcome.readable
        ? 'Vault directory is not writable by Mission Control'
        : 'Vault directory is not readable by Mission Control',
      detail: {
        reason: 'permission',
        path: input.vaultPath,
        readable: outcome.readable,
        writable: outcome.writable,
      },
      startedAt,
      clock,
    });
  }

  return finish({
    ok: true,
    message: 'Vault directory exists and is readable and writable',
    detail: { path: input.vaultPath, isDirectory: true, readable: true, writable: true },
    startedAt,
    clock,
  });
}

// ------------------------------------------------------------------------------- claude code

/** F8.1: an absolute executable path, invoked with `execFile` and no shell. */
export const DEFAULT_CLAUDE_EXECUTABLE = 'claude';

/**
 * §7.4: "`execFile(cliPath, ['--version'])` (F8.1 validation)".
 *
 * An unset `cliPath` is **not** `INTEGRATION_NOT_CONFIGURED`: `''` is the documented "use the
 * binary the SDK ships with" (§7.2), so the honest check is the one the runtime would make —
 * resolve `claude` on PATH — and the result says which of the two was tested.
 */
export async function testClaudeCode(
  deps: ExecutorDeps,
  input: { readonly cliPath: string },
): Promise<TestConnectionResult> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const startedAt = clock.now();

  const configured = input.cliPath.trim().length > 0;
  const executable = configured ? input.cliPath.trim() : DEFAULT_CLAUDE_EXECUTABLE;
  const source = configured ? 'setting' : 'path_lookup';

  const timeoutMs = commandTimeout(deps);
  const outcome = await withTimeout(deps.command(executable, ['--version'], timeoutMs), timeoutMs, {
    kind: 'timeout' as const,
  });

  if (outcome.kind === 'timeout') {
    return finish({
      ok: false,
      message: `\`${executable} --version\` did not answer within ${timeoutMs} ms`,
      detail: { reason: 'timeout', executable, source },
      startedAt,
      clock,
    });
  }
  if (outcome.kind === 'not_found') {
    return finish({
      ok: false,
      message: configured
        ? 'No executable at that path'
        : 'No `claude` executable on PATH — set the CLI executable path',
      detail: { reason: 'not_found', executable, source },
      startedAt,
      clock,
    });
  }
  if (outcome.kind === 'error') {
    return finish({
      ok: false,
      message: `Could not run the CLI — ${outcome.reason}`,
      detail: { reason: 'spawn_failed', executable, source },
      startedAt,
      clock,
    });
  }
  if (outcome.code !== 0) {
    return finish({
      ok: false,
      message: `\`${executable} --version\` exited ${outcome.code}`,
      detail: {
        reason: 'nonzero_exit',
        executable,
        source,
        stderr: outcome.stderr.trim().slice(0, 300),
      },
      startedAt,
      clock,
    });
  }

  const version = outcome.stdout.trim().split('\n')[0]?.trim() ?? '';
  return finish({
    ok: true,
    message:
      version.length === 0
        ? `Claude Code CLI responded (${executable})`
        : `Claude Code CLI ${version}`,
    detail: { version, executable, source },
    startedAt,
    clock,
  });
}
