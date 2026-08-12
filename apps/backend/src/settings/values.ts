import { type Db, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';

/**
 * The shared read half of `settings` / `secret_items` (TDS 03 §3.12–3.13), used by the typed
 * per-category readers beside this file.
 *
 * Two rules the coercion helpers exist to enforce:
 *
 *  1. **A stored row is untrusted input.** `settings.value` is `jsonb` with only a
 *     value_type CHECK behind it, so every read states a documented default and degrades to it
 *     rather than throwing. A corrupt row must not be able to 500 a read model.
 *  2. **A secret is never read here.** `readSecretKeys` returns the `(category, key)` names
 *     that exist — which is exactly the `{ isSet: boolean }` semantics of TDS 04 §7.1 — and
 *     nothing in this module can decrypt anything.
 *
 * SCOPE NOTE: same boundary as `security.ts` and `claude-code.ts` — this is NOT the settings
 * service (TDS 04 §7.3) and NOT the key registry (§7.6, owned by WS2 in
 * `packages/shared/src/settings/registry.ts`). It is the set of typed reads the Phase 1 read
 * models need, using the §7.6 derivation rule for storage coordinates so nothing moves when
 * the registry lands.
 */

/** WS3 `settings.category` CHECK (TDS 03 §3.12). */
export type SettingsCategory =
  | 'general'
  | 'integrations'
  | 'notifications'
  | 'memory'
  | 'agents'
  | 'security';

/** Every `(key -> value)` in one category. One query; categories are tiny by construction. */
export async function readCategoryValues(
  db: Db,
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
 * plaintext. This is the storage-side answer to `SecretFieldRead = { isSet: boolean }`.
 */
export async function readSecretKeys(
  db: Db,
  category: SettingsCategory,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ key: schema.secretItems.key })
    .from(schema.secretItems)
    .where(eq(schema.secretItems.category, category));

  return new Set(rows.map((row) => row.key));
}

// ------------------------------------------------------------------------- coercion helpers

export function stringValue(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/** A finite number, floored to an integer, clamped to `[min, max]`; anything else is `fallback`. */
export function integerValue(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer < bounds.min || integer > bounds.max) return fallback;
  return integer;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A JSONB object row read whole (§7.6 rule 1). Arrays and scalars are not objects. */
export function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** One member of a closed value set, or the documented default. */
export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** `"HH:mm"` on a 24-hour clock (TDS 04 §7.2 `dailyReport.time`, `quietHours`). */
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function timeOfDayValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && HH_MM.test(value) ? value : fallback;
}

/**
 * A non-negative money amount, or `null`.
 *
 * `null` is a real value here and means "no budget configured" (TDS 04 §7.8), which is a
 * different statement from `0`; a negative or non-finite stored value is corrupt and reads as
 * "unset" rather than as a budget nobody can satisfy.
 */
export function moneyValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}
