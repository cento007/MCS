import {
  type CostBudget,
  type Db,
  DEFAULT_COST_BUDGET,
  normalizeSetting,
  schema,
  settingDefault,
  settingKey,
} from '@mc/shared';
import { and, eq } from 'drizzle-orm';
import { readCategoryValues, stringValue } from './values.js';

/**
 * The `integrations.claudeCode` reads the Session domain needs (TDS 04 §7.2, PRD §4.4.2):
 * `maxConcurrentSessions` (F1.5 concurrency gate), `costBudget` (the spend read model, §7.8),
 * and the two launch fields (`cliPath`, `defaultModel`).
 *
 * Storage coordinates and defaults come from the key registry (§7.6) rather than from
 * constants declared here — `main.ts` reads `maxConcurrentSessions` before the HTTP server
 * exists, and the Settings page writes it; the two must not be able to disagree about what an
 * unwritten row means.
 *
 *   `integrations.claudeCode.maxConcurrentSessions` -> `('integrations', 'claude_code_max_concurrent_sessions')`
 *   `integrations.claudeCode.costBudget`            -> `('integrations', 'claude_code_cost_budget')`, read WHOLE
 */

export type { CostBudget };

/** WS5 §5.7.4 renders the control defaulted to 3. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = settingDefault<number>(
  'integrations.claudeCode.maxConcurrentSessions',
);

export const DEFAULT_ALERT_THRESHOLD_PERCENT = DEFAULT_COST_BUDGET.alertThresholdPercent;

/** No budget configured — the shape `GET /spend` reports as `dayStatus: 'no_budget'`. */
export const NO_COST_BUDGET: CostBudget = DEFAULT_COST_BUDGET;

export const CLAUDE_CODE_SETTING_KEYS = Object.freeze({
  maxConcurrentSessions: settingKey('integrations.claudeCode.maxConcurrentSessions'),
  cliPath: settingKey('integrations.claudeCode.cliPath'),
  defaultModel: settingKey('integrations.claudeCode.defaultModel'),
  costBudget: settingKey('integrations.claudeCode.costBudget'),
} as const);

/**
 * Parse the stored JSONB object. Pure, and every field degrades independently: a corrupt
 * `alertThresholdPercent` must not be able to erase a configured `dailyUsd`, because that
 * would silently turn a budgeted instance into an unbudgeted one.
 */
export function parseCostBudget(raw: unknown): CostBudget {
  return normalizeSetting<CostBudget>('integrations.claudeCode.costBudget', raw);
}

/** Read `integrations.claudeCode.costBudget` (§7.8 setting-key table, verbatim). */
export async function readCostBudget(db: Db): Promise<CostBudget> {
  const values = await readCategoryValues(db, 'integrations');
  return parseCostBudget(values.get(CLAUDE_CODE_SETTING_KEYS.costBudget));
}

/**
 * Read `maxConcurrentSessions`. Falls back to the documented default when the row is absent
 * (first run, before anything has been saved) or unusable.
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

  return normalizeSetting<number>('integrations.claudeCode.maxConcurrentSessions', rows[0]?.value);
}

/**
 * The two `integrations.claudeCode` fields the managed wrapper needs at launch (§7.2
 * `ClaudeCodeSettings.cliPath` / `.defaultModel`).
 *
 * Both are optional by design, and the API models "unset" as `''` (§7.2 keeps the field a
 * plain `string`); this reader converts that to `null`, which is what the runtime adapter
 * means by "use your own default".
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
    cliPath: stringValue(byKey.get(CLAUDE_CODE_SETTING_KEYS.cliPath)),
    defaultModel: stringValue(byKey.get(CLAUDE_CODE_SETTING_KEYS.defaultModel)),
  };
}
