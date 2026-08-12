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
