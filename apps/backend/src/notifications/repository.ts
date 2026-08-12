import { type Db, schema } from '@mc/shared';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { NotificationCursor } from './cursors.js';

/**
 * Every `notifications` read and write (TDS 03 §4.2).
 *
 * Creation is deliberately absent: notifications are **system-only** (TDS 04 §8 — the Backend
 * and workers translate events into rows per `NotificationsSettings`). There is no API path
 * that creates one, so there is no repository function that would let one appear.
 */

export type NotificationRow = typeof schema.notifications.$inferSelect;

export interface ListNotificationsInput {
  readonly userId: string;
  readonly limit: number;
  readonly unreadOnly: boolean;
  readonly after?: NotificationCursor | undefined;
}

/**
 * Newest first, keyset-paginated on `(created_at, id)`.
 *
 * `?unread=true` adds `read_at IS NULL`, which is exactly the predicate of the partial index
 * `ix_notifications_unread` — the badge's query stays on the hot subset instead of scanning
 * read history it will never show.
 */
export async function listNotifications(
  db: Db,
  input: ListNotificationsInput,
): Promise<NotificationRow[]> {
  const conditions: SQL[] = [eq(schema.notifications.userId, input.userId)];

  if (input.unreadOnly) conditions.push(isNull(schema.notifications.readAt));

  if (input.after !== undefined) {
    const keyset = or(
      lt(schema.notifications.createdAt, input.after.createdAt),
      and(
        eq(schema.notifications.createdAt, input.after.createdAt),
        lt(schema.notifications.id, input.after.id),
      ),
    );
    if (keyset !== undefined) conditions.push(keyset);
  }

  return db
    .select()
    .from(schema.notifications)
    .where(and(...conditions))
    .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
    .limit(input.limit);
}

export async function findNotificationById(
  db: Db,
  userId: string,
  id: string,
): Promise<NotificationRow | null> {
  const rows = await db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Mark one Notification read, idempotently (TDS 04 §8: "Idempotent").
 *
 * The guard is `read_at IS NULL` in the UPDATE itself rather than a read-then-write, so a
 * second call cannot move the timestamp: `readAt` records **when the operator first saw it**,
 * and a double-click must not rewrite that. `null` back from this function means "no unread
 * row was updated", which the caller resolves into either the already-read row or a 404 — it
 * cannot tell the difference on its own, and guessing would turn a missing id into a 200.
 */
export async function markNotificationRead(
  db: Db,
  userId: string,
  id: string,
  now: Date,
): Promise<NotificationRow | null> {
  const rows = await db
    .update(schema.notifications)
    .set({ readAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.notifications.id, id),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/** `POST /notifications/read-all` — returns how many rows this call actually changed. */
export async function markAllNotificationsRead(db: Db, userId: string, now: Date): Promise<number> {
  const rows = await db
    .update(schema.notifications)
    .set({ readAt: now, updatedAt: now })
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)))
    .returning({ id: schema.notifications.id });

  return rows.length;
}
