import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_VARIABLES } from '../config/schema.js';
import {
  categoryWriteSchema,
  DOCUMENT_CATEGORIES,
  deriveCoordinates,
  INTEGRATION_SLUGS,
  type IntegrationSlug,
  integrationField,
  integrationWriteSchema,
  kebabCase,
  normalizeSetting,
  SETTING_KEYS,
  SETTING_VALUE_TYPES,
  SETTINGS_CATEGORIES,
  settingDefault,
  settingEntry,
  settingEntryForStorage,
  settingKey,
  settingsForCategory,
  settingsForIntegration,
  snakeCase,
} from './registry.js';
import type {
  ClaudeCodeSettings,
  GeneralSettings,
  GithubSettings,
  MemorySettings,
  NotificationsSettingsDocument,
  ObsidianSettings,
  OllamaSettings,
  QdrantSettings,
  SecuritySettings,
  TelegramSettings,
} from './types.js';

/**
 * The registry is the single source for storage coordinates, defaults, validation and the
 * secret flag (TDS 04 §7.6). These tests are the guard rails that make "single" true: every
 * property asserted here is one a second copy of the same knowledge would eventually violate.
 *
 * No database, no Fastify — the registry is data plus pure functions by design.
 */

describe('the derivation rule (§7.6)', () => {
  it('derives `key = snake_case(field)` outside `integrations`', () => {
    expect(deriveCoordinates('general.defaultLandingPage')).toEqual({
      category: 'general',
      integration: null,
      field: 'defaultLandingPage',
      key: 'default_landing_page',
    });
  });

  it('prefixes the integration name inside `integrations`', () => {
    expect(deriveCoordinates('integrations.claudeCode.maxConcurrentSessions')).toEqual({
      category: 'integrations',
      integration: 'claude-code',
      field: 'maxConcurrentSessions',
      key: 'claude_code_max_concurrent_sessions',
    });
  });

  it('reproduces the §7.6 example table exactly', () => {
    expect(settingKey('general.timezone')).toBe('timezone');
    expect(settingKey('integrations.github.syncIntervalMinutes')).toBe(
      'github_sync_interval_minutes',
    );
    expect(settingKey('integrations.github.workflowMode')).toBe('github_workflow_mode');
    expect(settingKey('integrations.github.token')).toBe('github_token');
    expect(settingKey('integrations.claudeCode.costBudget')).toBe('claude_code_cost_budget');
    expect(settingKey('integrations.telegram.botToken')).toBe('telegram_bot_token');
    expect(settingKey('notifications.events')).toBe('events');
    expect(settingKey('notifications.quietHours')).toBe('quiet_hours');
    expect(settingKey('security.allowedOrigins')).toBe('allowed_origins');
  });

  it('round-trips an integration slug through its document field', () => {
    for (const slug of INTEGRATION_SLUGS) {
      expect(kebabCase(integrationField(slug))).toBe(slug);
    }
  });

  it('rejects a path that names no category or no known integration', () => {
    expect(() => deriveCoordinates('services.status')).toThrow(/known category/);
    expect(() => deriveCoordinates('integrations.pinecone.host')).toThrow(/unknown integration/);
    expect(() => deriveCoordinates('general')).toThrow(/<category>\.<field>/);
  });
});

describe('registry integrity', () => {
  it('gives every entry a unique path and a unique (category, key)', () => {
    const paths = new Set(SETTING_KEYS.map((entry) => entry.path));
    const storage = new Set(SETTING_KEYS.map((entry) => `${entry.category}/${entry.key}`));

    expect(paths.size).toBe(SETTING_KEYS.length);
    expect(storage.size).toBe(SETTING_KEYS.length);
  });

  it('uses only the categories and value types the DB CHECKs admit (TDS 03 §3.12)', () => {
    for (const entry of SETTING_KEYS) {
      expect(SETTINGS_CATEGORIES).toContain(entry.category);
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.key.length).toBeLessThanOrEqual(128);
      expect(entry.key).toMatch(/^[a-z0-9_]+$/);
      if (entry.secret) {
        expect(entry.valueType).toBeNull();
      } else {
        expect(SETTING_VALUE_TYPES).toContain(entry.valueType);
      }
    }
  });

  it('holds no bootstrap variable, under any spelling (F8.2)', () => {
    // The F8.2 set is env-only and MUST NOT be storable or servable. Checked mechanically
    // rather than by inspection, so a future `MC_DATA_DIR` setting cannot be added quietly.
    const forbidden = BOOTSTRAP_VARIABLES.map((name) => snakeCase(name).toLowerCase());
    for (const entry of SETTING_KEYS) {
      expect(forbidden).not.toContain(entry.key);
      expect(forbidden).not.toContain(snakeCase(entry.field).toLowerCase());
    }
  });

  it('declares a default that is already normalized — the fixed point of its own repair', () => {
    // If `normalize(default) !== default`, then an empty database and a database holding the
    // default disagree, which is the exact drift this registry exists to prevent.
    for (const entry of SETTING_KEYS) {
      if (entry.secret) continue;
      expect({ path: entry.path, value: entry.normalize(entry.default) }).toEqual({
        path: entry.path,
        value: entry.default,
      });
    }
  });

  it('normalizes junk in every field back to the default', () => {
    for (const entry of SETTING_KEYS) {
      if (entry.secret) continue;
      for (const junk of [undefined, null, 'nonsense', 42, [], {}, Number.NaN]) {
        const normalized = entry.normalize(junk);
        expect(typeof normalized).not.toBe('undefined');
        if (entry.valueType === 'number') expect(Number.isFinite(normalized)).toBe(true);
        if (entry.valueType === 'boolean') expect(typeof normalized).toBe('boolean');
        if (entry.valueType === 'array') expect(Array.isArray(normalized)).toBe(true);
      }
    }
  });

  it('marks exactly the three §7.2 secrets as secret', () => {
    expect(SETTING_KEYS.filter((entry) => entry.secret).map((entry) => entry.path)).toEqual([
      'integrations.github.token',
      'integrations.telegram.botToken',
      'integrations.qdrant.apiKey',
    ]);
  });
});

describe('lookups', () => {
  it('finds an entry by storage coordinate and reports an unknown row as unknown', () => {
    expect(settingEntryForStorage('integrations', 'github_token')?.path).toBe(
      'integrations.github.token',
    );
    expect(settingEntryForStorage('integrations', 'github_tokens')).toBeUndefined();
    expect(settingEntryForStorage('general', 'github_token')).toBeUndefined();
  });

  it('groups the `integrations` category into six integrations with no leftovers', () => {
    const grouped = INTEGRATION_SLUGS.flatMap((slug) => settingsForIntegration(slug));
    expect(grouped).toHaveLength(settingsForCategory('integrations').length);
  });

  it('has no entries for the Phase 4 placeholder category', () => {
    // `memory` was here until Phase 3 gave both of its PRD §4.4 fields a consumer. `agents`
    // stays: a field nothing reads is a lie, and the agent framework has not landed.
    expect(settingsForCategory('agents')).toEqual([]);
  });

  it('declares exactly the two PRD §4.4 item 4 memory fields', () => {
    expect(settingsForCategory('memory').map((entry) => entry.path)).toEqual([
      'memory.indexedSources',
      'memory.retentionDays',
    ]);
  });

  it('throws — loudly, with the path — for a path nobody declared', () => {
    expect(() => settingEntry('general.favouriteColour')).toThrow(/general.favouriteColour/);
  });

  it('refuses to normalize a secret through the value path', () => {
    expect(() => normalizeSetting('integrations.github.token', 'ghp_x')).toThrow(/secret/);
  });
});

describe('defaults an empty database serves (§7.2)', () => {
  it('general', () => {
    expect(settingDefault('general.instanceName')).toBe('Mission Control');
    expect(settingDefault('general.timezone')).toBe('UTC');
    expect(settingDefault('general.theme')).toBe('dark');
    expect(settingDefault('general.defaultLandingPage')).toBe('dashboard');
    expect(settingDefault('general.timeFormat')).toBe('24h');
    expect(settingDefault('general.dateFormat')).toBe('YYYY-MM-DD');
  });

  it('reads an unconfigured schedule as unconfigured, never as a default schedule (§7.7)', () => {
    expect(settingDefault('integrations.github.syncIntervalMinutes')).toBe(0);
    expect(settingDefault('integrations.obsidian.syncIntervalMinutes')).toBe(0);
    expect(settingDefault('integrations.obsidian.vaultPath')).toBeNull();
    expect(settingDefault('integrations.telegram.enabled')).toBe(false);
  });

  it('claude code: three concurrent sessions, no budget, alert at 80 %', () => {
    expect(settingDefault('integrations.claudeCode.maxConcurrentSessions')).toBe(3);
    expect(settingDefault('integrations.claudeCode.costBudget')).toEqual({
      dailyUsd: null,
      perSessionUsd: null,
      alertThresholdPercent: 80,
    });
  });

  it('notifications: every event on, report at 18:00, quiet hours off', () => {
    expect(settingDefault('notifications.events')).toEqual({
      sessionComplete: true,
      sessionFailed: true,
      syncFailed: true,
      repositoryProblem: true,
      costBudgetAlert: true,
    });
    expect(settingDefault('notifications.dailyReport')).toEqual({ enabled: true, time: '18:00' });
    expect(settingDefault('notifications.quietHours')).toEqual({
      enabled: false,
      start: '23:00',
      end: '07:30',
    });
  });

  it('memory: every source indexed, nothing expires', () => {
    // The two defaults that matter most, for opposite reasons. Every source **on**, because an
    // operator who configures an embedding model means "remember my work" and a source that is
    // off by default is one they will never discover was missing. Every tier at `0` — never
    // expire — because the other direction deletes vectors that cost real model time and cannot
    // be recovered from anywhere but a re-index.
    expect(settingDefault('memory.indexedSources')).toEqual({
      session: true,
      commit: true,
      adr: true,
      obsidianNote: true,
      pullRequest: true,
      document: true,
    });
    expect(settingDefault('memory.retentionDays')).toEqual({
      session: 0,
      project: 0,
      global: 0,
    });
  });

  it('has no retention control for the `agent` tier, which nothing writes', () => {
    // A retention window for rows that cannot exist is a policy that can never apply — the same
    // reasoning that keeps `agent` out of `PRODUCIBLE_MEMORY_TIERS` and out of the search
    // filter. It arrives with its producer, in Phase 4.
    expect(Object.keys(settingDefault('memory.retentionDays') as object)).not.toContain('agent');
  });

  it('security: 7 days idle, 180 days retention, no extra origins', () => {
    expect(settingDefault('security.sessionTimeoutMinutes')).toBe(7 * 24 * 60);
    expect(settingDefault('security.auditLogRetentionDays')).toBe(180);
    expect(settingDefault('security.allowedOrigins')).toEqual([]);
  });
});

describe('normalization of stored rows', () => {
  it('keeps a real timezone and replaces one no calendar knows', () => {
    expect(normalizeSetting('general.timezone', 'Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(normalizeSetting('general.timezone', 'Mars/Olympus')).toBe('UTC');
    expect(normalizeSetting('general.timezone', 'A'.repeat(500))).toBe('UTC');
  });

  it('degrades cost-budget fields independently', () => {
    expect(
      normalizeSetting('integrations.claudeCode.costBudget', {
        dailyUsd: 10,
        alertThresholdPercent: 'eighty',
      }),
    ).toEqual({ dailyUsd: 10, perSessionUsd: null, alertThresholdPercent: 80 });
  });

  it('keeps an explicit zero budget distinct from no budget', () => {
    expect(
      normalizeSetting<{ dailyUsd: number | null }>('integrations.claudeCode.costBudget', {
        dailyUsd: 0,
      }).dailyUsd,
    ).toBe(0);
    expect(
      normalizeSetting<{ dailyUsd: number | null }>('integrations.claudeCode.costBudget', {
        dailyUsd: null,
      }).dailyUsd,
    ).toBeNull();
  });

  it('trims, de-duplicates and caps a string list without reordering it', () => {
    expect(
      normalizeSetting('integrations.github.discoveryRoots', [
        ' D:\\Repos ',
        '',
        'D:\\Repos',
        'C:\\Work',
        7,
      ]),
    ).toEqual(['D:\\Repos', 'C:\\Work']);
  });

  it('treats `""` as unset for the paths that document it, and as absent elsewhere', () => {
    expect(normalizeSetting('integrations.claudeCode.cliPath', '')).toBe('');
    expect(normalizeSetting('integrations.github.account', '')).toBeNull();
  });

  it('repairs a corrupt source toggle to ON, never to OFF', () => {
    // The asymmetry is the point: a source silently switched off by a bad row stops being
    // indexed and stops answering, and nothing reports the absence. A source wrongly left on
    // costs some embedding.
    expect(
      normalizeSetting('memory.indexedSources', { commit: 'nope', adr: false, pullRequest: null }),
    ).toEqual({
      session: true,
      commit: true,
      adr: false,
      obsidianNote: true,
      pullRequest: true,
      document: true,
    });
  });

  it('repairs a corrupt retention window to "never expire", never to a short one', () => {
    // Same asymmetry, and here the wrong direction *deletes data* on the strength of bad JSON.
    expect(
      normalizeSetting('memory.retentionDays', { session: 'thirty', project: 30, global: -5 }),
    ).toEqual({ session: 0, project: 30, global: 0 });
  });

  it('rejects a runaway retention window back to "never", never to the ten-year cap', () => {
    // `integerValue` falls back rather than clamping, which is the registry's convention and
    // happens to be the only safe direction here: silently clamping 10 000 days to 3 650 would
    // start deleting ten-year-old memory an operator never asked to expire. The API boundary
    // rejects the write outright (`maximum: 3650`); this is the repair for a row already stored.
    expect(
      normalizeSetting<{ session: number }>('memory.retentionDays', { session: 10_000 }).session,
    ).toBe(0);
  });
});

describe('write schemas (§7.3, arbitration A14)', () => {
  it('requires nothing — an omitted field is an instruction, not a malformed body', () => {
    for (const category of DOCUMENT_CATEGORIES) {
      expect(categoryWriteSchema(category)['required']).toBeUndefined();
    }
  });

  it('does not say `additionalProperties: false`, which Ajv would read as "delete it"', () => {
    // Fastify's Ajv runs `removeAdditional: true`; under full-replace semantics a silently
    // stripped unknown field is a *reset* of the field the caller meant to set. Unknown fields
    // are rejected by name in the write planner instead.
    for (const category of DOCUMENT_CATEGORIES) {
      expect(categoryWriteSchema(category)['additionalProperties']).toBeUndefined();
    }
    expect(integrationWriteSchema('github')['additionalProperties']).toBeUndefined();
  });

  it('exposes exactly the fields of its scope, secrets included', () => {
    const github = integrationWriteSchema('github')['properties'] as Record<string, unknown>;
    expect(Object.keys(github)).toEqual([
      'token',
      'account',
      'organizations',
      'discoveryRoots',
      'syncIntervalMinutes',
      'workflowMode',
    ]);
  });

  it('lets a secret be cleared with `null` but never set to an empty string', () => {
    const token = (integrationWriteSchema('github')['properties'] as Record<string, JsonLike>)[
      'token'
    ];
    expect(token).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 4096 });
  });
});

type JsonLike = Record<string, unknown>;

/**
 * The registry and the §7.2 interfaces must describe the *same fields*, and this is where that
 * is enforced in both directions at once:
 *
 *   - a field added to an interface without a registry entry fails to **compile**, because the
 *     manifest below is `Record<keyof Interface, true>` and would be missing a key;
 *   - a registry entry with no interface field fails the **test**, because the field lists are
 *     compared as sets.
 *
 * Without this, `documentFor<T>`'s cast in the Backend would be an unchecked assertion and the
 * §7.1 masking of a newly added secret could be forgotten silently.
 */
const FIELD_MANIFEST = {
  general: {
    instanceName: true,
    timezone: true,
    dateFormat: true,
    timeFormat: true,
    theme: true,
    defaultLandingPage: true,
  } satisfies Record<keyof GeneralSettings, true>,
  notifications: {
    events: true,
    dailyReport: true,
    quietHours: true,
  } satisfies Record<keyof NotificationsSettingsDocument, true>,
  memory: {
    indexedSources: true,
    retentionDays: true,
  } satisfies Record<keyof MemorySettings, true>,
  security: {
    sessionTimeoutMinutes: true,
    auditLogRetentionDays: true,
    allowedOrigins: true,
  } satisfies Record<keyof SecuritySettings, true>,
} as const;

const INTEGRATION_MANIFEST = {
  github: {
    token: true,
    account: true,
    organizations: true,
    discoveryRoots: true,
    syncIntervalMinutes: true,
    workflowMode: true,
  } satisfies Record<keyof GithubSettings, true>,
  'claude-code': {
    cliPath: true,
    defaultModel: true,
    maxConcurrentSessions: true,
    costBudget: true,
  } satisfies Record<keyof ClaudeCodeSettings, true>,
  telegram: {
    botToken: true,
    chatId: true,
    enabled: true,
  } satisfies Record<keyof TelegramSettings, true>,
  obsidian: {
    vaultPath: true,
    syncMode: true,
    syncIntervalMinutes: true,
    conflictPolicy: true,
  } satisfies Record<keyof ObsidianSettings, true>,
  qdrant: {
    host: true,
    port: true,
    apiKey: true,
    embeddingModel: true,
  } satisfies Record<keyof QdrantSettings, true>,
  ollama: {
    host: true,
    port: true,
    defaultModel: true,
    enabled: true,
  } satisfies Record<keyof OllamaSettings, true>,
} as const satisfies Record<IntegrationSlug, Record<string, true>>;

describe('registry ⇄ §7.2 document types', () => {
  it.each(Object.keys(FIELD_MANIFEST) as (keyof typeof FIELD_MANIFEST)[])(
    'covers every field of %s and nothing else',
    (category) => {
      const registryFields = settingsForCategory(category).map((entry) => entry.field);
      expect([...registryFields].sort()).toEqual(Object.keys(FIELD_MANIFEST[category]).sort());
    },
  );

  it.each(INTEGRATION_SLUGS)('covers every field of integrations.%s and nothing else', (slug) => {
    const registryFields = settingsForIntegration(slug).map((entry) => entry.field);
    expect([...registryFields].sort()).toEqual(Object.keys(INTEGRATION_MANIFEST[slug]).sort());
  });

  it('marks as secret exactly the fields typed `SecretFieldRead`', () => {
    // Hand-listed rather than derived: the whole point is that adding a credential to a
    // document has to be a decision someone wrote down here as well as in the registry.
    const typedAsSecret = [
      'integrations.github.token',
      'integrations.telegram.botToken',
      'integrations.qdrant.apiKey',
    ];
    expect(SETTING_KEYS.filter((entry) => entry.secret).map((entry) => entry.path)).toEqual(
      typedAsSecret,
    );
  });
});
