import {
  type Db,
  type DbTransaction,
  type EntityId,
  type MessageRole,
  newId,
  type SessionState,
  type SessionType,
  schema,
  type TransitionTrigger,
} from '@mc/shared';
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

/**
 * All `sessions` / `session_events` / `messages` access, in one module (TDS 03 §3.9–§3.11).
 *
 * **The single-writer rule (TDS 02 §2), enforced by this file's types.** `sessions.state` is
 * mutated *only* by `state-machine.ts`. Nothing here can write it:
 *
 *   - `SessionUpdate` is `Omit<…, 'state'>`, so `updateSession()` physically cannot carry a
 *     state — passing one is a compile error, not a review comment;
 *   - `insertSession()` writes the literal `INITIAL_SESSION_STATE` and takes no state
 *     parameter. A row's birth is `[*] --> created` in F7, not a transition.
 *
 * `state-machine.guard.test.ts` closes the remaining hole by scanning the backend sources for
 * any other `UPDATE sessions … SET state`.
 */

export type SessionRow = typeof schema.sessions.$inferSelect;
export type SessionEventRow = typeof schema.sessionEvents.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
export type TranscriptTailStateRow = typeof schema.transcriptTailStates.$inferSelect;

/** F7: a Session is born `created`. Everything after that is a transition. */
export const INITIAL_SESSION_STATE = 'created' satisfies SessionState;

/** How a Session descends from its parent (arbitration A6, TDS 03 §3.9). */
export type SessionLineageKind = 'resumed' | 'cloned';

export type DbLike = Db | DbTransaction;

export interface InsertSessionInput {
  readonly id?: EntityId;
  readonly projectId: string;
  readonly userId: string;
  readonly repositoryId?: string | null;
  readonly sessionType: SessionType;
  readonly runtime?: string;
  readonly runtimeSessionId?: string | null;
  readonly model?: string | null;
  readonly branch?: string | null;
  readonly workingDir?: string | null;
  readonly title?: string | null;
  readonly notes?: string | null;
  /** Written once at row creation and never mutated (TDS 03 §3.9). */
  readonly resumedFromSessionId?: string | null;
  readonly lineageKind?: SessionLineageKind | null;
}

/**
 * Everything about a Session that is not its F7 state. The `Omit` is the point: it is what
 * makes "only the state machine writes `state`" a type error rather than a convention.
 */
export type SessionUpdate = Omit<
  Partial<typeof schema.sessions.$inferInsert>,
  'id' | 'state' | 'createdAt'
>;

export interface ListSessionsFilters {
  readonly state?: SessionState;
  readonly projectId?: string;
  readonly sessionType?: SessionType;
  readonly repositoryId?: string;
  readonly limit: number;
  /** Opaque cursor's decoded ordering key — the UUIDv7 `id` (TDS 04 §1.2). */
  readonly afterId?: string;
  readonly order: 'asc' | 'desc';
}

export async function findSessionById(db: DbLike, id: string): Promise<SessionRow | null> {
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Read the row `FOR UPDATE` inside the caller's transaction.
 *
 * This is what serializes two concurrent lifecycle actions on one Session: without it, two
 * requests could both read `running` and both write a transition out of it.
 */
export async function lockSessionById(tx: DbTransaction, id: string): Promise<SessionRow | null> {
  const rows = await tx
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function listSessions(
  db: DbLike,
  filters: ListSessionsFilters,
): Promise<SessionRow[]> {
  const conditions = [];
  if (filters.state !== undefined) conditions.push(eq(schema.sessions.state, filters.state));
  if (filters.projectId !== undefined) {
    conditions.push(eq(schema.sessions.projectId, filters.projectId));
  }
  if (filters.sessionType !== undefined) {
    conditions.push(eq(schema.sessions.sessionType, filters.sessionType));
  }
  if (filters.repositoryId !== undefined) {
    conditions.push(eq(schema.sessions.repositoryId, filters.repositoryId));
  }
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.sessions.id, filters.afterId)
        : gt(schema.sessions.id, filters.afterId),
    );
  }

  return db
    .select()
    .from(schema.sessions)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(filters.order === 'desc' ? desc(schema.sessions.id) : asc(schema.sessions.id))
    .limit(filters.limit);
}

export async function insertSession(db: DbLike, input: InsertSessionInput): Promise<SessionRow> {
  const rows = await db
    .insert(schema.sessions)
    .values({
      id: input.id ?? newId(),
      projectId: input.projectId,
      userId: input.userId,
      repositoryId: input.repositoryId ?? null,
      sessionType: input.sessionType,
      // Not a parameter, and not a transition: F7's `[*] --> created`.
      state: INITIAL_SESSION_STATE,
      runtime: input.runtime ?? 'claude_code',
      runtimeSessionId: input.runtimeSessionId ?? null,
      model: input.model ?? null,
      branch: input.branch ?? null,
      workingDir: input.workingDir ?? null,
      title: input.title ?? null,
      notes: input.notes ?? null,
      resumedFromSessionId: input.resumedFromSessionId ?? null,
      lineageKind: input.lineageKind ?? null,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Session insert returned no row');
  return row;
}

/** Update anything except `state` (see the module header). */
export async function updateSession(
  db: DbLike,
  id: string,
  update: SessionUpdate,
): Promise<SessionRow | null> {
  const rows = await db
    .update(schema.sessions)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(schema.sessions.id, id))
    .returning();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- session_events (§3.10)

export interface InsertSessionEventInput {
  readonly sessionId: string;
  /** F6 event name, verbatim (TDS 03 §3.10). */
  readonly type: string;
  readonly trigger: TransitionTrigger;
  readonly fromState?: SessionState | null;
  readonly toState?: SessionState | null;
  readonly payload?: Record<string, unknown> | null;
  readonly correlationId?: string | null;
  readonly occurredAt?: Date;
  readonly id?: EntityId;
}

export async function insertSessionEvent(
  db: DbLike,
  input: InsertSessionEventInput,
): Promise<string> {
  const id = input.id ?? newId();
  await db.insert(schema.sessionEvents).values({
    id,
    sessionId: input.sessionId,
    type: input.type,
    trigger: input.trigger,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    payload: input.payload ?? null,
    correlationId: input.correlationId ?? null,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
  return id;
}

export async function listSessionEvents(
  db: DbLike,
  sessionId: string,
  options: { readonly limit: number; readonly afterId?: string },
): Promise<SessionEventRow[]> {
  const conditions = [eq(schema.sessionEvents.sessionId, sessionId)];
  if (options.afterId !== undefined) {
    conditions.push(gt(schema.sessionEvents.id, options.afterId));
  }

  return db
    .select()
    .from(schema.sessionEvents)
    .where(and(...conditions))
    .orderBy(asc(schema.sessionEvents.id))
    .limit(options.limit);
}

// --------------------------------------------------------------------- messages (§3.11)

export interface InsertMessageInput {
  readonly id?: EntityId;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly status?: 'complete' | 'pending' | 'interrupted';
  readonly content?: string;
  readonly contentBlocks?: unknown[] | null;
  readonly model?: string | null;
  readonly toolName?: string | null;
  readonly toolUseId?: string | null;
  readonly toolPayload?: Record<string, unknown> | null;
  readonly toolFilePath?: string | null;
  /** Sole ingest idempotency key together with `sessionId` (WS7 N11, TDS 03 §3.11). */
  readonly runtimeMessageId?: string | null;
  readonly occurredAt?: Date;
}

/**
 * Next per-session `ordinal`. Called inside the transaction that already holds the Session
 * row lock, which is what lets the writer assign `last_ordinal + 1` without cross-process
 * coordination (TDS 03 §3.11: "each Session has exactly one writer at any moment").
 */
export async function nextMessageOrdinal(tx: DbTransaction, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ maxOrdinal: sql<number | null>`max(${schema.messages.ordinal})` })
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId));

  const current = rows[0]?.maxOrdinal;
  return current === null || current === undefined ? 0 : Number(current) + 1;
}

/**
 * Insert a Message, de-duplicating on `(session_id, runtime_message_id)`.
 *
 * **The `ON CONFLICT` target repeats the index predicate on purpose.** `ux_messages_session_
 * runtime_id` is a *partial* unique index; omitting `WHERE runtime_message_id IS NOT NULL`
 * does not silently skip de-duplication, it makes PostgreSQL raise "there is no unique or
 * exclusion constraint matching the ON CONFLICT specification" and the write fails outright
 * (TDS 03 §3.11).
 *
 * @returns the inserted row, or `null` when the write collapsed into an existing one — which
 *   is the signal the title-derivation guard keys off (§6.11.1: "a replay collapsed by the
 *   dedupe key derives nothing").
 */
export async function insertMessage(
  db: DbLike,
  input: InsertMessageInput & { readonly ordinal: number },
): Promise<MessageRow | null> {
  const values = {
    id: input.id ?? newId(),
    sessionId: input.sessionId,
    ordinal: input.ordinal,
    role: input.role,
    status: input.status ?? 'complete',
    content: input.content ?? '',
    contentBlocks: input.contentBlocks ?? null,
    model: input.model ?? null,
    toolName: input.toolName ?? null,
    toolUseId: input.toolUseId ?? null,
    toolPayload: input.toolPayload ?? null,
    toolFilePath: input.toolFilePath ?? null,
    runtimeMessageId: input.runtimeMessageId ?? null,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  };

  const rows =
    input.runtimeMessageId === undefined || input.runtimeMessageId === null
      ? // Mission-Control-originated messages leave the key NULL and are exempt from the
        // index — they are written exactly once by definition (TDS 03 §3.11).
        await db.insert(schema.messages).values(values).returning()
      : await db
          .insert(schema.messages)
          .values(values)
          .onConflictDoNothing({
            target: [schema.messages.sessionId, schema.messages.runtimeMessageId],
            // Drizzle emits this as `ON CONFLICT (…) WHERE … DO NOTHING` — the index predicate,
            // repeated as TDS 03 §3.11 requires.
            where: sql`${schema.messages.runtimeMessageId} IS NOT NULL`,
          })
          .returning();

  return rows[0] ?? null;
}

export interface ListMessagesOptions {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  /** Decoded cursor: the per-session `ordinal`, never the id (arbitration A5, §6.6). */
  readonly afterOrdinal?: number;
  readonly role?: MessageRole;
  readonly status?: 'complete' | 'pending' | 'interrupted';
}

export async function listMessages(
  db: DbLike,
  sessionId: string,
  options: ListMessagesOptions,
): Promise<MessageRow[]> {
  const conditions = [eq(schema.messages.sessionId, sessionId)];
  if (options.role !== undefined) conditions.push(eq(schema.messages.role, options.role));
  if (options.status !== undefined) conditions.push(eq(schema.messages.status, options.status));
  if (options.afterOrdinal !== undefined) {
    conditions.push(
      options.order === 'desc'
        ? lt(schema.messages.ordinal, options.afterOrdinal)
        : gt(schema.messages.ordinal, options.afterOrdinal),
    );
  }

  return db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(
      options.order === 'desc' ? desc(schema.messages.ordinal) : asc(schema.messages.ordinal),
    )
    .limit(options.limit);
}

/**
 * The A13 derivation write, verbatim from TDS 04 §6.11.3:
 *
 *     UPDATE sessions SET title = $derived, updated_at = now() WHERE id = $id AND title IS NULL
 *
 * No `title_derived` flag and therefore no WS3 change: the predicate *is* the question being
 * asked ("has anyone named this Session yet?") and it cannot drift from the value it describes.
 *
 * @returns `true` when this call is the one that named the Session.
 */
export async function deriveTitleIfUnset(
  db: DbLike,
  sessionId: string,
  title: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.sessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.title)))
    .returning({ id: schema.sessions.id });

  return rows.length > 0;
}

// ------------------------------------------------------- observation state (§3.15 / §6.9)

export async function findTranscriptTailState(
  db: DbLike,
  sessionId: string,
): Promise<TranscriptTailStateRow | null> {
  const rows = await db
    .select()
    .from(schema.transcriptTailStates)
    .where(eq(schema.transcriptTailStates.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}
