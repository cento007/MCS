import { type Db, type DbTransaction, type SettingsCategory, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';

/**
 * The shared read half of `settings` / `secret_items` (TDS 03 §3.12–3.13), used by the settings
 * service and by the typed per-category readers beside this file.
 *
 * Two rules it exists to enforce:
 *
 *  1. **A stored row is untrusted input.** `settings.value` is `jsonb` with only a
 *     `value_type` CHECK behind it, so every read states a documented default and degrades to
 *     it rather than throwing. A corrupt row must not be able to 500 a read model. The
 *     defaults and the repair functions are the registry's (`@mc/shared` §7.6) — the coercion
 *     helpers re-exported here are the primitives it builds them from, kept importable under
 *     their original names because the readers beside this file were written against them.
 *  2. **A secret is never read here.** `readSecretKeys` returns the `(category, key)` names
 *     that exist — which is exactly the `{ isSet }` half of TDS 04 §7.1 — and nothing in this
 *     module can decrypt anything. Unsealing lives in `secrets.ts`, behind one caller.
 */

export {
  booleanValue,
  enumValue,
  integerValue,
  moneyValue,
  objectValue,
  stringListValue,
  stringValue,
  timeOfDayValue,
} from '@mc/shared';
export type { SettingsCategory };

/** Reads accept a transaction handle so a write can re-read its own effect before commit. */
export type DbLike = Db | DbTransaction;

/** Every `(key -> value)` in one category. One query; categories are tiny by construction. */
export async function readCategoryValues(
  db: DbLike,
  category: SettingsCategory,
): Promise<ReadonlyMap<string, unknown>> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.category, category));

  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * The secret keys present in one category — presence only, never ciphertext and never
 * plaintext. This is the storage-side answer to `SecretFieldRead.isSet`.
 */
export async function readSecretKeys(
  db: DbLike,
  category: SettingsCategory,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ key: schema.secretItems.key })
    .from(schema.secretItems)
    .where(eq(schema.secretItems.category, category));

  return new Set(rows.map((row) => row.key));
}

/** Every `settings` row in the database — the one-query source for `GET /settings` (§7.3). */
export async function readAllSettingRows(
  db: DbLike,
): Promise<readonly { category: string; key: string; value: unknown }[]> {
  return db
    .select({
      category: schema.settings.category,
      key: schema.settings.key,
      value: schema.settings.value,
    })
    .from(schema.settings);
}

/** Every `secret_items` row's coordinates and timestamps. Never ciphertext (see `store.ts`). */
export async function readAllSecretRows(
  db: DbLike,
): Promise<
  readonly { category: string; key: string; id: string; updatedAt: Date; keyVersion: number }[]
> {
  return db
    .select({
      category: schema.secretItems.category,
      key: schema.secretItems.key,
      id: schema.secretItems.id,
      updatedAt: schema.secretItems.updatedAt,
      keyVersion: schema.secretItems.keyVersion,
    })
    .from(schema.secretItems);
}

/** `secret_items` presence **and** its `updated_at` — the §7.1 read shape, arbitration A15. */
export interface SecretPresence {
  readonly id: string;
  readonly updatedAt: Date;
  readonly keyVersion: number;
}

export async function readSecretPresence(
  db: DbLike,
  category: SettingsCategory,
): Promise<ReadonlyMap<string, SecretPresence>> {
  const rows = await db
    .select({
      id: schema.secretItems.id,
      key: schema.secretItems.key,
      updatedAt: schema.secretItems.updatedAt,
      keyVersion: schema.secretItems.keyVersion,
    })
    .from(schema.secretItems)
    .where(eq(schema.secretItems.category, category));

  return new Map(
    rows.map((row) => [
      row.key,
      { id: row.id, updatedAt: row.updatedAt, keyVersion: row.keyVersion },
    ]),
  );
}
