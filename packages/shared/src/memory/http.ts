/**
 * The one outbound network edge of the memory layer, as a narrow injectable port.
 *
 * Both adapters — Ollama (`ollama.ts`) and Qdrant (`qdrant.ts`) — speak JSON over HTTP to a
 * loopback service, so they share one transport rather than growing two near-identical copies
 * of the same `fetch` wrapper. It exists as a port and not as a bare `fetch` for two reasons,
 * and the second is the one that keeps costing this project:
 *
 *  1. **Every call is bounded.** A wall-clock deadline enforced *here*, not only by the
 *     transport, plus a capped body read and no retries. An unbounded outbound call is what
 *     made `POST /sessions/{id}/start` hang for 45 seconds. It is not a hypothetical here
 *     either: a chat model handed to Ollama's embedding endpoint spends ~29 seconds loading
 *     several gigabytes of weights before answering `501`, and an index run that does that
 *     once per batch would look exactly like a hang.
 *  2. **Tests must not be able to reach the network.** The port is constructed at the seam and
 *     nowhere else, and `createDenyingMemoryHttp` is what a suite installs by default: a unit
 *     tier that quietly reaches a locally-installed Qdrant is a tier that goes red on a machine
 *     that has none, which is precisely the property `pnpm test` must keep.
 *
 * The port never throws. A dead socket, a DNS failure and a stalled TLS handshake are ordinary
 * answers returned as data; the adapters above turn them into health rows an operator can act
 * on, never into a 500.
 */

/** How much of a transport failure's own words survive into an operator-facing message. */
const MAX_REASON_LENGTH = 300;

export interface MemoryHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * May include Qdrant's `api-key`. **Nothing built from this object may be logged or returned**
   * — see `redactSecret` at every call site that formats a failure.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Serialized by the caller so the port has no opinion about the body's shape. */
  readonly body?: string | undefined;
  readonly timeoutMs: number;
  /** Ceiling on the response body read. Defaults to `DEFAULT_MAX_RESPONSE_BYTES`. */
  readonly maxResponseBytes?: number | undefined;
}

export type MemoryHttpOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export type MemoryHttpPort = (request: MemoryHttpRequest) => Promise<MemoryHttpOutcome>;

/**
 * An embedding batch of 128 chunks at 768 float32 dimensions is roughly 1.5 MB of JSON;
 * a Qdrant scroll of the same size is comparable. 16 MiB is far above anything these two
 * endpoints return for the requests this layer makes and far below "allocate until OOM".
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The real transport: `fetch`, aborted at the deadline, with a bounded body read. */
export function createMemoryHttpPort(): MemoryHttpPort {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
        // Neither Ollama nor Qdrant redirects; following one would mean a misconfigured host
        // could send an API key to a third party.
        redirect: 'manual',
      });

      return {
        kind: 'response',
        status: response.status,
        body: await readBounded(response, request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
      };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'unreachable', reason: describeTransportFailure(error) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * A port that refuses to do anything and says so.
 *
 * Installed by any suite that has not deliberately supplied its own double, so an accidental
 * outbound call fails loudly and locally instead of succeeding quietly against whatever happens
 * to be listening on 6333 on the developer's machine.
 */
export function createDenyingMemoryHttp(label = 'test'): MemoryHttpPort {
  return (request) => {
    throw new Error(
      `Outbound memory request blocked in ${label}: ${request.method} ${request.url}. ` +
        'Inject a MemoryHttpPort double instead of reaching the network.',
    );
  };
}

/**
 * Resolve `work` or, at the deadline, `onTimeout` — whichever comes first.
 *
 * The timer is what makes the bound real for *any* transport, including a double that ignores
 * the `timeoutMs` it was handed (every test double does). `unref` so a pending probe can never
 * hold the process open at shutdown.
 */
export function withMemoryTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: T,
): Promise<T> {
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
        // caller gets the same answer a stall would give, which is the honest one: the call
        // did not complete.
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

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

/** One line of a transport failure's own words, capped. Never a stack. */
export function describeTransportFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error.message
      : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/** Parse a JSON object body, or `null` when it is not one. Never throws. */
export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
