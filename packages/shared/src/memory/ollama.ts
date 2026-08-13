/**
 * The Ollama `EmbeddingPort` adapter.
 *
 * Everything below was verified against a real **Ollama 0.32.9** on this machine rather than
 * assumed from documentation, because three of its behaviours are surprising enough that
 * guessing them wrong would have shipped a silent bug.
 *
 * ## 1. A chat model does not fail fast — it fails *slowly*, after loading itself
 *
 *     POST /api/embed  {"model":"deepseek-r1:8b","input":["hello"]}
 *     -> 501 {"error":"This server does not support embeddings. Start it with `--embeddings`"}
 *        after 28.6 seconds
 *
 * Ollama loads the full 8B model into memory *before* discovering it has no embedding head.
 * So an operator who types a chat model name into `integrations.qdrant.embeddingModel` does not
 * get a quick error: they get a 29-second stall, per batch, and an error message that talks
 * about a server flag that has nothing to do with their actual problem. On a 20B model it is
 * worse.
 *
 * The adapter therefore **checks the model by name before embedding anything**, using
 * `POST /api/show`, which returns a `capabilities` array and takes ~5 ms because it reads
 * manifest metadata and does not load weights:
 *
 *     nomic-embed-text -> capabilities: ["embedding"]
 *     deepseek-r1:8b   -> capabilities: ["tools","thinking","completion"]
 *
 * The check is cached per port instance, so the cost is paid once and a long index run pays
 * nothing. A model *without* `embedding` is rejected as `not_an_embedding_model` with the name
 * and the capabilities in the message — actionable, and one round trip instead of a stall.
 *
 * ## 2. `model_info.<family>.embedding_length` is not a capability signal
 *
 * `deepseek-r1:8b` reports `qwen3.embedding_length: 4096` — that is its hidden size, not proof
 * it can embed. Only `capabilities` distinguishes the two, which is why the declared dimension
 * is reported for information and the **real dimension is measured** by embedding one short
 * probe string. Measured beats declared: it is what the collection will actually have to hold.
 *
 * ## 3. The two embedding endpoints return differently-scaled vectors
 *
 *     POST /api/embed       {"model":…, "input": string | string[]} -> {"embeddings": number[][]}
 *     POST /api/embeddings  {"model":…, "prompt": string}           -> {"embedding":  number[]}
 *
 * `/api/embed` is the batch form and returns **L2-normalized** vectors (measured norm 1.000000).
 * The legacy `/api/embeddings` takes one string only — an array is a `400` — and returns **raw**
 * vectors (measured norm ≈ 4.9 for the same text and model). Cosine ranking is scale-invariant
 * so retrieval would survive the difference, but "the same text embeds to the same numbers"
 * should not depend on which endpoint answered, so this adapter normalizes on the way out and
 * the two paths become interchangeable.
 *
 * Version tolerance: `/api/embed` is preferred and the legacy endpoint is used only if this
 * Ollama does not know the route. The two 404s are distinguishable — an unknown route answers
 * the plain text `404 page not found`, an unknown model answers
 * `{"error":"model \"x\" not found, try pulling it first"}` — so the fallback cannot be
 * triggered by a typo'd model name, which would otherwise turn one clear error into N slow ones.
 */

import { redactSecret } from '../crypto/redact.js';
import {
  type EmbeddingFailure,
  type EmbeddingModelOutcome,
  type EmbeddingOutcome,
  type EmbeddingPort,
  type EmbeddingVector,
  type EmbedOptions,
  normalizeVector,
} from './embedding-port.js';
import {
  createMemoryHttpPort,
  type MemoryHttpOutcome,
  type MemoryHttpPort,
  parseJsonObject,
  withMemoryTimeout,
} from './http.js';
import type { EmbeddingStamp } from './stamp.js';

/**
 * A batch of a few hundred chunks against a warm local model finishes in well under a second
 * (measured: 756 ms for 128 chunks); a **cold** model must first be read off disk, which for a
 * 137M-parameter embedder is a few seconds and for a larger one more. 60 s is generous for the
 * cold case and still bounded — the property that matters is that it cannot hang forever.
 */
export const OLLAMA_EMBED_TIMEOUT_MS = 60_000;

/**
 * `/api/show` and `/api/version` read manifests and never load weights (measured: 5 ms for
 * `nomic-embed-text`, 190 ms for the 20B `gpt-oss`). 5 s is far above either and short enough
 * that the Services panel cannot be held open by it.
 */
export const OLLAMA_PROBE_TIMEOUT_MS = 5_000;

/**
 * Chunks per HTTP request. 128 was the measured knee: 5.9 ms/chunk at both 64 and 128, versus
 * 31.5 ms/chunk unbatched. Larger batches keep the same per-chunk cost while making each
 * request's failure more expensive to retry and its JSON body larger, so there is nothing to
 * buy above this.
 */
export const OLLAMA_MAX_BATCH = 128;

/** The capability `/api/show` reports for a model that can actually embed. */
const EMBEDDING_CAPABILITY = 'embedding';

export interface OllamaEmbedderOptions {
  readonly host: string;
  readonly port: number;
  readonly model: string;
  /** Injected in tests; defaults to the real bounded `fetch` transport. */
  readonly http?: MemoryHttpPort | undefined;
  readonly embedTimeoutMs?: number | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly maxBatch?: number | undefined;
}

export function createOllamaEmbedder(options: OllamaEmbedderOptions): EmbeddingPort {
  const http = options.http ?? createMemoryHttpPort();
  const baseUrl = ollamaBaseUrl(options.host, options.port);
  const model = options.model;
  const embedTimeoutMs = options.embedTimeoutMs ?? OLLAMA_EMBED_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS;
  const maxBatch = Math.max(1, options.maxBatch ?? OLLAMA_MAX_BATCH);

  /**
   * Remembered across calls so a 4 000-chunk index pays for the capability check once. Only a
   * *successful* verdict is cached: a failure is a machine state that an operator may fix
   * (start Ollama, pull the model) while this process keeps running, and caching it would make
   * the fix invisible until a restart.
   */
  let verifiedStamp: EmbeddingStamp | null = null;
  /** `null` = not yet determined; set once the batch endpoint is known to exist or not. */
  let batchEndpointSupported: boolean | null = null;

  async function request(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<MemoryHttpOutcome> {
    return withMemoryTimeout(
      http({
        url: `${baseUrl}${path}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
      }),
      timeoutMs,
      { kind: 'timeout' },
    );
  }

  /** `/api/show` — capabilities and the declared dimension, without loading the model. */
  async function show(timeoutMs: number): Promise<
    | {
        kind: 'ok';
        capabilities: readonly string[];
        declaredDimension: number | null;
        contextTokens: number | null;
      }
    | EmbeddingFailure
  > {
    const outcome = await request('/api/show', { model }, timeoutMs);
    const transport = transportFailure(outcome, timeoutMs, baseUrl);
    if (transport !== null) return transport;
    if (outcome.kind !== 'response') return { kind: 'failed', status: null, reason: 'No response' };

    if (outcome.status === 404) {
      return {
        kind: 'model_missing',
        model,
        reason: `Ollama has no model named "${model}". Pull it first: \`ollama pull ${model}\`.`,
      };
    }
    if (outcome.status !== 200) {
      return httpFailure(outcome.status, outcome.body, 'Ollama');
    }

    const parsed = parseJsonObject(outcome.body);
    const capabilities = Array.isArray(parsed?.['capabilities'])
      ? (parsed['capabilities'] as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];

    return {
      kind: 'ok',
      capabilities,
      declaredDimension: modelInfoNumber(parsed, '.embedding_length'),
      contextTokens: modelInfoNumber(parsed, '.context_length'),
    };
  }

  /**
   * The capability gate. Runs before any embedding call and caches only success.
   *
   * Returning the measured stamp rather than a boolean is what keeps "is it an embedder" and
   * "how wide is it" a single round of work: both answers come from the same two calls, and a
   * caller that has one always has the other.
   */
  async function verify(
    timeoutMs: number,
  ): Promise<{ kind: 'ok'; info: Verified } | EmbeddingFailure> {
    const shown = await show(timeoutMs);
    if (shown.kind !== 'ok') return shown;

    // An Ollama old enough not to report capabilities returns `[]`. Refusing on an empty list
    // would make this adapter unusable there for no safety gain — the embed call itself still
    // rejects a chat model, just slowly — so an empty list is "unknown, proceed", and only a
    // populated list that omits `embedding` is a refusal.
    if (shown.capabilities.length > 0 && !shown.capabilities.includes(EMBEDDING_CAPABILITY)) {
      return {
        kind: 'not_an_embedding_model',
        model,
        capabilities: shown.capabilities,
        reason:
          `"${model}" is not an embedding model — Ollama reports its capabilities as ` +
          `[${shown.capabilities.join(', ')}]. Vectors cannot be produced from it. Set ` +
          '`integrations.qdrant.embeddingModel` to an embedding model such as ' +
          '`nomic-embed-text` (`ollama pull nomic-embed-text`).',
      };
    }

    // Measure the real dimension with one short probe. This is the only call in the adapter
    // that loads the model, and it is why the capability check above must come first.
    const probe = await embedOnce(['dimension probe'], timeoutMs);
    if (probe.kind !== 'ok') return probe;

    const first = probe.vectors[0];
    if (first === undefined || first.length === 0) {
      return {
        kind: 'failed',
        status: null,
        reason: `Ollama returned no vector for "${model}", so its dimension cannot be determined.`,
      };
    }

    return {
      kind: 'ok',
      info: {
        stamp: { model, dimension: first.length },
        capabilities: shown.capabilities,
        declaredDimension: shown.declaredDimension,
        contextTokens: shown.contextTokens,
      },
    };
  }

  /** One HTTP round of embedding, batch endpoint preferred, legacy endpoint as fallback. */
  async function embedOnce(
    texts: readonly string[],
    timeoutMs: number,
  ): Promise<{ kind: 'ok'; vectors: readonly EmbeddingVector[] } | EmbeddingFailure> {
    if (batchEndpointSupported !== false) {
      const outcome = await request('/api/embed', { model, input: [...texts] }, timeoutMs);
      const transport = transportFailure(outcome, timeoutMs, baseUrl);
      if (transport !== null) return transport;
      if (outcome.kind !== 'response') {
        return { kind: 'failed', status: null, reason: 'No response' };
      }

      if (outcome.status === 200) {
        batchEndpointSupported = true;
        return readBatchBody(outcome.body, texts.length, model);
      }

      // `404 page not found` (plain text, no `error` field) means this Ollama does not know the
      // route; a JSON `{"error":"model … not found"}` means the route exists and the model does
      // not. Only the former justifies falling back.
      if (outcome.status === 404 && parseJsonObject(outcome.body) === null) {
        batchEndpointSupported = false;
      } else {
        return embedHttpFailure(outcome.status, outcome.body, model);
      }
    }

    return embedLegacy(texts, timeoutMs);
  }

  /** Legacy `/api/embeddings`: one string per request, so N requests, serially. */
  async function embedLegacy(
    texts: readonly string[],
    timeoutMs: number,
  ): Promise<{ kind: 'ok'; vectors: readonly EmbeddingVector[] } | EmbeddingFailure> {
    const vectors: EmbeddingVector[] = [];

    // Serial on purpose. Ollama serializes model access anyway, so concurrency here buys
    // nothing and turns one bounded call into N simultaneous ones against a machine that is,
    // by definition, running an old and probably smaller build.
    for (const text of texts) {
      const outcome = await request('/api/embeddings', { model, prompt: text }, timeoutMs);
      const transport = transportFailure(outcome, timeoutMs, baseUrl);
      if (transport !== null) return transport;
      if (outcome.kind !== 'response') {
        return { kind: 'failed', status: null, reason: 'No response' };
      }
      if (outcome.status !== 200) return embedHttpFailure(outcome.status, outcome.body, model);

      const parsed = parseJsonObject(outcome.body);
      const embedding = parsed?.['embedding'];
      if (!isNumberArray(embedding)) {
        return {
          kind: 'failed',
          status: 200,
          reason: 'Ollama answered 200 with no `embedding` array — is this an Ollama server?',
        };
      }
      vectors.push(normalizeVector(embedding));
    }

    return { kind: 'ok', vectors };
  }

  return {
    model,

    async embed(texts, embedOptions?: EmbedOptions): Promise<EmbeddingOutcome> {
      // No network call for an empty batch: "nothing to index" must not wake a model.
      if (texts.length === 0) {
        return {
          kind: 'ok',
          vectors: [],
          stamp: verifiedStamp ?? { model, dimension: 0 },
        };
      }

      const timeoutMs = embedOptions?.timeoutMs ?? embedTimeoutMs;

      if (verifiedStamp === null) {
        const verified = await verify(embedOptions?.timeoutMs ?? probeTimeoutMs);
        if (verified.kind !== 'ok') return verified;
        verifiedStamp = verified.info.stamp;
      }
      const stamp = verifiedStamp;

      const vectors: EmbeddingVector[] = [];
      for (let start = 0; start < texts.length; start += maxBatch) {
        const slice = texts.slice(start, start + maxBatch);
        const outcome = await embedOnce(slice, timeoutMs);
        if (outcome.kind !== 'ok') return outcome;

        // A model that changes width mid-run is impossible in practice and catastrophic if it
        // happened, so it is checked rather than assumed: the alternative is a collection with
        // two vector widths in it and no record of which points are which.
        for (const vector of outcome.vectors) {
          if (vector.length !== stamp.dimension) {
            return {
              kind: 'failed',
              status: null,
              reason:
                `Ollama returned a ${String(vector.length)}-dimensional vector for "${model}" ` +
                `after reporting ${String(stamp.dimension)}. Refusing to mix widths in one index.`,
            };
          }
          vectors.push(vector);
        }
      }

      if (vectors.length !== texts.length) {
        return {
          kind: 'failed',
          status: null,
          reason:
            `Asked Ollama for ${String(texts.length)} embeddings and got ` +
            `${String(vectors.length)}. Refusing to guess which chunk each vector belongs to.`,
        };
      }

      return { kind: 'ok', vectors, stamp };
    },

    async describeModel(embedOptions?: EmbedOptions): Promise<EmbeddingModelOutcome> {
      const timeoutMs = embedOptions?.timeoutMs ?? probeTimeoutMs;
      const runtimeVersion = await readVersion(http, baseUrl, timeoutMs);

      const verified = await verify(timeoutMs);
      if (verified.kind !== 'ok') return verified;
      verifiedStamp = verified.info.stamp;

      return {
        kind: 'ok',
        stamp: verified.info.stamp,
        capabilities: verified.info.capabilities,
        runtimeVersion,
        declaredDimension: verified.info.declaredDimension,
        contextTokens: verified.info.contextTokens,
      };
    },
  };
}

interface Verified {
  readonly stamp: EmbeddingStamp;
  readonly capabilities: readonly string[];
  readonly declaredDimension: number | null;
  readonly contextTokens: number | null;
}

/** `http://host:port`, with an IPv6 literal bracketed so the URL stays parseable. */
export function ollamaBaseUrl(host: string, port: number): string {
  const trimmed = host.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  const authority = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
  return `http://${authority}:${String(port)}`;
}

/** `GET /api/version` — best effort; a missing version is not a failure, just less `meta`. */
async function readVersion(
  http: MemoryHttpPort,
  baseUrl: string,
  timeoutMs: number,
): Promise<string | null> {
  const outcome = await withMemoryTimeout(
    http({ url: `${baseUrl}/api/version`, method: 'GET', timeoutMs }),
    timeoutMs,
    { kind: 'timeout' as const },
  );
  if (outcome.kind !== 'response' || outcome.status !== 200) return null;
  const parsed = parseJsonObject(outcome.body);
  return typeof parsed?.['version'] === 'string' ? parsed['version'] : null;
}

/**
 * `model_info` keys are family-prefixed — `nomic-bert.embedding_length`,
 * `nomic-bert.context_length` — and the family is the model's, not something we can predict.
 * So the lookup is by suffix.
 *
 * `.embedding_length` is reported for information only (see the header: it is the hidden size,
 * not proof of an embedding head). `.context_length` is load-bearing — `chunk.ts` derives the
 * byte ceiling from it.
 */
function modelInfoNumber(parsed: Record<string, unknown> | null, suffix: string): number | null {
  const info = parsed?.['model_info'];
  if (typeof info !== 'object' || info === null) return null;

  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key.endsWith(suffix) && typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBatchBody(
  body: string,
  expected: number,
  model: string,
): { kind: 'ok'; vectors: readonly EmbeddingVector[] } | EmbeddingFailure {
  const parsed = parseJsonObject(body);
  const embeddings = parsed?.['embeddings'];

  if (!Array.isArray(embeddings)) {
    return {
      kind: 'failed',
      status: 200,
      reason: 'Ollama answered 200 with no `embeddings` array — is this an Ollama server?',
    };
  }
  if (embeddings.length !== expected) {
    return {
      kind: 'failed',
      status: 200,
      reason:
        `Asked "${model}" for ${String(expected)} embeddings and got ` +
        `${String(embeddings.length)}. Refusing to guess which chunk each vector belongs to.`,
    };
  }

  const vectors: EmbeddingVector[] = [];
  for (const entry of embeddings) {
    if (!isNumberArray(entry)) {
      return { kind: 'failed', status: 200, reason: 'Ollama returned a non-numeric embedding.' };
    }
    vectors.push(normalizeVector(entry));
  }
  return { kind: 'ok', vectors };
}

/** Ollama's own words for a failed embed, mapped to the arm the operator can act on. */
function embedHttpFailure(status: number, body: string, model: string): EmbeddingFailure {
  const message = errorMessageOf(body);

  if (status === 404) {
    return {
      kind: 'model_missing',
      model,
      reason: `Ollama has no model named "${model}". Pull it first: \`ollama pull ${model}\`.`,
    };
  }

  // Measured: a chat model answers 501 "This server does not support embeddings. Start it with
  // `--embeddings`" — after loading itself. The capability gate normally catches this first;
  // this arm is what an Ollama too old to report capabilities falls through to, and it
  // deliberately replaces Ollama's misleading advice about a server flag with the real cause.
  if (status === 501) {
    return {
      kind: 'not_an_embedding_model',
      model,
      capabilities: [],
      reason:
        `"${model}" cannot produce embeddings — Ollama answered 501 (${message ?? 'no detail'}). ` +
        'Set `integrations.qdrant.embeddingModel` to an embedding model such as ' +
        '`nomic-embed-text` (`ollama pull nomic-embed-text`).',
    };
  }

  return httpFailure(status, body, 'Ollama');
}

function httpFailure(status: number, body: string, service: string): EmbeddingFailure {
  const message = errorMessageOf(body);
  return {
    kind: 'failed',
    status,
    reason: `${service} answered ${String(status)}${message === null ? '' : ` — ${message}`}`,
  };
}

/** Both services report failures as `{"error": "..."}`; Qdrant also uses `{"status":{"error"}}`. */
function errorMessageOf(body: string): string | null {
  const parsed = parseJsonObject(body);
  if (typeof parsed?.['error'] === 'string') return parsed['error'].slice(0, 300);

  const status = parsed?.['status'];
  if (typeof status === 'object' && status !== null) {
    const nested = (status as Record<string, unknown>)['error'];
    if (typeof nested === 'string') return nested.slice(0, 300);
  }
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 300);
}

/**
 * Transport-level outcomes, shared by every call above.
 *
 * `secret` is threaded through so that a Qdrant API key appearing inside a transport error's
 * text — a URL with credentials, a proxy error quoting one — is scrubbed before it can reach a
 * health row or a log line. Ollama has no credential, so this adapter passes none; the Qdrant
 * adapter reuses the same helper and does.
 */
export function transportFailure(
  outcome: MemoryHttpOutcome,
  timeoutMs: number,
  baseUrl: string,
  secret?: string | null,
): EmbeddingFailure | null {
  if (outcome.kind === 'timeout') return { kind: 'timeout', timeoutMs };
  if (outcome.kind === 'unreachable') {
    return {
      kind: 'unreachable',
      reason: redactSecret(`Could not reach ${baseUrl} — ${outcome.reason}`, secret ?? null),
    };
  }
  return null;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}
