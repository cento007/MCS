import type { TestConnectionResult } from '@mc/shared';
import {
  describeEmbeddingFailure,
  describeVectorStoreFailure,
  type EmbeddingFailure,
  type EmbeddingStamp,
  EmbeddingStampMismatchError,
  formatStamp,
  type MemoryCollectionInfo,
  ollamaBaseUrl,
  qdrantBaseUrl,
  type VectorStoreOutcome,
  verifyStamp,
} from '@mc/shared';
import {
  COMMAND_TIMEOUT_MS,
  type CommandProbe,
  type HttpProbe,
  MEMORY_TIMEOUT_MS,
  type MemoryPortFactory,
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
 *  5. **Where a client already exists, the check uses it.** Qdrant and Ollama are reached
 *     through the `@mc/shared/memory` adapters the rest of Phase 3 runs on, never through a
 *     second HTTP client written for this button. A diagnostic that talks to a service
 *     differently from the code it is diagnosing can pass while the product fails.
 */

export interface ProbeClock {
  now(): number;
}

const SYSTEM_CLOCK: ProbeClock = { now: () => Date.now() };

export interface ExecutorDeps {
  readonly http: HttpProbe;
  readonly path: PathProbe;
  readonly command: CommandProbe;
  /**
   * Builds the Qdrant and Ollama adapters from `@mc/shared/memory`.
   *
   * Required rather than defaulted, deliberately: a defaulted factory is one forgotten test
   * stub away from a suite that quietly succeeds against whatever happens to be listening on
   * `:6333` on the developer's machine, and then goes red on a machine that has nothing.
   */
  readonly memory: MemoryPortFactory;
  readonly clock?: ProbeClock;
  /**
   * Overridable bounds; the defaults are the `ports.ts` constants.
   *
   * They exist so a test can prove the *timeout path* in milliseconds instead of waiting out a
   * real ten-second CLI bound — a suite that takes ten seconds to assert one thing is a suite
   * people stop running.
   */
  readonly timeouts?: {
    readonly networkMs?: number;
    readonly commandMs?: number;
    readonly memoryMs?: number;
  };
}

function networkTimeout(deps: ExecutorDeps): number {
  return deps.timeouts?.networkMs ?? NETWORK_TIMEOUT_MS;
}

function commandTimeout(deps: ExecutorDeps): number {
  return deps.timeouts?.commandMs ?? COMMAND_TIMEOUT_MS;
}

function memoryTimeout(deps: ExecutorDeps): number {
  return deps.timeouts?.memoryMs ?? MEMORY_TIMEOUT_MS;
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

/**
 * What a check concluded, before it is timestamped. The unit `finish` turns into a result.
 *
 * Executors that make more than one round trip build this and let `boundedCheck` time it, so
 * that "how long did the whole thing take" is answered in one place rather than per branch.
 */
interface Verdict {
  readonly ok: boolean;
  readonly message: string;
  readonly detail: Record<string, unknown> | null;
}

/**
 * Run a multi-call check under **one** wall-clock budget, enforced here.
 *
 * The single-call executors above bound their one port and are done. Qdrant asks a collection
 * and then an embedder; Ollama asks a manifest and then embeds a probe string. Bounding each
 * round trip separately would let a check that "cannot hang" take N × the bound, and the
 * operator is waiting on the total, not on the worst leg. The timer also makes the bound real
 * against a port that ignores the deadline it was handed, which is every test double and, once,
 * a driver.
 */
async function boundedCheck(
  deps: ExecutorDeps,
  timeoutMs: number,
  onTimeout: Verdict,
  run: () => Promise<Verdict>,
): Promise<TestConnectionResult> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const startedAt = clock.now();
  const verdict = await withTimeout(run(), timeoutMs, onTimeout);
  return finish({ ...verdict, startedAt, clock });
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

// ------------------------------------------------------------------------------------ ollama

export interface OllamaTestInput {
  readonly host: string;
  readonly port: number;
  /** `integrations.qdrant.embeddingModel`. Never empty — the service refuses before reaching here. */
  readonly model: string;
}

/**
 * Ollama: reachable, **and the configured model is genuinely an embedder**.
 *
 * Reachability alone would be a near-worthless check. The failure an operator actually hits is
 * typing a model name that Ollama has, and that cannot embed — and that failure is expensive
 * and misdiagnosed at every other layer. Measured on this machine against Ollama 0.32.9:
 *
 *     POST /api/embed {"model":"deepseek-r1:8b"}  ->  501, after 28.6 s
 *     POST /api/show  {"model":"deepseek-r1:8b"}  ->  capabilities ["tools","thinking",…], 16 ms
 *
 * Ollama loads eight billion parameters before discovering it has no embedding head, and then
 * blames a server flag (`Start it with --embeddings`) that has nothing to do with the operator's
 * actual mistake. `describeModel` asks the capability question first — which is why this check
 * can distinguish *not running* from *not pulled* from *that is a chat model*, in one click and
 * without a 29-second stall.
 *
 * On success it reports the **measured** dimension, not the declared one: that number is what
 * the Qdrant collection has to hold, and it is the value a stamp mismatch is measured against.
 */
export async function testOllama(
  deps: ExecutorDeps,
  input: OllamaTestInput,
): Promise<TestConnectionResult> {
  const timeoutMs = memoryTimeout(deps);
  const endpoint = ollamaBaseUrl(input.host, input.port);
  const model = input.model;

  return boundedCheck(
    deps,
    timeoutMs,
    {
      ok: false,
      message: `Timed out after ${timeoutMs} ms asking Ollama at ${endpoint} about "${model}"`,
      detail: { reason: 'timeout', timeoutMs, endpoint, model },
    },
    async () => {
      const embedder = deps.memory.embedder({
        host: input.host,
        port: input.port,
        model,
        timeoutMs,
      });
      const described = await embedder.describeModel({ timeoutMs });

      if (described.kind === 'ok') {
        return {
          ok: true,
          message:
            `"${model}" is an embedding model — ${String(described.stamp.dimension)} dimensions` +
            `${described.runtimeVersion === null ? '' : ` (Ollama ${described.runtimeVersion})`}`,
          detail: {
            endpoint,
            model: described.stamp.model,
            // The number that has to match the collection. Measured from a real vector.
            dimension: described.stamp.dimension,
            declaredDimension: described.declaredDimension,
            capabilities: [...described.capabilities],
            runtimeVersion: described.runtimeVersion,
          },
        };
      }

      return {
        ok: false,
        message: ollamaFailureMessage(described, endpoint, timeoutMs),
        detail: {
          reason: described.kind,
          endpoint,
          model,
          // Reported identically whether the adapter's per-call bound fired or this executor's
          // whole-check one did — the operator is being told how long it waited, not which
          // timer owned the stopwatch.
          ...(described.kind === 'timeout' ? { timeoutMs: described.timeoutMs } : {}),
          ...(described.kind === 'not_an_embedding_model'
            ? { capabilities: [...described.capabilities] }
            : {}),
          ...(described.kind === 'failed' ? { status: described.status } : {}),
        },
      };
    },
  );
}

/**
 * One line naming which of the four things is wrong, and what to do about it.
 *
 * `model_missing` and `not_an_embedding_model` already carry the operator's next command
 * (`ollama pull …`) and the reason (the capability list Ollama reported) from the adapter, and
 * they are passed through verbatim rather than paraphrased — two wordings of the same fact is
 * how one of them ends up wrong.
 */
function ollamaFailureMessage(
  failure: EmbeddingFailure,
  endpoint: string,
  timeoutMs: number,
): string {
  switch (failure.kind) {
    case 'unreachable':
      return `${failure.reason}. Is Ollama running? \`ollama serve\` starts it.`;
    case 'timeout':
      return `Timed out after ${String(failure.timeoutMs)} ms contacting Ollama at ${endpoint}`;
    case 'not_configured':
      return `${failure.reason} (bounded at ${String(timeoutMs)} ms)`;
    default:
      return describeEmbeddingFailure(failure);
  }
}

// ------------------------------------------------------------------------------------ qdrant

export interface QdrantTestInput {
  readonly host: string;
  readonly port: number;
  /** `integrations.qdrant.apiKey`, or `null` when the server runs without one. */
  readonly apiKey: string | null;
  readonly model: string;
  readonly ollamaHost: string;
  readonly ollamaPort: number;
}

/**
 * Qdrant: reachable, **and its collection still means what settings say it means**.
 *
 * Reachability is the easy half. The half worth having is the embedding stamp: vectors are only
 * comparable within one model, so a collection built under `nomic-embed-text` and queried under
 * anything else does not error — it returns a ranked list of confident nonsense, and no other
 * surface in the product would tell anyone. That makes "reachable, stamp disagrees" a **failed**
 * test, not a passing one with a footnote.
 *
 * Three deliberate choices:
 *
 *  1. **Nothing is written.** `ensureCollection` would verify the same thing, but it creates a
 *     missing collection and PATCHes a stamp onto an empty one. `verifyStamp` is pure, so the
 *     identical verdict is reached read-only — a diagnostic that changes the system it is
 *     diagnosing is not one an operator can press twice with confidence (see `testObsidian`,
 *     which refuses to create a file to prove writability for the same reason).
 *  2. **The collection is asked first.** An unreachable Qdrant or an absent collection costs one
 *     round trip and never wakes an embedding model.
 *  3. **The model half is compared even when Ollama is down.** The dimension needs a live
 *     embedder; the model *name* does not, and a name disagreement is the mismatch an operator
 *     actually causes, by editing one settings field.
 */
export async function testQdrant(
  deps: ExecutorDeps,
  input: QdrantTestInput,
): Promise<TestConnectionResult> {
  const timeoutMs = memoryTimeout(deps);
  const endpoint = qdrantBaseUrl(input.host, input.port);
  const redact = (text: string): string => redactSecret(text, input.apiKey);

  const store = deps.memory.store({
    host: input.host,
    port: input.port,
    apiKey: input.apiKey,
    timeoutMs,
  });
  const collection = store.collection;

  const result = await boundedCheck(
    deps,
    timeoutMs,
    {
      ok: false,
      message: `Timed out after ${timeoutMs} ms contacting Qdrant at ${endpoint}`,
      detail: { reason: 'timeout', timeoutMs, endpoint, collection },
    },
    async () => {
      const described = await store.describeCollection({ timeoutMs });
      if (described.kind !== 'ok') {
        return {
          ok: false,
          message: qdrantFailureMessage(described, endpoint),
          detail: {
            reason: described.kind,
            endpoint,
            collection,
            ...(described.kind === 'timeout' ? { timeoutMs: described.timeoutMs } : {}),
            ...(described.kind === 'failed' ? { status: described.status } : {}),
          },
        };
      }

      const info = described.value;
      const base = {
        endpoint,
        collection,
        exists: info.exists,
        pointCount: info.pointCount,
        vectorSize: info.vectorSize,
        schemaVersion: info.schemaVersion,
        collectionModel: info.stamp?.model ?? null,
        collectionDimension: info.stamp?.dimension ?? null,
        configuredModel: input.model,
      };

      // A first-run instance that has never indexed is working exactly as designed. Failing it
      // would train operators to ignore a red cross on the one panel that must be believed.
      if (!info.exists) {
        return {
          ok: true,
          message:
            `Qdrant is reachable; the "${collection}" collection does not exist yet, so nothing ` +
            'is indexed. It is created and stamped on the first index run.',
          detail: { ...base, indexed: false },
        };
      }

      const embedder = deps.memory.embedder({
        host: input.ollamaHost,
        port: input.ollamaPort,
        model: input.model,
        timeoutMs,
      });
      const model = await embedder.describeModel({ timeoutMs });

      if (model.kind !== 'ok') {
        // The dimension is unknowable without the embedder; the model name is not, and it is
        // the half an operator changes. Checking it here means a mis-set model is still caught
        // when Ollama happens to be down — the worst moment to lose the one guard that matters.
        if (info.stamp !== null && info.stamp.model !== input.model) {
          return {
            ok: false,
            message:
              `Embedding model mismatch on the Qdrant collection "${collection}": it was ` +
              `stamped ${formatStamp(info.stamp)} and settings now name "${input.model}". ` +
              'Either restore the previous setting or delete the collection and let Mission ' +
              'Control rebuild it — vectors from two models are not comparable, so searching ' +
              'across them returns confident nonsense rather than an error.',
            detail: { ...base, reason: 'stamp_mismatch', mismatch: 'model' },
          };
        }
        return {
          ok: false,
          message:
            `Qdrant is reachable and "${collection}" holds ${points(info.pointCount)}, but its ` +
            'embedding stamp could not be verified because the embedding model is unavailable — ' +
            describeEmbeddingFailure(model),
          detail: { ...base, reason: 'stamp_unverified', embedderReason: model.kind },
        };
      }

      try {
        const verdict = verifyCollectionStamp(collection, model.stamp, info);
        return {
          ok: true,
          message:
            verdict.kind === 'adoptable'
              ? `Qdrant is reachable; "${collection}" exists, is empty and carries no stamp — ` +
                `the first index run stamps it ${formatStamp(model.stamp)}.`
              : `Qdrant is reachable; "${collection}" holds ${points(info.pointCount)} stamped ` +
                `${formatStamp(model.stamp)}, which matches settings.`,
          detail: {
            ...base,
            expectedModel: model.stamp.model,
            expectedDimension: model.stamp.dimension,
            stampVerified: verdict.kind === 'match',
            indexed: info.pointCount > 0,
          },
        };
      } catch (error) {
        if (!(error instanceof EmbeddingStampMismatchError)) throw error;
        // The one place this becomes data instead of stopping the caller — and it is a red
        // cross, never a warning. `error.message` names both values and both ways out.
        return {
          ok: false,
          message: error.message,
          detail: {
            ...base,
            reason: 'stamp_mismatch',
            mismatch: error.detail.kind,
            expectedModel: error.detail.expected.model,
            expectedDimension: error.detail.expected.dimension,
            foundModel: error.detail.found?.model ?? null,
            foundDimension: error.detail.found?.dimension ?? null,
            foundSchemaVersion: error.detail.foundSchemaVersion,
          },
        };
      }
    },
  );

  // Last line of defence on the API key. The adapter redacts everything it builds from a
  // transport error already, which is exactly why this is here: one call between a credential
  // and an HTTP response, free when unnecessary and irreplaceable the one time it is not.
  return {
    ...result,
    message: redact(result.message),
    detail: redactDetail(result.detail, input.apiKey),
  };
}

/**
 * The same two comparisons `ensureCollection` makes, in the same order, without the writes.
 *
 * The **width Qdrant enforces itself** is checked first and unconditionally: it is the half of
 * the stamp that survives a Qdrant too old to store collection metadata and a collection made
 * by hand, so checking it first means a wrongly-sized collection is refused with this layer's
 * actionable message rather than with Qdrant's terse `expected dim: 768, got 4` on some later
 * upsert. Only then the metadata stamp, which is the only evidence of *which model* wrote the
 * points — an equal width proves nothing about that.
 */
function verifyCollectionStamp(
  collection: string,
  expected: EmbeddingStamp,
  info: MemoryCollectionInfo,
): { readonly kind: 'match' | 'adoptable' } {
  const hasPoints = info.pointCount > 0;

  if (info.vectorSize !== null && info.vectorSize !== expected.dimension) {
    // Throws. The model falls back to the configured name so the message blames the dimension,
    // which is the only thing actually known to disagree.
    verifyStamp({
      collection,
      expected,
      found: { model: info.stamp?.model ?? expected.model, dimension: info.vectorSize },
      foundSchemaVersion: info.schemaVersion,
      hasPoints,
    });
  }

  return verifyStamp({
    collection,
    expected,
    found: info.stamp,
    foundSchemaVersion: info.schemaVersion,
    hasPoints,
  });
}

function qdrantFailureMessage(
  failure: Exclude<VectorStoreOutcome<never>, { kind: 'ok' }>,
  endpoint: string,
): string {
  switch (failure.kind) {
    case 'unreachable':
      return `${failure.reason}. Is the Qdrant service running?`;
    case 'timeout':
      return `Timed out after ${String(failure.timeoutMs)} ms contacting Qdrant at ${endpoint}`;
    default:
      return describeVectorStoreFailure(failure);
  }
}

function points(count: number): string {
  return `${String(count)} point${count === 1 ? '' : 's'}`;
}

/**
 * Scrub a secret out of every string a `detail` carries, one level deep and inside string
 * arrays — which is every shape these executors build.
 *
 * Nothing here is *known* to contain a credential; the point is that it stays true when
 * someone adds a field later without re-reading this file.
 */
function redactDetail(
  detail: Record<string, unknown> | null,
  secret: string | null,
): Record<string, unknown> | null {
  if (detail === null || secret === null) return detail;

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    scrubbed[key] =
      typeof value === 'string'
        ? redactSecret(value, secret)
        : Array.isArray(value)
          ? value.map((entry) => (typeof entry === 'string' ? redactSecret(entry, secret) : entry))
          : value;
  }
  return scrubbed;
}
