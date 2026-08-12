import { type Db, schema } from '@mc/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The one `security` setting the auth module needs before `settings/` exists as a service:
 * `security.sessionTimeoutMinutes` (TDS 04 §7.2, PRD §4.4.6).
 *
 * Storage coordinates come from the WS2 §7.6 derivation rule — one row per top-level field,
 * `key = snake_case(field)`, category `security`:
 *
 *   `security.sessionTimeoutMinutes` -> `('security', 'session_timeout_minutes')`, number
 *
 * SCOPE NOTE: this is deliberately NOT the settings service (TDS 04 §7.3) and not the key
 * registry (TDS 04 §7.6, owned by WS2 and due in `packages/shared/src/settings/`). It is a
 * single typed read with a documented default, so the session timeout is a real setting from
 * day one instead of a constant that later has to be un-hardcoded. When the registry lands,
 * this reader is replaced by it; the storage coordinates above will not change.
 */

/** WS5 §5.7.11 renders the control defaulted to "7 days" of inactivity. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 7 * 24 * 60;

/** One minute floor, one year ceiling — a timeout outside this is a corrupt row, not a policy. */
const MIN_SESSION_TIMEOUT_MINUTES = 1;
const MAX_SESSION_TIMEOUT_MINUTES = 365 * 24 * 60;

export const SECURITY_SETTING_KEYS = Object.freeze({
  sessionTimeoutMinutes: 'session_timeout_minutes',
} as const);

/**
 * Read the idle session timeout (TDS 04 §1.4). Falls back to the documented default when
 * the row is absent (first run, before settings are seeded) or unusable.
 */
export async function readSessionTimeoutMinutes(db: Db): Promise<number> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.category, 'security'),
        eq(schema.settings.key, SECURITY_SETTING_KEYS.sessionTimeoutMinutes),
      ),
    )
    .limit(1);

  const raw = rows[0]?.value;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SESSION_TIMEOUT_MINUTES;

  const minutes = Math.floor(raw);
  if (minutes < MIN_SESSION_TIMEOUT_MINUTES || minutes > MAX_SESSION_TIMEOUT_MINUTES) {
    return DEFAULT_SESSION_TIMEOUT_MINUTES;
  }
  return minutes;
}
