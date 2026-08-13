import {
  booleanValue,
  enumValue,
  integerValue,
  isKnownTimezone,
  MAX_TIMEZONE_LENGTH,
  moneyValue,
  objectValue,
  stringListValue,
  stringValue,
  timeOfDayValue,
} from './coerce.js';
import {
  type CostBudget,
  DATE_FORMATS,
  type DailyReportSettings,
  LANDING_PAGES,
  type NotificationEventToggles,
  OBSIDIAN_CONFLICT_POLICIES,
  OBSIDIAN_SYNC_MODES,
  type QuietHoursSettings,
  SETTINGS_THEMES,
  TIME_FORMATS,
  WORKFLOW_MODES,
} from './types.js';

/**
 * **The settings key registry** (TDS 04 §7.6, owned by WS2, shipped here as WS3 §3.12 requires).
 *
 * One declaration per settable field, and it is the *only* place that knows:
 *
 *   - which `(category, key)` rows exist at all — the DB has a CHECK on `category`, nothing more;
 *   - each key's `value_type`, so the `ck_settings_value_matches_type` CHECK is satisfied by
 *     construction rather than by every caller remembering;
 *   - each key's **default**, applied on read when the row is absent (a fresh install has no
 *     rows at all) and on write when a full-replace body omits the field;
 *   - each key's JSON Schema, which is what validates `PUT` bodies at the boundary (F5.1);
 *   - whether it is a **secret** — secrets live in `secret_items`, never in `settings`, and are
 *     read as `{ isSet, updatedAt }` and never as a value (§7.1).
 *
 * Why it exists: before this file, `general.ts`, `claude-code.ts`, `integrations.ts`,
 * `notifications.ts` and `security.ts` each declared their own defaults and their own storage
 * keys because the read models needed them and the settings service did not exist. Three
 * copies of "the sync interval defaults to 0" is two copies too many, and the copy that drifts
 * is discovered by an operator, not by a test. Those readers now source both from here.
 *
 * ## The derivation rule (§7.6, mechanical so drift is impossible)
 *
 * 1. **One row per top-level field of a category document.** Nested objects and arrays are
 *    stored **whole** as JSONB with their inner keys left in camelCase: they are read and
 *    written as a unit, so splitting them buys nothing and costs a migration per field.
 * 2. **`key = snake_case(field)`**, prefixed with `snake_case(integration) + '_'` for the
 *    `integrations` category (one DB category holds every integration).
 * 3. **Secrets never appear in `settings`** — same `(category, key)` coordinates, different
 *    table.
 *
 * Everything except the value semantics is *derived from `path`* by `deriveCoordinates` below,
 * so an entry cannot declare a key that disagrees with its API path.
 *
 * ## Bootstrap exclusion (F8.2)
 *
 * `DATABASE_URL`, `MC_HOST`, `MC_PORT`, `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`, `NODE_ENV` and
 * `LOG_LEVEL` have **no entries here, by construction**. They are required before the database
 * is reachable, so they cannot be stored in it, and no settings route may read or write them.
 */

// ------------------------------------------------------------------------------- vocabulary

/** WS3 `settings.category` / `secret_items.category` CHECK (TDS 03 §3.12–§3.13), verbatim. */
export const SETTINGS_CATEGORIES = [
  'general',
  'integrations',
  'notifications',
  'memory',
  'agents',
  'security',
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === 'string' && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** WS3 `settings.value_type` CHECK, verbatim. */
export const SETTING_VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

/** URL segments of `PUT /settings/integrations/{integration}` (§7.3) — kebab-case on the wire. */
export const INTEGRATION_SLUGS = [
  'github',
  'claude-code',
  'telegram',
  'obsidian',
  'qdrant',
  'ollama',
] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

export function isIntegrationSlug(value: unknown): value is IntegrationSlug {
  return typeof value === 'string' && (INTEGRATION_SLUGS as readonly string[]).includes(value);
}

/**
 * The five categories `GET`/`PUT /settings/{category}` accepts (§7.3). `integrations` is
 * excluded deliberately: it has its own pair of endpoints because it is written one
 * integration at a time.
 */
export const DOCUMENT_CATEGORIES = [
  'general',
  'notifications',
  'memory',
  'agents',
  'security',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export function isDocumentCategory(value: unknown): value is DocumentCategory {
  return typeof value === 'string' && (DOCUMENT_CATEGORIES as readonly string[]).includes(value);
}

/** The phase whose feature *consumes* the setting. Every phase's keys are settable from day one. */
export type SettingPhase = 1 | 2 | 3 | 4;

/** A Fastify/JSON-Schema fragment (F5.1). Deliberately loose — it is data, not a type. */
export type JsonSchema = Record<string, unknown>;

// ------------------------------------------------------------------------------- entry shape

interface SettingKeyEntryCommon {
  /** API path within the settings document, e.g. `integrations.github.syncIntervalMinutes`. */
  readonly path: string;
  readonly category: SettingsCategory;
  /** `null` outside the `integrations` category. Derived from `path`. */
  readonly integration: IntegrationSlug | null;
  /** The camelCase field name inside its document. Derived from `path`. */
  readonly field: string;
  /** DB key (snake_case), unique within `category`. Derived from `path`. */
  readonly key: string;
  /** Validates this field inside a `PUT` body (F5.1). */
  readonly jsonSchema: JsonSchema;
  readonly phase: SettingPhase;
}

export interface ValueSettingKeyEntry extends SettingKeyEntryCommon {
  readonly secret: false;
  readonly valueType: SettingValueType;
  /**
   * Applied on read when the row is absent and on write when a full-replace body omits the
   * field. A `null` default means "stored as row absence" — see `nullable` below.
   */
  readonly default: unknown;
  /**
   * `null` is a real value for this field and is represented by **deleting the row**.
   *
   * There is no `null` in the `value_type` CHECK (`jsonb_typeof('null') = 'null'` matches
   * none of the five), so row-absence is the only representation PostgreSQL admits for
   * "`account` is not set". Reads map absence back to `null` through `default`.
   */
  readonly nullable: boolean;
  /**
   * Repair an untrusted stored value into a valid one, per field, falling back to `default`.
   * Used on read (a corrupt row must not break the page) and on write (canonicalisation).
   */
  normalize(raw: unknown): unknown;
}

export interface SecretSettingKeyEntry extends SettingKeyEntryCommon {
  readonly secret: true;
  /** §7.6's table writes `—`: a secret has no `settings` row and therefore no `value_type`. */
  readonly valueType: null;
  /** "Absent" is the only default a write-only credential can have. */
  readonly default: null;
}

export type SettingKeyEntry = ValueSettingKeyEntry | SecretSettingKeyEntry;

// ------------------------------------------------------------------------------- derivation

/** `syncIntervalMinutes` → `sync_interval_minutes`; `claudeCode` → `claude_code`. */
export function snakeCase(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** `claudeCode` → `claude-code` — the document field name to its URL segment (§7.3). */
export function kebabCase(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** `claude-code` → `claudeCode` — the URL segment back to its `IntegrationsSettings` field. */
export function integrationField(slug: IntegrationSlug): string {
  return slug.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

interface Coordinates {
  readonly category: SettingsCategory;
  readonly integration: IntegrationSlug | null;
  readonly field: string;
  readonly key: string;
}

/**
 * `path` → `(category, integration, field, key)`. The whole of rule 2, in one function that
 * every entry goes through — which is what makes a key that disagrees with its API path
 * unrepresentable rather than merely discouraged.
 */
export function deriveCoordinates(path: string): Coordinates {
  const segments = path.split('.');
  const category = segments[0];
  if (!isSettingsCategory(category)) {
    throw new Error(`Settings path "${path}" does not start with a known category`);
  }

  if (category === 'integrations') {
    const [, integrationCamel, field] = segments;
    if (segments.length !== 3 || integrationCamel === undefined || field === undefined) {
      throw new Error(`Settings path "${path}" must be integrations.<integration>.<field>`);
    }
    const slug = kebabCase(integrationCamel);
    if (!isIntegrationSlug(slug)) {
      throw new Error(`Settings path "${path}" names an unknown integration`);
    }
    return {
      category,
      integration: slug,
      field,
      key: `${snakeCase(integrationCamel)}_${snakeCase(field)}`,
    };
  }

  const [, field] = segments;
  if (segments.length !== 2 || field === undefined) {
    throw new Error(`Settings path "${path}" must be <category>.<field>`);
  }
  return { category, integration: null, field, key: snakeCase(field) };
}

// ------------------------------------------------------------------------------------ bounds

/**
 * Bounds are named constants because each is used **twice** — once in the JSON Schema that
 * rejects a bad write at the boundary, once in the `normalize` that repairs a bad row on read.
 * Written inline they would eventually disagree, and the disagreement would be invisible: the
 * API would accept a value the reader then silently replaced with a default.
 */
export const MAX_INSTANCE_NAME_LENGTH = 120;
export const MAX_MODEL_NAME_LENGTH = 200;
export const MAX_HOST_LENGTH = 255;
export const MAX_PATH_LENGTH = 1024;
export const MAX_LIST_ITEMS = 64;
export const MAX_LIST_ENTRY_LENGTH = 512;
export const MAX_SECRET_LENGTH = 4096;
/** One year of minutes. A larger interval is a corrupt row, not a policy. */
export const MAX_INTERVAL_MINUTES = 365 * 24 * 60;
export const MIN_MAX_CONCURRENT_SESSIONS = 1;
export const MAX_MAX_CONCURRENT_SESSIONS = 64;
/** Ten years. `0` means "keep forever" (WS5 §5.7.11). */
export const MAX_AUDIT_RETENTION_DAYS = 3650;
export const MIN_ALERT_THRESHOLD_PERCENT = 1;
export const MAX_ALERT_THRESHOLD_PERCENT = 100;
/** No sane budget is larger, and a runaway value would disable the alert it configures. */
export const MAX_BUDGET_USD = 1_000_000;

// ---------------------------------------------------------------------------- entry builders

const entries: SettingKeyEntry[] = [];

interface ValueOptions {
  readonly valueType: SettingValueType;
  readonly jsonSchema: JsonSchema;
  readonly default: unknown;
  readonly phase: SettingPhase;
  readonly nullable?: boolean;
  normalize(raw: unknown): unknown;
}

function define(path: string, options: ValueOptions): ValueSettingKeyEntry {
  const entry: ValueSettingKeyEntry = Object.freeze({
    path,
    ...deriveCoordinates(path),
    secret: false,
    valueType: options.valueType,
    jsonSchema: Object.freeze(options.jsonSchema),
    default: options.default,
    nullable: options.nullable ?? false,
    phase: options.phase,
    normalize: options.normalize,
  });
  entries.push(entry);
  return entry;
}

function defineSecret(path: string, phase: SettingPhase): SecretSettingKeyEntry {
  const entry: SecretSettingKeyEntry = Object.freeze({
    path,
    ...deriveCoordinates(path),
    secret: true,
    valueType: null,
    default: null,
    phase,
    // `minLength` applies to strings only, so this admits `null` (clear) and rejects `""` —
    // an empty secret is not a secret, and `encryptSecret` refuses to seal one (TDS 03 §3.13).
    jsonSchema: Object.freeze({
      type: ['string', 'null'],
      minLength: 1,
      maxLength: MAX_SECRET_LENGTH,
    }),
  });
  entries.push(entry);
  return entry;
}

/** A plain string field. `default: null` makes it nullable and stored as row-absence. */
function defineString(
  path: string,
  options: {
    readonly default: string | null;
    readonly maxLength: number;
    readonly phase: SettingPhase;
    /** Allow `''`; used where "" is the documented "unset" (e.g. `cliPath`). */
    readonly allowEmpty?: boolean;
  },
): ValueSettingKeyEntry {
  const nullable = options.default === null;
  return define(path, {
    valueType: 'string',
    default: options.default,
    nullable,
    phase: options.phase,
    jsonSchema: {
      type: nullable ? ['string', 'null'] : 'string',
      ...(options.allowEmpty === true ? {} : { minLength: 1 }),
      maxLength: options.maxLength,
    },
    normalize: (raw) => {
      if (options.allowEmpty === true && raw === '') return '';
      const value = stringValue(raw, options.default);
      return value === null ? null : value.slice(0, options.maxLength);
    },
  });
}

function defineEnum<T extends string>(
  path: string,
  options: {
    readonly values: readonly T[];
    readonly default: T;
    readonly phase: SettingPhase;
  },
): ValueSettingKeyEntry {
  return define(path, {
    valueType: 'string',
    default: options.default,
    phase: options.phase,
    jsonSchema: { type: 'string', enum: [...options.values] },
    normalize: (raw) => enumValue(raw, options.values, options.default),
  });
}

function defineInteger(
  path: string,
  options: {
    readonly default: number;
    readonly min: number;
    readonly max: number;
    readonly phase: SettingPhase;
  },
): ValueSettingKeyEntry {
  return define(path, {
    valueType: 'number',
    default: options.default,
    phase: options.phase,
    jsonSchema: { type: 'integer', minimum: options.min, maximum: options.max },
    normalize: (raw) => integerValue(raw, options.default, { min: options.min, max: options.max }),
  });
}

function defineBoolean(
  path: string,
  options: { readonly default: boolean; readonly phase: SettingPhase },
): ValueSettingKeyEntry {
  return define(path, {
    valueType: 'boolean',
    default: options.default,
    phase: options.phase,
    jsonSchema: { type: 'boolean' },
    normalize: (raw) => booleanValue(raw, options.default),
  });
}

function defineStringList(
  path: string,
  options: {
    readonly phase: SettingPhase;
    readonly maxLength?: number;
  },
): ValueSettingKeyEntry {
  const maxLength = options.maxLength ?? MAX_LIST_ENTRY_LENGTH;
  return define(path, {
    valueType: 'array',
    default: Object.freeze([]),
    phase: options.phase,
    jsonSchema: {
      type: 'array',
      maxItems: MAX_LIST_ITEMS,
      items: { type: 'string', minLength: 1, maxLength },
    },
    normalize: (raw) => stringListValue(raw, { maxItems: MAX_LIST_ITEMS, maxLength }),
  });
}

// ------------------------------------------------------------------------------------ general

export const GENERAL_KEYS = {
  instanceName: defineString('general.instanceName', {
    // WS5 §5.7.1's "Mission Control — Home" is example text in a wireframe box, not a stated
    // default (so is its "Europe/Amsterdam"): the product name is the honest default.
    default: 'Mission Control',
    maxLength: MAX_INSTANCE_NAME_LENGTH,
    phase: 1,
  }),
  /**
   * The single most consequential setting in the product: the calendar boundary for the spend
   * read model (§7.8) and the daily report (§7.7). Explicitly **not** the server's `TZ`, not
   * PostgreSQL's session `TimeZone`, not the browser's zone, and not UTC-by-accident.
   */
  timezone: define('general.timezone', {
    valueType: 'string',
    default: 'UTC',
    phase: 1,
    jsonSchema: { type: 'string', minLength: 1, maxLength: MAX_TIMEZONE_LENGTH },
    normalize: (raw) => (isKnownTimezone(raw) ? raw : 'UTC'),
  }),
  dateFormat: defineEnum('general.dateFormat', {
    values: DATE_FORMATS,
    default: 'YYYY-MM-DD',
    phase: 1,
  }),
  timeFormat: defineEnum('general.timeFormat', { values: TIME_FORMATS, default: '24h', phase: 1 }),
  theme: defineEnum('general.theme', { values: SETTINGS_THEMES, default: 'dark', phase: 1 }),
  defaultLandingPage: defineEnum('general.defaultLandingPage', {
    values: LANDING_PAGES,
    default: 'dashboard',
    phase: 1,
  }),
} as const;

// ------------------------------------------------------------------------- integrations/github

export const GITHUB_KEYS = {
  token: defineSecret('integrations.github.token', 1),
  account: defineString('integrations.github.account', {
    default: null,
    maxLength: MAX_INSTANCE_NAME_LENGTH,
    phase: 1,
  }),
  organizations: defineStringList('integrations.github.organizations', { phase: 1 }),
  discoveryRoots: defineStringList('integrations.github.discoveryRoots', {
    phase: 1,
    maxLength: MAX_PATH_LENGTH,
  }),
  /**
   * `0` = manual only. **An absent row reads as 0, not as the value the form pre-fills**:
   * §7.7 reads `> 0` as "scheduled", so inventing 15 minutes here would make the Dashboard
   * promise a poll that no worker has been told to run.
   */
  syncIntervalMinutes: defineInteger('integrations.github.syncIntervalMinutes', {
    default: 0,
    min: 0,
    max: MAX_INTERVAL_MINUTES,
    phase: 1,
  }),
  workflowMode: defineEnum('integrations.github.workflowMode', {
    values: WORKFLOW_MODES,
    default: 'manual',
    phase: 1,
  }),
} as const;

// --------------------------------------------------------------------- integrations/claudeCode

/** Defaults for the whole `costBudget` object — one JSONB row, read and written whole. */
export const DEFAULT_COST_BUDGET: CostBudget = Object.freeze({
  dailyUsd: null,
  perSessionUsd: null,
  alertThresholdPercent: 80,
});

/**
 * Every field degrades independently: a corrupt `alertThresholdPercent` must not be able to
 * erase a configured `dailyUsd`, because that would silently turn a budgeted instance into an
 * unbudgeted one — the one failure mode a budget cannot have.
 */
function normalizeCostBudget(raw: unknown): CostBudget {
  const object = objectValue(raw);
  if (object === null) return DEFAULT_COST_BUDGET;
  return {
    dailyUsd: capMoney(moneyValue(object['dailyUsd'])),
    perSessionUsd: capMoney(moneyValue(object['perSessionUsd'])),
    alertThresholdPercent: integerValue(
      object['alertThresholdPercent'],
      DEFAULT_COST_BUDGET.alertThresholdPercent,
      { min: MIN_ALERT_THRESHOLD_PERCENT, max: MAX_ALERT_THRESHOLD_PERCENT },
    ),
  };
}

function capMoney(value: number | null): number | null {
  return value === null || value > MAX_BUDGET_USD ? null : value;
}

const moneySchema = { type: ['number', 'null'], minimum: 0, maximum: MAX_BUDGET_USD } as const;

export const CLAUDE_CODE_KEYS = {
  /** `''` means "let the SDK use the binary it ships with" — the right default when Claude
   * Code was installed through the SDK itself. */
  cliPath: defineString('integrations.claudeCode.cliPath', {
    default: '',
    maxLength: MAX_PATH_LENGTH,
    phase: 1,
    allowEmpty: true,
  }),
  /** `''` means "whatever the runtime's own default is" — the only honest answer before the
   * operator has expressed a preference. */
  defaultModel: defineString('integrations.claudeCode.defaultModel', {
    default: '',
    maxLength: MAX_MODEL_NAME_LENGTH,
    phase: 1,
    allowEmpty: true,
  }),
  maxConcurrentSessions: defineInteger('integrations.claudeCode.maxConcurrentSessions', {
    default: 3,
    min: MIN_MAX_CONCURRENT_SESSIONS,
    max: MAX_MAX_CONCURRENT_SESSIONS,
    phase: 1,
  }),
  costBudget: define('integrations.claudeCode.costBudget', {
    valueType: 'object',
    default: DEFAULT_COST_BUDGET,
    phase: 1,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dailyUsd: moneySchema,
        perSessionUsd: moneySchema,
        alertThresholdPercent: {
          type: 'integer',
          minimum: MIN_ALERT_THRESHOLD_PERCENT,
          maximum: MAX_ALERT_THRESHOLD_PERCENT,
        },
      },
    },
    normalize: normalizeCostBudget,
  }),
} as const;

// ---------------------------------------------------------------------- integrations/telegram

export const TELEGRAM_KEYS = {
  botToken: defineSecret('integrations.telegram.botToken', 2),
  chatId: defineString('integrations.telegram.chatId', {
    default: null,
    maxLength: MAX_INSTANCE_NAME_LENGTH,
    phase: 2,
  }),
  enabled: defineBoolean('integrations.telegram.enabled', { default: false, phase: 2 }),
} as const;

// ---------------------------------------------------------------------- integrations/obsidian

export const OBSIDIAN_KEYS = {
  vaultPath: defineString('integrations.obsidian.vaultPath', {
    default: null,
    maxLength: MAX_PATH_LENGTH,
    phase: 2,
  }),
  syncMode: defineEnum('integrations.obsidian.syncMode', {
    values: OBSIDIAN_SYNC_MODES,
    default: 'two_way',
    phase: 2,
  }),
  syncIntervalMinutes: defineInteger('integrations.obsidian.syncIntervalMinutes', {
    default: 0,
    min: 0,
    max: MAX_INTERVAL_MINUTES,
    phase: 2,
  }),
  conflictPolicy: defineEnum('integrations.obsidian.conflictPolicy', {
    values: OBSIDIAN_CONFLICT_POLICIES,
    default: 'newer_wins',
    phase: 2,
  }),
} as const;

// ------------------------------------------------------------- integrations/qdrant and ollama

export const QDRANT_KEYS = {
  host: defineString('integrations.qdrant.host', {
    default: '127.0.0.1',
    maxLength: MAX_HOST_LENGTH,
    phase: 3,
  }),
  port: defineInteger('integrations.qdrant.port', { default: 6333, min: 1, max: 65535, phase: 3 }),
  apiKey: defineSecret('integrations.qdrant.apiKey', 3),
  embeddingModel: defineString('integrations.qdrant.embeddingModel', {
    default: '',
    maxLength: MAX_MODEL_NAME_LENGTH,
    phase: 3,
    allowEmpty: true,
  }),
} as const;

export const OLLAMA_KEYS = {
  host: defineString('integrations.ollama.host', {
    default: '127.0.0.1',
    maxLength: MAX_HOST_LENGTH,
    phase: 3,
  }),
  port: defineInteger('integrations.ollama.port', { default: 11434, min: 1, max: 65535, phase: 3 }),
  defaultModel: defineString('integrations.ollama.defaultModel', {
    default: '',
    maxLength: MAX_MODEL_NAME_LENGTH,
    phase: 3,
    allowEmpty: true,
  }),
  enabled: defineBoolean('integrations.ollama.enabled', { default: false, phase: 3 }),
} as const;

// ------------------------------------------------------------------------------ notifications

export const DEFAULT_EVENT_TOGGLES: NotificationEventToggles = Object.freeze({
  sessionComplete: true,
  sessionFailed: true,
  syncFailed: true,
  repositoryProblem: true,
  costBudgetAlert: true,
});

export const DEFAULT_DAILY_REPORT: DailyReportSettings = Object.freeze({
  enabled: true,
  time: '18:00',
});

/**
 * Quiet hours default **off** even though WS5 §5.7.8's wireframe box shows the checkbox
 * ticked. Those boxes are filled-in examples — the same wireframe shows an instance named
 * "Mission Control — Home" and a Europe/Amsterdam timezone — and a suppression window that is
 * on by default silently withholds alerts from an operator who never asked for it. The window
 * itself keeps the times WS5 chose, so ticking the box gives exactly the wireframe.
 */
export const DEFAULT_QUIET_HOURS: QuietHoursSettings = Object.freeze({
  enabled: false,
  start: '23:00',
  end: '07:30',
});

const timeSchema = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' } as const;

export const NOTIFICATION_KEYS = {
  events: define('notifications.events', {
    valueType: 'object',
    default: DEFAULT_EVENT_TOGGLES,
    phase: 1,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.keys(DEFAULT_EVENT_TOGGLES).map((name) => [name, { type: 'boolean' }]),
      ),
    },
    normalize: (raw) => {
      const object = objectValue(raw) ?? {};
      return Object.fromEntries(
        Object.entries(DEFAULT_EVENT_TOGGLES).map(([name, fallback]) => [
          name,
          booleanValue(object[name], fallback),
        ]),
      ) as unknown as NotificationEventToggles;
    },
  }),
  dailyReport: define('notifications.dailyReport', {
    valueType: 'object',
    default: DEFAULT_DAILY_REPORT,
    phase: 2,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, time: timeSchema },
    },
    normalize: (raw): DailyReportSettings => {
      const object = objectValue(raw) ?? {};
      return {
        enabled: booleanValue(object['enabled'], DEFAULT_DAILY_REPORT.enabled),
        time: timeOfDayValue(object['time'], DEFAULT_DAILY_REPORT.time),
      };
    },
  }),
  quietHours: define('notifications.quietHours', {
    valueType: 'object',
    default: DEFAULT_QUIET_HOURS,
    phase: 2,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, start: timeSchema, end: timeSchema },
    },
    normalize: (raw): QuietHoursSettings => {
      const object = objectValue(raw) ?? {};
      return {
        enabled: booleanValue(object['enabled'], DEFAULT_QUIET_HOURS.enabled),
        start: timeOfDayValue(object['start'], DEFAULT_QUIET_HOURS.start),
        end: timeOfDayValue(object['end'], DEFAULT_QUIET_HOURS.end),
      };
    },
  }),
} as const;

// ----------------------------------------------------------------------------------- security

export const SECURITY_KEYS = {
  /** WS5 §5.7.11 renders the control defaulted to "7 days" of inactivity. */
  sessionTimeoutMinutes: defineInteger('security.sessionTimeoutMinutes', {
    default: 7 * 24 * 60,
    min: 1,
    max: MAX_INTERVAL_MINUTES,
    phase: 1,
  }),
  /** WS5 §5.7.11 renders "180 days"; `0` is its "Keep forever" option. */
  auditLogRetentionDays: defineInteger('security.auditLogRetentionDays', {
    default: 180,
    min: 0,
    max: MAX_AUDIT_RETENTION_DAYS,
    phase: 1,
  }),
  /** Extra WS/CSRF origins (§14.2, sanctioned deviation D7). Default `[]`. */
  allowedOrigins: defineStringList('security.allowedOrigins', {
    phase: 1,
    maxLength: MAX_HOST_LENGTH,
  }),
} as const;

// -------------------------------------------------------------------------------- the indexes

/** Every entry, in declaration order (which is document order). */
export const SETTING_KEYS: readonly SettingKeyEntry[] = Object.freeze([...entries]);

const BY_PATH = new Map(SETTING_KEYS.map((entry) => [entry.path, entry]));
const BY_STORAGE = new Map(SETTING_KEYS.map((entry) => [`${entry.category}/${entry.key}`, entry]));

const BY_CATEGORY = new Map<SettingsCategory, readonly SettingKeyEntry[]>(
  SETTINGS_CATEGORIES.map((category) => [
    category,
    Object.freeze(SETTING_KEYS.filter((entry) => entry.category === category)),
  ]),
);

const BY_INTEGRATION = new Map<IntegrationSlug, readonly SettingKeyEntry[]>(
  INTEGRATION_SLUGS.map((slug) => [
    slug,
    Object.freeze(SETTING_KEYS.filter((entry) => entry.integration === slug)),
  ]),
);

export function settingEntry(path: string): SettingKeyEntry {
  const entry = BY_PATH.get(path);
  if (entry === undefined) throw new Error(`No settings registry entry for "${path}"`);
  return entry;
}

/** The entry that owns a `(category, key)` storage coordinate, or `null` for an unknown row. */
export function settingEntryForStorage(category: string, key: string): SettingKeyEntry | undefined {
  return BY_STORAGE.get(`${category}/${key}`);
}

/** Every entry in a category, including the `integrations` category's six integrations. */
export function settingsForCategory(category: SettingsCategory): readonly SettingKeyEntry[] {
  return BY_CATEGORY.get(category) ?? [];
}

/** Every entry belonging to one integration — the scope of one `PUT` (§7.3). */
export function settingsForIntegration(slug: IntegrationSlug): readonly SettingKeyEntry[] {
  return BY_INTEGRATION.get(slug) ?? [];
}

/** The DB key for an API path. `settingKey('general.timezone') === 'timezone'`. */
export function settingKey(path: string): string {
  return settingEntry(path).key;
}

/**
 * The registry default for an API path, typed at the call site.
 *
 * The cast is unchecked by necessity — `default` is `unknown` because the registry is one
 * heterogeneous list — and safe in practice because `registry.test.ts` asserts every default
 * against its own `normalize`, which is the function that defines the field's type.
 */
export function settingDefault<T>(path: string): T {
  return settingEntry(path).default as T;
}

/** Repair an untrusted stored value for one path (see `ValueSettingKeyEntry.normalize`). */
export function normalizeSetting<T>(path: string, raw: unknown): T {
  const entry = settingEntry(path);
  if (entry.secret) {
    throw new Error(`"${path}" is a secret — its value is never read through the registry`);
  }
  return entry.normalize(raw) as T;
}

// ------------------------------------------------------------------------------- write schemas

/**
 * The JSON Schema for a full-replace `PUT` body (§7.3, arbitration A14).
 *
 * **Nothing is `required`.** A full replace with an omitted non-secret field resets that field
 * to its registry default, and an omitted *secret* keeps its stored value — so "omitted" is a
 * meaningful, valid instruction rather than a malformed body.
 *
 * **`additionalProperties: false` is deliberately absent, and that is not an oversight.**
 * Fastify's Ajv runs with `removeAdditional: true` (its default), which turns
 * `additionalProperties: false` into *silently delete the unknown field* rather than *reject
 * the body*. Under full-replace semantics a silently deleted field is not a no-op — it is a
 * **reset to default**: `PUT { "instanceNam": "…" }` would strip the typo, see `instanceName`
 * as omitted, and quietly overwrite the operator's instance name. So unknown fields are
 * rejected by name instead of being deleted: over HTTP by the global body-field guard
 * (`apps/backend/src/http/body-strictness.ts`, which treats an undeclared name as a 400 at
 * every level of the document — including the nested objects below, which the planner never
 * saw), and for any other caller by the write planner (`documents.ts`, `planWrite`).
 */
export function writeSchemaFor(entriesInScope: readonly SettingKeyEntry[]): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(entriesInScope.map((entry) => [entry.field, entry.jsonSchema])),
  };
}

export function categoryWriteSchema(category: DocumentCategory): JsonSchema {
  return writeSchemaFor(settingsForCategory(category));
}

export function integrationWriteSchema(slug: IntegrationSlug): JsonSchema {
  return writeSchemaFor(settingsForIntegration(slug));
}
