import type { Db, EntityId } from '@mc/shared';
import type { Principal } from '../../auth/index.js';
import type { Outbox } from '../../events/index.js';
import { ApiError } from '../../http/errors.js';
import { findSessionById } from '../repository.js';
import type { MessageSink } from './ports.js';
import { markPromptDelivered } from './store.js';

/**
 * `POST /api/v1/sessions/{id}/prompts` and the WebSocket `prompt` frame — one code path, two
 * transports (§6.4: "the WebSocket `prompt` frame (§14.4) is transport-equivalent and produces
 * the same result").
 *
 * The order of operations *is* the contract:
 *
 *   1. the Message is persisted `status = 'pending'` **first**, in the transaction that also
 *      derives the Session title (A13, §6.11.1) — "the label must exist even if the prompt is
 *      never transmitted to the runtime";
 *   2. the `202` is returned only after that commit, so a `GET /sessions/{id}` immediately after
 *      already shows the title;
 *   3. transmission to the runtime happens next, and flips the Message to `complete` with a
 *      second `session.message.appended` carrying the new status.
 *
 * Persist-then-transmit is also what makes cold pause honest (TDS 02 §5.1): a prompt that never
 * reached the runtime is already a durable `pending` Message, so it redisplays on resume instead
 * of evaporating — and it is **not** auto-replayed, because nothing replays a `messages` row.
 */

/** §6.4: "Request (max 256 KiB)". Enforced on the route body and again here for the WS path. */
export const MAX_PROMPT_BYTES = 256 * 1024;

export interface PromptSubmission {
  readonly principal?: Principal | undefined;
  readonly sessionId: EntityId;
  readonly content: string;
}

export interface PromptResult {
  readonly messageId: EntityId;
}

/** What the prompt service needs from the managed runtime — nothing else. */
export interface PromptTransport {
  submit(input: {
    readonly sessionId: string;
    readonly content: string;
    readonly messageId: string | null;
    readonly attempt?: number;
  }): Promise<void>;
}

export interface PromptServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly messages: MessageSink;
  readonly runtime: PromptTransport;
  readonly onError?: ((error: unknown, sessionId: string) => void) | undefined;
}

export class PromptService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #messages: MessageSink;
  readonly #runtime: PromptTransport;
  readonly #onError: ((error: unknown, sessionId: string) => void) | undefined;

  constructor(options: PromptServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#messages = options.messages;
    this.#runtime = options.runtime;
    this.#onError = options.onError;
  }

  async submit(input: PromptSubmission): Promise<PromptResult> {
    const session = await findSessionById(this.#db, input.sessionId);
    if (session === null) {
      throw new ApiError('NOT_FOUND', `No session with id ${input.sessionId}`);
    }

    if (session.sessionType === 'observed') {
      // Mission Control does not drive an external CLI (WS1 §5.2); there is no inbox to push to.
      throw new ApiError(
        'OPERATION_NOT_SUPPORTED',
        'Prompts cannot be submitted to an observed session',
        { sessionType: session.sessionType, action: 'prompt' },
      );
    }

    if (session.state !== 'running') {
      throw new ApiError('SESSION_NOT_RUNNING', 'Session is not running', {
        state: session.state,
        action: 'prompt',
      });
    }

    if (Buffer.byteLength(input.content, 'utf8') > MAX_PROMPT_BYTES) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Prompt exceeds the 256 KiB limit', {
        limitBytes: MAX_PROMPT_BYTES,
      });
    }

    // §6.4 + §6.11.1: pending Message and title derivation, one transaction, before the 202.
    const appended = await this.#messages.append({
      sessionId: session.id,
      role: 'user',
      content: input.content,
      contentBlocks: [{ type: 'text', text: input.content }],
      status: 'pending',
      trigger: 'user',
      correlationId: session.id,
    });

    const message = appended.message;
    /* c8 ignore next 3 — a user prompt carries no dedupe key, so the insert always creates */
    if (message === null) {
      throw new ApiError('INTERNAL', 'Prompt message was not persisted');
    }

    await this.#transmit(session.id, message.id, input.content);
    return { messageId: message.id };
  }

  /**
   * Re-send a prompt after rate-limit backoff (WS1 §4.3). The Message already exists and stays
   * `pending` until a transmission succeeds, so a retry adds nothing to the transcript.
   */
  async retry(input: {
    readonly sessionId: string;
    readonly messageId: string | null;
    readonly content: string;
    readonly attempt: number;
  }): Promise<void> {
    const session = await findSessionById(this.#db, input.sessionId);
    // A Session that was paused, ended or failed while the retry waited is not owed a prompt.
    if (session === null || session.state !== 'running') return;

    await this.#runtime.submit({
      sessionId: input.sessionId,
      content: input.content,
      messageId: input.messageId,
      attempt: input.attempt,
    });

    if (input.messageId !== null) {
      await markPromptDelivered(this.#outbox, {
        sessionId: input.sessionId,
        messageId: input.messageId,
      });
    }
  }

  /**
   * Hand the prompt to the runtime, then flip `pending -> complete`.
   *
   * A transmission failure is **not** propagated to the caller: the Message is committed and the
   * `202` has been earned — "user Message persisted" is exactly what the status code promises.
   * The Message stays `pending`, which is precisely the state §6.4 defines for "accepted but not
   * yet transmitted", and the operator sees it as such.
   */
  async #transmit(sessionId: string, messageId: string, content: string): Promise<void> {
    try {
      await this.#runtime.submit({ sessionId, content, messageId });
      await markPromptDelivered(this.#outbox, { sessionId, messageId });
    } catch (error) {
      this.#onError?.(error, sessionId);
    }
  }
}
