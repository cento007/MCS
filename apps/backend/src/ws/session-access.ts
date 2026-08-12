import { type Db, type EntityId, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { Principal } from '../auth/principal.js';
import type { SessionAccessPort } from './ports.js';

/**
 * The Phase 1 `SessionAccessPort` (see `ports.ts`): a Session channel may be subscribed to if
 * the Session exists.
 *
 * WHY THAT IS THE WHOLE CHECK. V1 has a single local account (F4.1) and §14.3 states outright
 * that "any authenticated `full` principal may subscribe to any channel". Ownership,
 * workspace scoping and agent permissions are Phase 4 concepts with no rows to check against
 * yet, so inventing a richer rule here would be fiction. What is NOT fiction is that
 * `session:{id}` for an id that does not exist must be refused — otherwise a connection can
 * pin 64 arbitrary channel names into the fan-out index and the ack tells a buggy client that
 * its subscription is live when nothing will ever arrive on it.
 *
 * This is a READ ONLY, and the only statement `ws/` issues. When `sessions/` grows a real
 * read-authorization service, `app.ts` swaps the port and this file goes away; nothing in the
 * hub changes.
 */
export function sessionRowAccess(db: Db): SessionAccessPort {
  return {
    async canRead(_principal: Principal, sessionId: EntityId): Promise<boolean> {
      const rows = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * Every Session is readable. For tests and for any wiring that deliberately has no database —
 * never for a real deployment, which is why it is not the default anywhere.
 */
export function allowAllSessionAccess(): SessionAccessPort {
  return { canRead: async () => true };
}
