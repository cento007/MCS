import { type Db, schema } from '@mc/shared';
import { and, eq } from 'drizzle-orm';
import { integerValue, moneyValue, objectValue, readCategoryValues } from './values.js';

/**
 * The `integrations.claudeCode` settings Phase 1 needs before `settings/` exists as a service
 * (TDS 04 §7.2, PRD §4.4.2): `maxConcurrentSessions` (F1.5 concurrency gate) and `costBudget`
 * (the spend read model, §7.8).
 *
 * Storage coordinates come from the WS2 §7.6 derivation rule — one row per top-level field,
 * `key = snake_case(integration) + '_' + snake_case(field)`, category `integrations`:
 *
 *   `integrations.claudeCode.maxConcurrentSessions`
 *     -> `('integrations', 'claude_code_max_concurrent_sessions')`, number
 *   `integrations.claudeCode.costBudget`
 *     -> `('integrations', 'claude_code_cost_budget')`, object — read WHOLE (§7.6 rule 1)
 *
 * SCOPE NOTE: like `security.ts`, this is deliberately NOT the settings service (TDS 04 §7.3)
 * and not the key registry (§7.6, `packages/shared/src/settings/registry.ts`). It is a set of
 * typed reads with documented defaults, so these are real settings from day one instead of
 * constants that later have to be un-hardcoded. The coordinates above will not change when the
 * registry lands.
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
  costBudget: 'claude_code_cost_budget',
} as const);

/**
 * `ClaudeCodeSettings.costBudget` (TDS 04 §7.2, §7.8).
 *
 * `dailyUsd: null` means **no budget**, which is a different statement from "alerts off" —
 * the latter lives in `notifications.events.costBudgetAlert` and the two are never conflated
 * (§7.2 note, WS5 §3.1/§5.2).
 */
export interface CostBudget {
  readonly dailyUsd: number | null;
  readonly perSessionUsd: number | null;
  /** 1–100. WS5 §5.7.4 renders the control defaulted to 80. */
  readonly alertThresholdPercent: number;
}

export const DEFAULT_ALERT_THRESHOLD_PERCENT = 80;

/** No budget configured — the shape `GET /spend` reports as `dayStatus: 'no_budget'`. */
export const NO_COST_BUDGET: CostBudget = Object.freeze({
  dailyUsd: null,
  perSessionUsd: null,
  alertThresholdPercent: DEFAULT_ALERT_THRESHOLD_PERCENT,
});

/**
 * Parse the stored JSONB object. Pure, and every field degrades independently: a corrupt
 * `alertThresholdPercent` must not be able to erase a configured `dailyUsd`, because that
 * would silently turn a budgeted instance into an unbudgeted one.
 */
export function parseCostBudget(raw: unknown): CostBudget {
  const object = objectValue(raw);
  if (object === null) return NO_COST_BUDGET;

  return {
    dailyUsd: moneyValue(object['dailyUsd']),
    perSessionUsd: moneyValue(object['perSessionUsd']),
    alertThresholdPercent: integerValue(
      object['alertThresholdPercent'],
      DEFAULT_ALERT_THRESHOLD_PERCENT,
      { min: 1, max: 100 },
    ),
  };
}

/** Read `integrations.claudeCode.costBudget` (§7.8 setting-key table, verbatim). */
export async function readCostBudget(db: Db): Promise<CostBudget> {
  const values = await readCategoryValues(db, 'integrations');
  return parseCostBudget(values.get(CLAUDE_CODE_SETTING_KEYS.costBudget));
}

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
