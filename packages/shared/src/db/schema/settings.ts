/**
 * Configuration storage: `settings` (typed key/value rows, TDS 03 §3.12) and `secret_items`
 * (encrypted at rest, TDS 03 §3.13).
 *
 * The authority on which `(category, key)` rows exist, their `value_type`, their JSON Schema
 * and their secret flag is the settings key registry — `packages/shared/src/settings/`
 * (WS2 §7.6) — not this table. Bootstrap settings (`DATABASE_URL`, `MC_HOST`/`MC_PORT`,
 * `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`, `NODE_ENV`/`LOG_LEVEL`) live in the environment only
 * and MUST NOT appear here (F8.2).
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { bytea, createdAt, jsonValue, primaryKeyId, updatedAt, valueList } from './columns.js';

/**
 * PRD §4.4 categories. The `services` category is a read-only view in the UI (live health,
 * PRD §4.4.7) and is deliberately not stored.
 */
const SETTINGS_CATEGORIES = [
  'general',
  'integrations',
  'notifications',
  'memory',
  'agents',
  'security',
] as const;

const SETTING_VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;

export const settings = pgTable(
  'settings',
  {
    id: primaryKeyId(),
    category: text('category').notNull(),
    /** snake_case, e.g. 'github_poll_interval_seconds'. */
    key: text('key').notNull(),
    /**
     * `jsonValue`, not `jsonb` — see `columns.ts`. This is the one column in the schema that
     * legitimately stores a bare JSON **string**, and Drizzle's `jsonb()` parses such a value
     * a second time on read (`pg` has already parsed it), turning `"-1001234567890"` into a
     * number. That is not hypothetical: it is a Telegram chat id.
     */
    value: jsonValue('value').notNull(),
    valueType: text('value_type').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_settings_category', sql`${table.category} IN (${valueList(SETTINGS_CATEGORIES)})`),
    check('ck_settings_key_length', sql`length(${table.key}) BETWEEN 1 AND 128`),
    check('ck_settings_value_type', sql`${table.valueType} IN (${valueList(SETTING_VALUE_TYPES)})`),
    /** The declared type and the stored JSON type must agree — checked by the database. */
    check(
      'ck_settings_value_matches_type',
      sql`(${table.valueType} = 'string'  AND jsonb_typeof(${table.value}) = 'string')  OR
    (${table.valueType} = 'number'  AND jsonb_typeof(${table.value}) = 'number')  OR
    (${table.valueType} = 'boolean' AND jsonb_typeof(${table.value}) = 'boolean') OR
    (${table.valueType} = 'object'  AND jsonb_typeof(${table.value}) = 'object')  OR
    (${table.valueType} = 'array'   AND jsonb_typeof(${table.value}) = 'array')`,
    ),
    /** Reads are by `(category, key)` or whole-category — this index covers both. */
    uniqueIndex('ux_settings_category_key').on(table.category, table.key),
  ],
);

/**
 * Secrets stored separately from `settings` so plaintext can never leak through the settings
 * read path, encrypted with AES-256-GCM under the `MC_ENCRYPTION_KEY` KEK (F8.2, PRD §10).
 *
 * Storage contract (TDS 03 §3.13): `ciphertext` is the GCM ciphertext with the 16-byte auth
 * tag appended; `nonce` is a 12-byte IV, unique per encryption operation; the AAD is the
 * UTF-8 string `"{category}/{key}"` (a convention, not a column); `key_version` supports KEK
 * rotation as a job, not a migration.
 */
export const secretItems = pgTable(
  'secret_items',
  {
    id: primaryKeyId(),
    category: text('category').notNull(),
    /** e.g. 'github_token', 'telegram_bot_token'. */
    key: text('key').notNull(),
    /** GCM ciphertext || 16-byte auth tag. */
    ciphertext: bytea('ciphertext').notNull(),
    /** 12-byte random IV. */
    nonce: bytea('nonce').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'ck_secret_items_category',
      sql`${table.category} IN (${valueList(SETTINGS_CATEGORIES)})`,
    ),
    check('ck_secret_items_key_length', sql`length(${table.key}) BETWEEN 1 AND 128`),
    check('ck_secret_items_ciphertext', sql`octet_length(${table.ciphertext}) > 16`),
    check('ck_secret_items_nonce', sql`octet_length(${table.nonce}) = 12`),
    check('ck_secret_items_key_version', sql`${table.keyVersion} >= 1`),
    uniqueIndex('ux_secret_items_category_key').on(table.category, table.key),
  ],
);
