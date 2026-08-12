import { type Db, type EventPayload, newId, schema } from '@mc/shared';
import { and, eq, inArray, isNotNull, not } from 'drizzle-orm';
import type { Outbox } from '../../events/index.js';
import { insertSessionEvent, type TranscriptTailStateRow } from '../repository.js';
import { OBSERVATION_CLOSED_STATES } from './observability.js';
import type { TailCursorAdvance, TailState, TailStateStore } from './ports.js';

/**
 * `transcript_tail_states` (TDS 03 §3.15) — the tailer's cursor, and the transaction in which
 * observation degrades.
 *
 * The table exists so tailing **survives Backend restarts**: on boot the registry reloads rows
 * for non-terminal observed Sessions and reattaches at the persisted byte offset instead of
 * re-ingesting from byte 0. The message dedupe key would absorb a full re-read, but not the
 * cost of one.
 *
 * `degrade()` is the interesting method and the only one with a contract beyond storage — see
 * its own comment.
 */

export interface DbTailStateStoreOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly now?: () => Date;
}

export class DbTailStateStore implements TailStateStore {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #now: () => Date;

  constructor(options: DbTailStateStoreOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#now = options.now ?? (() => new Date());
  }

  async attach(input: {
    readonly sessionId: string;
    readonly transcriptPath: string;
  }): Promise<TailState> {
    // `ux_transcript_tail_session` is a plain (non-partial) unique index, so the conflict
    // target needs no predicate here — unlike `ux_messages_session_runtime_id` (TDS 03 §3.11).
    await this.#db
      .insert(schema.transcriptTailStates)
      .values({
        id: newId(),
        sessionId: input.sessionId,
        transcriptPath: input.transcriptPath,
      })
      .onConflictDoNothing({ target: schema.transcriptTailStates.sessionId });

    const existing = await this.load(input.sessionId);
    /* c8 ignore next 3 — the insert above guarantees a row unless it was deleted concurrently */
    if (existing === null) {
      throw new Error(`transcript tail state vanished for session ${input.sessionId}`);
    }

    // Follow a moved transcript, but never resurrect a degraded row (A11).
    if (existing.transcriptPath !== input.transcriptPath && !existing.degraded) {
      await this.#db
        .update(schema.transcriptTailStates)
        .set({
          transcriptPath: input.transcriptPath,
          byteOffset: 0,
          lineNo: 0,
          updatedAt: this.#now(),
        })
        .where(eq(schema.transcriptTailStates.sessionId, input.sessionId));

      return { ...existing, transcriptPath: input.transcriptPath, byteOffset: 0, lineNo: 0 };
    }

    return existing;
  }

  async load(sessionId: string): Promise<TailState | null> {
    const rows = await this.#db
      .select()
      .from(schema.transcriptTailStates)
      .where(eq(schema.transcriptTailStates.sessionId, sessionId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toTailState(row);
  }

  async advance(sessionId: string, advance: TailCursorAdvance): Promise<void> {
    await this.#db
      .update(schema.transcriptTailStates)
      .set({
        byteOffset: advance.byteOffset,
        lineNo: advance.lineNo,
        driftCount: advance.driftCount,
        lastReadAt: advance.lastReadAt ?? this.#now(),
        ...(advance.lastError === undefined ? {} : { lastError: advance.lastError }),
        updatedAt: this.#now(),
      })
      .where(eq(schema.transcriptTailStates.sessionId, sessionId));
  }

  /**
   * Degrade to hook-only observation — the whole of TDS 04 §6.9 in one transaction.
   *
   * The `degraded = false` predicate on the UPDATE is what makes the event **exactly once per
   * Session**: the flip and the emit are decided by the same statement, so two concurrent
   * bursts (or a burst racing a restart) cannot both announce it. There is deliberately no
   * inverse — no `session.observation_restored`, no re-attach — because the transcript has
   * holes either way and "restored" would overstate what the operator is seeing (A11).
   *
   * This is **not** an F7 transition: no `session.state_changed`, no state write, no
   * `sessions` row touched at all.
   */
  async degrade(sessionId: string, reason: string, driftCount: number): Promise<boolean> {
    const at = this.#now();

    return this.#outbox.run(async (ctx) => {
      const flipped = await ctx.tx
        .update(schema.transcriptTailStates)
        .set({ degraded: true, lastError: reason, driftCount, updatedAt: at })
        .where(
          and(
            eq(schema.transcriptTailStates.sessionId, sessionId),
            eq(schema.transcriptTailStates.degraded, false),
          ),
        )
        .returning({ id: schema.transcriptTailStates.id });

      if (flipped.length === 0) return false;

      const payload: EventPayload = {
        sessionId,
        reason,
        driftCount,
        // §6.9: the *post*-degradation channel. The tailer is gone; hooks continue.
        channel: 'hooks_only',
      };

      // §6.9: appended to the session timeline as `kind: 'observation_changed'`, which
      // `serialize.ts` derives from this exact event name.
      await insertSessionEvent(ctx.tx, {
        sessionId,
        type: 'session.observation_degraded',
        trigger: 'system',
        payload,
        correlationId: sessionId,
        occurredAt: at,
      });

      await ctx.emit(
        this.#outbox.event('session.observation_degraded', payload, {
          correlationId: sessionId,
          occurredAt: at,
        }),
      );

      return true;
    });
  }

  /**
   * The boot reattach set: observed Sessions that are still running, still have a transcript
   * path, and have not degraded. Degraded rows are excluded here as well as in the tailer —
   * A11 is enforced at both ends so a restart cannot quietly undo it.
   */
  async listResumable(): Promise<readonly TailState[]> {
    const rows = await this.#db
      .select({ tail: schema.transcriptTailStates })
      .from(schema.transcriptTailStates)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.transcriptTailStates.sessionId))
      .where(
        and(
          eq(schema.sessions.sessionType, 'observed'),
          not(inArray(schema.sessions.state, [...OBSERVATION_CLOSED_STATES])),
          eq(schema.transcriptTailStates.degraded, false),
          isNotNull(schema.transcriptTailStates.transcriptPath),
        ),
      );

    return rows.map((row) => toTailState(row.tail));
  }
}

function toTailState(row: TranscriptTailStateRow): TailState {
  return {
    sessionId: row.sessionId,
    transcriptPath: row.transcriptPath,
    byteOffset: Number(row.byteOffset),
    lineNo: Number(row.lineNo),
    driftCount: row.driftCount,
    degraded: row.degraded,
    lastError: row.lastError,
  };
}
