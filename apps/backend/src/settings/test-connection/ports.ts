import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import process from 'node:process';

/**
 * The outbound edges of Test Connection (TDS 04 §7.4), as narrow injectable ports.
 *
 * **Every call out of this process is bounded.** Test Connection reaches the network, the
 * filesystem and a child process on an operator's click; an unbounded call is how
 * `POST /sessions/{id}/start` once hung for 45 seconds behind a stalled probe. Each port
 * therefore:
 *
 *   - carries a wall-clock timeout enforced *here*, not only by the transport, so a stub or a
 *     driver that ignores an `AbortSignal` still cannot hang a request;
 *   - never throws — a dead network, a missing binary and a stalled network drive are all
 *     ordinary answers returned as data, because the operator is testing precisely because
 *     something might be broken;
 *   - never returns anything derived from a secret. `redactSecret` scrubs any message built
 *     from an error before it can reach a result, a log line or an audit row: the Telegram API
 *     puts the bot token **in the URL**, and transport errors quote URLs.
 */

/** Network probes. Long enough for a cold TLS handshake, short enough to be a click. */
export const NETWORK_TIMEOUT_MS = 5_000;
/** `stat` on a local path is instant; on a disconnected network share it is not. */
export const PATH_TIMEOUT_MS = 2_000;
/** A cold `claude --version` on Windows pays for process start plus an on-access scanner. */
export const COMMAND_TIMEOUT_MS = 10_000;

/** Response bodies here are small JSON documents; anything larger is not an answer. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** How much of a failure's own words are passed back to the operator. */
const MAX_DETAIL_LENGTH = 300;

// --------------------------------------------------------------------------------- http port

export interface HttpProbeRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export type HttpProbeOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export type HttpProbe = (request: HttpProbeRequest) => Promise<HttpProbeOutcome>;

/** The real transport: `fetch`, aborted at the deadline, with a bounded body read. */
export function createHttpProbe(): HttpProbe {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: 'GET',
        headers: { ...request.headers },
        signal: controller.signal,
        redirect: 'follow',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });

      return {
        kind: 'response',
        status: response.status,
        headers,
        body: await readBounded(response, MAX_RESPONSE_BYTES),
      };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'unreachable', reason: describeFailure(error) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Read at most `max` bytes of a response body and drop the rest.
 *
 * `response.text()` would buffer whatever the far end sends. The deadline bounds the *time*
 * either way, but a hostile or misconfigured endpoint should not be able to make a
 * connection test allocate a gigabyte before that deadline arrives.
 */
async function readBounded(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < max) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer.subarray(0, max));
}

// --------------------------------------------------------------------------------- path port

export type PathProbeOutcome =
  | {
      readonly kind: 'stat';
      readonly exists: boolean;
      readonly isDirectory: boolean;
      readonly readable: boolean;
      readonly writable: boolean;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly reason: string };

export type PathProbe = (path: string) => Promise<PathProbeOutcome>;

/**
 * The real filesystem probe: does the path exist, is it a directory, can this process read and
 * write it. Read-only — it never creates a file to prove writability, because a "test" that
 * leaves litter in an operator's vault is not a test.
 */
export function createPathProbe(): PathProbe {
  return async (path) =>
    withTimeout(
      (async (): Promise<PathProbeOutcome> => {
        try {
          const stats = await stat(path);
          return {
            kind: 'stat',
            exists: true,
            isDirectory: stats.isDirectory(),
            readable: await permitted(path, fsConstants.R_OK),
            writable: await permitted(path, fsConstants.W_OK),
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return {
              kind: 'stat',
              exists: false,
              isDirectory: false,
              readable: false,
              writable: false,
            };
          }
          return { kind: 'error', reason: describeFailure(error) };
        }
      })(),
      PATH_TIMEOUT_MS,
      { kind: 'timeout' },
    );
}

async function permitted(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------ command port

export type CommandProbeOutcome =
  | {
      readonly kind: 'exit';
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly reason: string };

export type CommandProbe = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandProbeOutcome>;

/**
 * `execFile`, never a shell (F8.1): arguments reach the binary as an argv array, so a CLI path
 * containing a space, an `&` or a quote is data rather than syntax. Cross-platform by
 * construction — no `.cmd` wrapper, no platform branch.
 */
export function createCommandProbe(): CommandProbe {
  return (file, args, timeoutMs) =>
    new Promise((settle) => {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          maxBuffer: MAX_RESPONSE_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1' },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            settle({ kind: 'exit', code: 0, stdout, stderr });
            return;
          }
          const failure = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string | null;
            code?: unknown;
          };
          if (failure.code === 'ENOENT') {
            settle({ kind: 'not_found' });
            return;
          }
          if (failure.killed === true || (failure.signal ?? null) !== null) {
            settle({ kind: 'timeout' });
            return;
          }
          if (typeof failure.code === 'number') {
            settle({ kind: 'exit', code: failure.code, stdout, stderr });
            return;
          }
          settle({ kind: 'error', reason: describeFailure(error) });
        },
      );
    });
}

// ------------------------------------------------------------------------------------ shared

/**
 * Resolve `work` or, at the deadline, `onTimeout` — whichever comes first.
 *
 * The timer is what makes the bound real for *any* transport, including one that ignores an
 * `AbortSignal` (every test double does). `unref` so a pending probe can never hold the
 * process open at shutdown.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(onTimeout);
    }, timeoutMs);
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        // Ports do not throw; this is the belt-and-braces arm for a double that does. The
        // caller gets the same answer it would get from a stall, which is the honest one:
        // the check did not complete.
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/** One line of a failure's own words, capped. Never a stack, never a secret (see below). */
export function describeFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error.message
      : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Remove a secret from anything about to be shown or logged.
 *
 * The implementation moved to `@mc/shared` when the Telegram Worker landed: the worker holds
 * the same bot token, sends it in the same URL, and must scrub the same strings — and F2.2
 * forbids it importing Backend modules. Re-exported here so every caller in this package keeps
 * its import, and so this file's contract ("never returns anything derived from a secret")
 * still names the function that enforces it.
 */
export { redactSecret } from '@mc/shared';
