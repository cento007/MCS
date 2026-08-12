import { type Db, schema } from '@mc/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The one `integrations.claudeCode` setting the Session domain needs before `settings/` exists
 * as a service: `maxConcurrentSessions` (TDS 04 §7.2, PRD §4.4.2, F1.5 concurrency gate).
 *
 * Storage coordinates come from the WS2 §7.6 derivation rule — one row per top-level field,
 * `key = snake_case(integration) + '_' + snake_case(field)`, category `integrations`:
 *
 *   `integrations.claudeCode.maxConcurrentSessions`
 *     -> `('integrations', 'claude_code_max_concurrent_sessions')`, number
 *
 * SCOPE NOTE: like `security.ts`, this is deliberately NOT the settings service (TDS 04 §7.3)
 * and not the key registry (§7.6, `packages/shared/src/settings/registry.ts`). It is one typed
 * read with a documented default, so the concurrency gate is a real setting from day one
 * instead of a constant that later has to be un-hardcoded. The coordinates above will not
 * change when the registry lands.
 */

/** WS5 §5.7.4 renders the control defaulted to 3. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

/** One session floor; a ceiling that is a rate-limit sanity bound, not a policy. */
const MIN_MAX_CONCURRENT_SESSIONS = 1;
const MAX_MAX_CONCURRENT_SESSIONS = 64;

export const CLAUDE_CODE_SETTING_KEYS = Object.freeze({
  maxConcurrentSessions: 'claude_code_max_concurrent_sessions',
  cliPath: 'claude_code_cli_path',
  defaultModel: 'claude_code_default_model',
} as const);

/**
 * Read `maxConcurrentSessions`. Falls back to the documented default when the row is absent
 * (first run, before settings are seeded) or unusable.
 */
export async function readMaxConcurrentSessions(db: Db): Promise<number> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.category, 'integrations'),
        eq(schema.settings.key, CLAUDE_CODE_SETTING_KEYS.maxConcurrentSessions),
      ),
    )
    .limit(1);

  const raw = rows[0]?.value;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_CONCURRENT_SESSIONS;

  const limit = Math.floor(raw);
  if (limit < MIN_MAX_CONCURRENT_SESSIONS || limit > MAX_MAX_CONCURRENT_SESSIONS) {
    return DEFAULT_MAX_CONCURRENT_SESSIONS;
  }
  return limit;
}

/**
 * The two `integrations.claudeCode` fields the managed wrapper needs at launch (§7.2
 * `ClaudeCodeSettings.cliPath` / `.defaultModel`).
 *
 * Both are optional by design. `cliPath` unset means "let the SDK use the binary it ships with",
 * which is the correct default on a machine where `claude` was installed through the SDK itself;
 * `defaultModel` unset means "whatever the runtime's own default is", which is the only honest
 * answer before an operator has expressed a preference.
 */
export async function readClaudeCodeLaunchSettings(
  db: Db,
): Promise<{ cliPath: string | null; defaultModel: string | null }> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.category, 'integrations'));

  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    cliPath: nonEmptyString(byKey.get(CLAUDE_CODE_SETTING_KEYS.cliPath)),
    defaultModel: nonEmptyString(byKey.get(CLAUDE_CODE_SETTING_KEYS.defaultModel)),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
