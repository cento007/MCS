import type { EntityId, MessageRole, SessionState, TransitionTrigger } from '@mc/shared';
import type { Outbox, OutboxTransaction } from '../events/index.js';
import { ApiError } from '../http/errors.js';
import {
  deriveTitleIfUnset,
  insertMessage,
  insertSessionEvent,
  lockSessionById,
  type MessageRow,
  nextMessageOrdinal,
} from './repository.js';
import { deriveSessionTitle } from './title.js';

/**
 * Message append — the write half of TDS 04 §6.6, and the transaction in which A13 session
 * titles are derived (§6.11.1: "at the moment the Backend persists a Message with
 * `role = 'user'`, **in the same transaction as that insert**").
 *
 * This is the domain service, not an endpoint. Its callers are the managed prompt path and
 * the observed-session ingest path, both of which belong to the wrapper workstream; both
 * converge here so exactly one implementation of ordinal assignment, de-duplication, title
 * derivation, the timeline row and the `session.message.appended` event exists.
 *
 * `POST /sessions/{id}/prompts` is deliberately **not** wired to it yet: that endpoint promises
 * a `202` followed by a streamed assistant turn, and promising the stream without a runtime to
 * produce it would be a lie told in HTTP.
 */

export interface AppendMessageInput {
  readonly sessionId: string;
  readonly role: MessageRole;
  /** Canonical rendered text — searchable, exportable, and the title-derivation input. */
  readonly content?: string;
  /** Raw structured blocks for faithful re-rendering (TDS 03 §3.11). */
  readonly contentBlocks?: unknown[] | null;
  readonly status?: 'complete' | 'pending' | 'interrupted';
  readonly model?: string | null;
  readonly toolName?: string | null;
  readonly toolUseId?: string | null;
  readonly toolPayload?: Record<string, unknown> | null;
  /** Absolute native path from a file-naming tool's input (TDS 03 §3.11 / §6.10.2). */
  readonly toolFilePath?: string | null;
  /** Runtime message uuid or synthesized `hook:…` key — the sole ingest dedupe key. */
  readonly runtimeMessageId?: string | null;
  readonly occurredAt?: Date;
  readonly id?: EntityId;
  /** Timeline trigger (F7 wording); user prompts are `user`, everything else `system`. */
  readonly trigger?: TransitionTrigger;
  readonly correlationId?: string | null;
}

export interface AppendMessageResult {
  /** `null` when the write collapsed into an existing row (a redelivered hook, a replay). */
  readonly message: MessageRow | null;
  /** True when this call is the one that named the Session (§6.11.3). */
  readonly titleDerived: boolean;
  readonly deduplicated: boolean;
}

/** Prompts are rejected unless the Session is `running` (TDS 04 §1.3 `SESSION_NOT_RUNNING`). */
export const PROMPTABLE_STATES: readonly SessionState[] = ['running'];

export interface MessageServiceOptions {
  readonly outbox: Outbox;
}

export class MessageService {
  readonly #outbox: Outbox;

  constructor(options: MessageServiceOptions) {
    this.#outbox = options.outbox;
  }

  /**
   * Persist one Message and everything that must commit with it.
   *
   * In one transaction: the Session row lock (which is what makes "one writer per Session"
   * true for ordinal assignment, TDS 03 §3.11), the ordinal, the insert with its partial-index
   * `ON CONFLICT`, the A13 title derivation, the timeline row, and the
   * `session.message.appended` enqueue.
   */
  async append(input: AppendMessageInput, ctx?: OutboxTransaction): Promise<AppendMessageResult> {
    return this.#outbox.join(ctx, async (outboxTx) => {
      const session = await lockSessionById(outboxTx.tx, input.sessionId);
      if (session === null) {
        throw new ApiError('NOT_FOUND', `No session with id ${input.sessionId}`);
      }

      const ordinal = await nextMessageOrdinal(outboxTx.tx, session.id);
      const message = await insertMessage(outboxTx.tx, {
        ...input,
        ordinal,
      });

      // §6.11.1: a replay collapsed by the dedupe key derives nothing, appends nothing, and
      // emits nothing — the title was already decided by the write it collapsed into.
      if (message === null) {
        return { message: null, titleDerived: false, deduplicated: true };
      }

      const titleDerived = await this.#deriveTitle(outboxTx, session.id, input, message);
      const trigger: TransitionTrigger =
        input.trigger ?? (input.role === 'user' ? 'user' : 'system');
      const correlationId = input.correlationId ?? session.id;

      const payload = {
        sessionId: session.id,
        messageId: message.id,
        role: message.role,
        ordinal: Number(message.ordinal),
        status: message.status,
      };

      await insertSessionEvent(outboxTx.tx, {
        sessionId: session.id,
        type: 'session.message.appended',
        trigger,
        payload,
        correlationId,
        occurredAt: message.occurredAt,
      });

      await outboxTx.emit(
        this.#outbox.event('session.message.appended', payload, {
          correlationId,
          occurredAt: message.occurredAt,
        }),
      );

      return { message, titleDerived, deduplicated: false };
    });
  }

  async #deriveTitle(
    outboxTx: OutboxTransaction,
    sessionId: string,
    input: AppendMessageInput,
    message: MessageRow,
  ): Promise<boolean> {
    // §6.11.1: only `role = 'user'`, only when the insert actually created a row.
    if (input.role !== 'user') return false;

    const derived = deriveSessionTitle(renderedText(input, message));
    // §6.11.2 step 6: nothing derivable — write nothing and leave the next user Message
    // eligible. The rule is "derived once successfully", not "attempted once".
    if (derived === null) return false;

    return deriveTitleIfUnset(outboxTx.tx, sessionId, derived);
  }
}

/**
 * The derivation input (§6.11.2): the persisted Message's rendered text — equivalently, the
 * `type: 'text'` blocks concatenated in order. `thinking`, `tool_use` and `tool_result` blocks
 * are ignored.
 */
function renderedText(input: AppendMessageInput, message: MessageRow): string {
  if (message.content.length > 0) return message.content;

  const blocks = input.contentBlocks;
  if (!Array.isArray(blocks)) return '';

  return blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n');
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  if (typeof value !== 'object' || value === null) return false;
  const block = value as { type?: unknown; text?: unknown };
  return block.type === 'text' && typeof block.text === 'string';
}
