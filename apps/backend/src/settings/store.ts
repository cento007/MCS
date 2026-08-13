import type { Buffer } from 'node:buffer';
import {
  type DbTransaction,
  newId,
  type SettingsCategory,
  type SettingValueType,
  schema,
} from '@mc/shared';
import { and, eq } from 'drizzle-orm';
import type { DbLike } from './values.js';

/**
 * Every `settings` and `secret_items` write, in one module (TDS 03 §3.12–§3.13).
 *
 * Writes take a transaction handle rather than the pool: a category replace touches several
 * rows, two tables, an audit row and a queue job, and either all of that commits or none of it
 * does. The reads live in `values.ts`.
 */

export interface UpsertSettingInput {
  readonly category: SettingsCategory;
  readonly key: string;
  readonly value: unknown;
  /** Must match `jsonb_typeof(value)` or `ck_settings_value_matches_type` rejects the row. */
  readonly valueType: SettingValueType;
}

/**
 * Insert or update one `settings` row.
 *
 * `updated_at` is set explicitly because Drizzle's `$onUpdate` only fires on `.update()`, not
 * on the `DO UPDATE` arm of an upsert — and `updated_at` on this table is what a later
 * "changed at" surface would read.
 */
export async function upsertSetting(tx: DbTransaction, input: UpsertSettingInput): Promise<void> {
  await tx
    .insert(schema.settings)
    .values({
      id: newId(),
      category: input.category,
      key: input.key,
      value: input.value,
      valueType: input.valueType,
    })
    .onConflictDoUpdate({
      target: [schema.settings.category, schema.settings.key],
      set: { value: input.value, valueType: input.valueType, updatedAt: new Date() },
    });
}

/**
 * Delete one `settings` row.
 *
 * This is how a `null` value is stored: `value_type` has no `null` member (`jsonb_typeof` of a
 * JSON null matches none of the five), so row-absence is the only representation PostgreSQL
 * admits for "`account` is not set" — and reads map absence back to the registry default,
 * which for those fields is `null`.
 */
export async function deleteSetting(
  tx: DbTransaction,
  category: SettingsCategory,
  key: string,
): Promise<void> {
  await tx
    .delete(schema.settings)
    .where(and(eq(schema.settings.category, category), eq(schema.settings.key, key)));
}

export interface UpsertSecretInput {
  readonly category: SettingsCategory;
  readonly key: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyVersion: number;
}

/** Insert or replace one sealed secret. Returns the row id, for the audit entry. */
export async function upsertSecret(tx: DbTransaction, input: UpsertSecretInput): Promise<string> {
  const rows = await tx
    .insert(schema.secretItems)
    .values({
      id: newId(),
      category: input.category,
      key: input.key,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      keyVersion: input.keyVersion,
    })
    .onConflictDoUpdate({
      target: [schema.secretItems.category, schema.secretItems.key],
      set: {
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        keyVersion: input.keyVersion,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.secretItems.id });

  // `RETURNING` on an upsert always yields the surviving row.
  return rows[0]?.id ?? input.key;
}

export async function deleteSecret(
  tx: DbTransaction,
  category: SettingsCategory,
  key: string,
): Promise<void> {
  await tx
    .delete(schema.secretItems)
    .where(and(eq(schema.secretItems.category, category), eq(schema.secretItems.key, key)));
}

export interface StoredSecretRow {
  readonly id: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyVersion: number;
}

/**
 * Read one sealed secret.
 *
 * The only caller is the Test Connection path, through `SecretVault.open`. It returns
 * ciphertext, which is inert without the KEK — but it is still the narrowest possible read:
 * one `(category, key)`, never a whole category, never a join.
 */
export async function findSecretRow(
  db: DbLike,
  category: SettingsCategory,
  key: string,
): Promise<StoredSecretRow | null> {
  const rows = await db
    .select({
      id: schema.secretItems.id,
      ciphertext: schema.secretItems.ciphertext,
      nonce: schema.secretItems.nonce,
      keyVersion: schema.secretItems.keyVersion,
    })
    .from(schema.secretItems)
    .where(and(eq(schema.secretItems.category, category), eq(schema.secretItems.key, key)))
    .limit(1);

  return rows[0] ?? null;
}
