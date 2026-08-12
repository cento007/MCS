import { type Db, schema } from '@mc/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The `security` settings the foundation needs before `settings/` exists as a service
 * (TDS 04 §7.2, PRD §4.4.6):
 *
 *   `security.sessionTimeoutMinutes` -> `('security', 'session_timeout_minutes')`, number
 *   `security.allowedOrigins`        -> `('security', 'allowed_origins')`, array
 *
 * Storage coordinates come from the WS2 §7.6 derivation rule — one row per top-level field,
 * `key = snake_case(field)`, category `security`.
 *
 * SCOPE NOTE: this is deliberately NOT the settings service (TDS 04 §7.3) and not the key
 * registry (TDS 04 §7.6, owned by WS2 and due in `packages/shared/src/settings/`). It is a
 * pair of typed reads with documented defaults, so these are real settings from day one
 * instead of constants that later have to be un-hardcoded. When the registry lands, these
 * readers are replaced by it; the storage coordinates above will not change.
 */

/** WS5 §5.7.11 renders the control defaulted to "7 days" of inactivity. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 7 * 24 * 60;

/** One minute floor, one year ceiling — a timeout outside this is a corrupt row, not a policy. */
const MIN_SESSION_TIMEOUT_MINUTES = 1;
const MAX_SESSION_TIMEOUT_MINUTES = 365 * 24 * 60;

export const SECURITY_SETTING_KEYS = Object.freeze({
  sessionTimeoutMinutes: 'session_timeout_minutes',
  allowedOrigins: 'allowed_origins',
} as const);

/**
 * Hard cap on stored origins. Not a contract number — a corrupt or hostile row must not be
 * able to turn an allowlist lookup into an unbounded set (TDS 04 §14.2 default is `[]`).
 */
const MAX_ALLOWED_ORIGINS = 64;

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

/**
 * Read `security.allowedOrigins` (TDS 04 §7.2, default `[]`) — the operator-editable half of
 * the WebSocket Origin allowlist (§14.2, sanctioned deviation D7: a DB setting rather than a
 * bootstrap env var, so the F8.2 variable set stays locked).
 *
 * Returns raw strings; normalisation and matching belong to `ws/origin.ts`, which is where
 * the security decision is made and tested. A malformed row degrades to `[]` rather than
 * throwing: the derived origins alone still admit the operator's own dashboard, and a bad
 * settings row must not be able to lock the console out entirely.
 */
export async function readAllowedOrigins(db: Db): Promise<readonly string[]> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.category, 'security'),
        eq(schema.settings.key, SECURITY_SETTING_KEYS.allowedOrigins),
      ),
    )
    .limit(1);

  const raw = rows[0]?.value;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, MAX_ALLOWED_ORIGINS);
}
