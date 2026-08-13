import { type Db, normalizeSetting, schema, settingDefault, settingKey } from '@mc/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The `security` settings the foundation reads directly (TDS 04 §7.2, PRD §4.4.6):
 *
 *   `security.sessionTimeoutMinutes` -> `('security', 'session_timeout_minutes')`, number
 *   `security.allowedOrigins`        -> `('security', 'allowed_origins')`, array
 *
 * Both are consumed on the request path — the idle-timeout check on every authenticated call,
 * the origin allowlist on every WebSocket upgrade — so they are read here as single rows
 * rather than through the settings service, and their defaults and repair rules come from the
 * key registry (§7.6) so the API and these readers cannot disagree.
 */

/** WS5 §5.7.11 renders the control defaulted to "7 days" of inactivity. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = settingDefault<number>(
  'security.sessionTimeoutMinutes',
);

export const SECURITY_SETTING_KEYS = Object.freeze({
  sessionTimeoutMinutes: settingKey('security.sessionTimeoutMinutes'),
  auditLogRetentionDays: settingKey('security.auditLogRetentionDays'),
  allowedOrigins: settingKey('security.allowedOrigins'),
} as const);

/**
 * Read the idle session timeout (TDS 04 §1.4). Falls back to the documented default when
 * the row is absent (first run, before anything has been saved) or unusable.
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

  return normalizeSetting<number>('security.sessionTimeoutMinutes', rows[0]?.value);
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

  return normalizeSetting<readonly string[]>('security.allowedOrigins', rows[0]?.value);
}
