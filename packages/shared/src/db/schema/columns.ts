/**
 * Shared column builders and SQL helpers for the Drizzle schema.
 *
 * Every rule below is TDS 03 §1 ("Conventions Applied", per F4.2) expressed once so no
 * table restates it:
 *   - IDs are `uuid` holding UUIDv7 generated in application code — no DB-side default,
 *     the application is the single ID authority.
 *   - Timestamps are `timestamptz` only, UTC. Every table carries `created_at` and
 *     `updated_at`; lifecycle moments get dedicated nullable columns.
 *   - `updated_at` is app-managed via `$onUpdate` (TDS 03 §1.1 — no DB triggers). The
 *     DB-level `DEFAULT now()` covers inserts made with manual SQL.
 */

import { type SQL, sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `uuid PRIMARY KEY` with **no** default — UUIDv7 is generated in application code
 * (`uuid` npm, v7). PostgreSQL 17 has no `uuidv7()` and adding one would create a second
 * ID authority (TDS 03 §1).
 */
export const primaryKeyId = () => uuid('id').primaryKey();

/** `timestamptz`, UTC (F4.2). Nullable by default — lifecycle moments opt into `notNull`. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** `created_at timestamptz NOT NULL DEFAULT now()` — on every table (F4.2). */
export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

/**
 * `updated_at timestamptz NOT NULL DEFAULT now()`, maintained by the application on every
 * update (TDS 03 §1.1). Accepted trade-off: ad-hoc `UPDATE`s issued outside Drizzle must
 * set `updated_at = now()` themselves.
 */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * `bytea`. Only `secret_items` uses it: AES-256-GCM ciphertext and nonce (TDS 03 §3.13).
 * `pg` maps `bytea` to `Buffer` in both directions, so no conversion is needed.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * `tsvector`. Every occurrence is a **stored generated column** named `search_tsv`
 * (TDS 03 §4.6) — PostgreSQL maintains it, so the value is read-only from the app's
 * point of view and is never written by Drizzle.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * `jsonb` that holds an arbitrary JSON **value**, including a bare JSON string.
 *
 * Drizzle's own `jsonb()` cannot be used for such a column, and the reason is a genuine
 * double-parse rather than a preference:
 *
 *   1. `pg` already runs `JSON.parse` on a `jsonb` result, so a stored `"-1001234567890"`
 *      arrives as the JavaScript string `'-1001234567890'`;
 *   2. Drizzle's `jsonb.mapFromDriverValue` then sees a string and parses it **again**,
 *      producing the number `-1001234567890`.
 *
 * For an object or an array the second parse is a no-op (the value is no longer a string by
 * then), which is why every other `jsonb` column in this schema is unaffected and why the
 * fault stayed invisible. It bites exactly where the stored value is a JSON string whose
 * contents are themselves valid JSON — and `integrations.telegram.chatId` is precisely that:
 * a Telegram chat id looks like `-1001234567890`. Read back as a number it failed
 * `stringValue()`, degraded to the registry default `null`, and every Notification was
 * recorded `skipped` with "No Telegram chat ID is saved" while one plainly was.
 *
 * `toDriver` keeps Drizzle's write behaviour verbatim (`JSON.stringify`, sent as text — this
 * half was always correct); `fromDriver` returns what `pg` already parsed. The emitted DDL is
 * identical, so this is not a migration.
 */
export const jsonValue = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value: unknown): unknown {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown): unknown {
    return value;
  },
});

/**
 * Renders a closed value set as the body of a SQL `IN (...)` list.
 *
 * Enum-like values are lowercase `snake_case` `text` with `CHECK` constraints rather than
 * PostgreSQL `ENUM` types (TDS 03 §1). This helper lets a CHECK be driven from the
 * TypeScript vocabulary that already exists in `src/entities/` instead of re-typing the
 * strings — F9.5 vocabulary discipline.
 */
export function valueList(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}
