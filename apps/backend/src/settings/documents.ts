import {
  type DocumentCategory,
  INTEGRATION_SLUGS,
  type IntegrationSlug,
  type IntegrationsSettings,
  integrationField,
  type SecretFieldRead,
  type SettingKeyEntry,
  settingsForCategory,
  settingsForIntegration,
  type ValueSettingKeyEntry,
} from '@mc/shared';
import { ApiError } from '../http/errors.js';
import type { SecretPresence } from './values.js';

/**
 * Category documents in and out (TDS 04 §7.1–§7.3) — pure, so every rule below is unit tested
 * with no database and no Fastify.
 *
 * ## Reading
 *
 * A document is built from the registry, not from the rows: **every field of the scope is
 * present in the answer**, taking its stored value when a row exists and its registry default
 * when it does not. A fresh install has zero rows and still serves a complete, correct
 * document — which is what lets the Settings page render real values on first boot instead of
 * a form full of blanks that look like configuration.
 *
 * Secrets are rendered as `{ isSet, updatedAt }` and **never as a value** (§7.1, A15).
 *
 * ## Writing — full-category replace (arbitration A14)
 *
 * TDS 04 §7.3 specifies "full-category replace" and TDS 05 §7.2 describes "sending only dirty
 * fields". Those are mutually exclusive and the API's semantics win, because a partial body
 * interpreted as a full replace silently erases every field the operator did not touch. So:
 *
 *   - an **omitted non-secret field resets to its registry default** — the body is the new
 *     state of the category, in full;
 *   - an **omitted secret keeps its stored value**, `null` clears it, a string sets it (§7.1).
 *     A client cannot resend a secret it is forbidden to read, so "omitted = reset" would make
 *     every save of an integration destroy its credential.
 */

export interface StoredCategory {
  /** `settings` rows for the category, keyed by DB key. */
  readonly values: ReadonlyMap<string, unknown>;
  /** `secret_items` presence for the category, keyed by DB key. Never a value. */
  readonly secrets: ReadonlyMap<string, SecretPresence>;
}

export const EMPTY_CATEGORY: StoredCategory = Object.freeze({
  values: new Map(),
  secrets: new Map(),
});

// ------------------------------------------------------------------------------------ reading

export function secretFieldRead(presence: SecretPresence | undefined): SecretFieldRead {
  return presence === undefined
    ? { isSet: false, updatedAt: null }
    : { isSet: true, updatedAt: presence.updatedAt.toISOString() };
}

/**
 * Build the API document for an arbitrary scope of registry entries.
 *
 * The `T` cast is the one place this module asserts that the registry and the §7.2 interfaces
 * describe the same fields. That assertion is checked, not assumed: `registry.test.ts` holds a
 * `Record<keyof GithubSettings, true>`-style manifest per document and compares it to the
 * registry's own field list, so a field added to either side without the other fails to
 * compile or fails the test.
 */
export function documentFor<T = Record<string, unknown>>(
  entries: readonly SettingKeyEntry[],
  stored: StoredCategory,
): T {
  const document: Record<string, unknown> = {};
  for (const entry of entries) {
    document[entry.field] = entry.secret
      ? secretFieldRead(stored.secrets.get(entry.key))
      : entry.normalize(stored.values.get(entry.key));
  }
  return document as T;
}

/** `GET /settings/{category}` for the five document categories (§7.3). */
export function categoryDocument<T = Record<string, unknown>>(
  category: DocumentCategory,
  stored: StoredCategory,
): T {
  return documentFor<T>(settingsForCategory(category), stored);
}

/** `GET /settings/integrations` — all six, secrets masked (§7.3). */
export function integrationsDocument(stored: StoredCategory): IntegrationsSettings {
  const document: Record<string, unknown> = {};
  for (const slug of INTEGRATION_SLUGS) {
    document[integrationField(slug)] = documentFor(settingsForIntegration(slug), stored);
  }
  return document as unknown as IntegrationsSettings;
}

/** One integration's sub-document — the body of a `PUT` response (§7.3). */
export function integrationDocument(
  slug: IntegrationSlug,
  stored: StoredCategory,
): Record<string, unknown> {
  return documentFor(settingsForIntegration(slug), stored);
}

// ------------------------------------------------------------------------------------ writing

/** What a `PUT` asks to happen to one secret. An omitted secret produces no instruction. */
export type SecretInstruction =
  | { readonly kind: 'set'; readonly plaintext: string }
  | { readonly kind: 'clear' };

export interface WritePlan {
  /** The desired value of **every** non-secret entry in scope — defaults included (A14). */
  readonly values: ReadonlyMap<
    string,
    { readonly entry: ValueSettingKeyEntry; readonly value: unknown }
  >;
  /** Only the secrets the body actually mentioned. */
  readonly secrets: ReadonlyMap<
    string,
    { readonly entry: SettingKeyEntry; readonly instruction: SecretInstruction }
  >;
}

/**
 * Turn a validated `PUT` body into the complete desired state of its scope.
 *
 * The body has already passed the registry's JSON Schema at the route boundary, so the type of
 * each *known* field is settled here — but every value still goes through `normalize`, because
 * schema validation and the reader's repair rules must agree on the stored form (a padded
 * path, a duplicated discovery root) or a value would read back differently from the way it
 * was written.
 *
 * **An unknown field is rejected, by name.** The schema cannot do it (see `writeSchemaFor`),
 * and silence would be dangerous rather than merely unhelpful: under full-replace semantics an
 * ignored `instanceNam` means `instanceName` was omitted, which means it resets to default.
 *
 * @throws {ApiError} `VALIDATION_FAILED` listing the fields this scope does not have.
 */
export function planWrite(entries: readonly SettingKeyEntry[], body: unknown): WritePlan {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const known = new Set(entries.map((entry) => entry.field));
  const unknown = Object.keys(input).filter((field) => !known.has(field));
  if (unknown.length > 0) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Unknown settings field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
      { unknownFields: unknown, knownFields: [...known] },
    );
  }

  const values = new Map<string, { entry: ValueSettingKeyEntry; value: unknown }>();
  const secrets = new Map<string, { entry: SettingKeyEntry; instruction: SecretInstruction }>();

  for (const entry of entries) {
    if (entry.secret) {
      // Omitted -> no instruction. This is the whole of the A14 exception, in one branch.
      if (!Object.hasOwn(input, entry.field)) continue;
      const written = input[entry.field];
      if (written === null || written === undefined) {
        secrets.set(entry.key, { entry, instruction: { kind: 'clear' } });
      } else if (typeof written === 'string' && written.length > 0) {
        secrets.set(entry.key, { entry, instruction: { kind: 'set', plaintext: written } });
      }
      continue;
    }

    const raw = Object.hasOwn(input, entry.field) ? input[entry.field] : entry.default;
    values.set(entry.key, { entry, value: entry.normalize(raw) });
  }

  return { values, secrets };
}

export function categoryWritePlan(category: DocumentCategory, body: unknown): WritePlan {
  return planWrite(settingsForCategory(category), body);
}

export function integrationWritePlan(slug: IntegrationSlug, body: unknown): WritePlan {
  return planWrite(settingsForIntegration(slug), body);
}

/**
 * Structural equality for two **normalized** settings values.
 *
 * `JSON.stringify` is sound here precisely because both sides come from the same
 * `normalize`, which builds objects field by field in a fixed order — so key order cannot
 * differ, and there is no `undefined`, no `Date` and no cycle to misrepresent. Comparing a
 * *raw stored* value this way would not be sound, and nothing does.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
