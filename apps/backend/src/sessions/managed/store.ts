import { type Db, schema } from '@mc/shared';
import { and, eq } from 'drizzle-orm';
import type { Outbox } from '../../events/index.js';
import { findSessionById, updateSession } from '../repository.js';
import { baselineFrom, type SessionCostSnapshot, ZERO_COST } from './cost.js';
import type { SessionCostStore } from './ports.js';

/**
 * The two database writes the managed wrapper owns outside `MessageService` and the state
 * machine: **cost/usage totals** on the Session row, and the `pending -> complete` **status
 * flip** on a transmitted prompt Message (§6.4).
 *
 * Neither touches `sessions.state`. `updateSession`'s type physically cannot carry one
 * (`repository.ts`'s `SessionUpdate` is `Omit<…, 'state'>`), which is the single-writer rule of
 * TDS 02 §2 enforced by the compiler rather than by review.
 */

export function createSessionCostStore(db: Db): SessionCostStore {
  return {
    async read(sessionId: string): Promise<SessionCostSnapshot> {
      const row = await findSessionById(db, sessionId);
      // A Session that has never run has no totals, and a missing row is the launch path's
      // problem to report, not this one's.
      return row === null ? ZERO_COST : baselineFrom(row);
    },

    async write(sessionId: string, snapshot: SessionCostSnapshot): Promise<void> {
      await updateSession(db, sessionId, {
        // `numeric(12,6)`: money is a decimal string end to end, never a float (F4.2).
        totalCostUsd: snapshot.totalCostUsd.toFixed(6),
        usage: snapshot.usage,
        numTurns: snapshot.numTurns,
        durationMs: snapshot.durationMs,
        durationApiMs: snapshot.durationApiMs,
      });
    },
  };
}

/**
 * §6.4: "The user Message is persisted with `status = 'pending'` at acceptance and flips to
 * `'complete'` once the runtime has received it; a second `session.message.appended` for the
 * same `messageId` carries the new status."
 *
 * Two deliberate choices:
 *   - the `WHERE status = 'pending'` predicate makes the flip idempotent, so a retried
 *     transmission cannot emit a second event for an already-complete Message;
 *   - **no second `session_events` row.** The timeline records that the prompt was appended
 *     (§6.7); recording "…and it was transmitted" as a separate lifecycle fact would double
 *     every prompt in the operator's timeline to convey a status the Message itself carries.
 *     The F6 event still fires, because that is what tells a connected client to re-render.
 */
export async function markPromptDelivered(
  outbox: Outbox,
  input: { readonly sessionId: string; readonly messageId: string },
): Promise<boolean> {
  return outbox.run(async (outboxTx) => {
    const updated = await outboxTx.tx
      .update(schema.messages)
      .set({ status: 'complete', updatedAt: new Date() })
      .where(and(eq(schema.messages.id, input.messageId), eq(schema.messages.status, 'pending')))
      .returning({
        id: schema.messages.id,
        role: schema.messages.role,
        ordinal: schema.messages.ordinal,
        status: schema.messages.status,
      });

    const row = updated[0];
    if (row === undefined) return false;

    await outboxTx.emit(
      outbox.event(
        'session.message.appended',
        {
          sessionId: input.sessionId,
          messageId: row.id,
          role: row.role,
          ordinal: Number(row.ordinal),
          status: row.status,
        },
        { correlationId: input.sessionId },
      ),
    );

    return true;
  });
}
