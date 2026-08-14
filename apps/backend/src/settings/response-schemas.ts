import {
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  INTEGRATION_SLUGS,
  type IntegrationSlug,
  type SettingKeyEntry,
  settingsForCategory,
  settingsForIntegration,
  type TestConnectionResult,
} from '@mc/shared';
import {
  type Assert,
  booleanValue,
  type ExactShape,
  nullableNumber,
  nullableOpenObject,
  nullableTimestamp,
  objectSchema,
  type ResponseSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';

/**
 * The `/api/v1/settings/*` response shapes — **derived from the key registry, never restated**.
 *
 * §7.6 makes `packages/shared/src/settings/registry.ts` the single declaration of which fields
 * exist and what each one accepts, and it already carries a JSON Schema per field because that is
 * what validates a `PUT`. Hand-writing the read shapes beside it would create the second copy the
 * registry exists to prevent — and it would be the copy nobody updates when a setting is added.
 * So the read schema for a category *is* its write entries, transformed by two rules and nothing
 * else:
 *
 *  1. **A secret reads as `{ isSet, updatedAt }`** and never as a value (§7.1 / arbitration A15).
 *     `updatedAt` is the only honest confirmation possible for a write-only field.
 *  2. **Everything is `required` on a read.** A write may omit a field (that means "reset to
 *     default"); a read never does, because absence is resolved to the registry default before
 *     the document leaves the service.
 *
 * Request-side value bounds (`minLength`, `maximum`, `pattern`, `maxItems`) are stripped on the
 * way through. They are rules about what a caller may *send*; on a response they would assert
 * facts about data the server has already produced and normalised, and the conformance checker
 * deliberately implements no such keyword — see `http/response-conformance.ts`.
 *
 * A registry entry added tomorrow appears here, in `openapi.yaml` and in the generated client
 * types with no edit to this file. That is the whole point.
 */

/** The structural keywords a response schema may carry. Everything else is a request-side bound. */
const STRUCTURAL_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'title',
  'description',
]);

/**
 * Keep only the structural keywords, close every object, and make every declared property
 * required.
 *
 * Closing and requiring is what makes the conformance check two-sided at *every* level of a
 * settings document: a nested field the service emits and the registry does not declare fails as
 * undeclared, and a registry field the service stopped emitting fails as missing.
 */
function readShapeOf(schema: unknown): ResponseSchema {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return {};
  const source = schema as Record<string, unknown>;

  const result: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(source)) {
    if (!STRUCTURAL_KEYWORDS.has(keyword)) continue;
    if (keyword === 'properties') continue;
    if (keyword === 'items') {
      result['items'] = readShapeOf(value);
      continue;
    }
    result[keyword] = value;
  }

  const properties = source['properties'];
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    const mapped: Record<string, ResponseSchema> = {};
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      mapped[name] = readShapeOf(child);
    }
    result['properties'] = mapped;
    result['required'] = Object.keys(mapped);
    result['additionalProperties'] = false;
  }

  return result;
}

/**
 * §7.1's read shape for a write-only secret. Shared by every secret field, so it hoists into one
 * named component rather than six identical inline objects.
 */
const secretFieldSchema = objectSchema('SecretFieldRead', {
  isSet: booleanValue,
  /** `null` when the secret is not set. */
  updatedAt: nullableTimestamp,
});

function propertiesOf(entries: readonly SettingKeyEntry[]): Record<string, ResponseSchema> {
  const properties: Record<string, ResponseSchema> = {};
  for (const entry of entries) {
    properties[entry.field] = entry.secret ? secretFieldSchema : readShapeOf(entry.jsonSchema);
  }
  return properties;
}

/** `general` -> `GeneralSettings`; `claude-code` -> `ClaudeCodeSettings`. */
function titleOf(name: string, suffix = 'Settings'): string {
  return (
    name
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') + suffix
  );
}

export function settingsCategorySchema(category: DocumentCategory): ResponseSchema {
  return objectSchema(titleOf(category), propertiesOf(settingsForCategory(category)));
}

export function integrationSettingsSchema(slug: IntegrationSlug): ResponseSchema {
  return objectSchema(titleOf(slug), propertiesOf(settingsForIntegration(slug)));
}

/** `GET /settings/integrations` — all six, secrets masked. Keys are camelCase, paths kebab. */
export const integrationsSettingsSchema = objectSchema(
  'IntegrationsSettings',
  Object.fromEntries(
    INTEGRATION_SLUGS.map((slug) => [camelOf(slug), integrationSettingsSchema(slug)]),
  ) as Record<string, ResponseSchema>,
);

/** `GET /settings` — every category, masked. */
export const settingsDocumentSchema = objectSchema('SettingsDocument', {
  ...(Object.fromEntries(
    DOCUMENT_CATEGORIES.map((category) => [category, settingsCategorySchema(category)]),
  ) as Record<string, ResponseSchema>),
  integrations: integrationsSettingsSchema,
});

/**
 * §7.4 — a completed check is a `200` whatever the outcome; only a *refused request* is an error
 * envelope. `ok: false` with a message is a result, not a failure.
 */
export const testConnectionResultSchema = objectSchema('TestConnectionResult', {
  ok: booleanValue,
  checkedAt: timestampValue,
  latencyMs: nullableNumber,
  message: stringValue,
  detail: nullableOpenObject,
});
export type _TestConnectionResultShape = Assert<
  ExactShape<TestConnectionResult, typeof testConnectionResultSchema>
>;

/** `claude-code` -> `claudeCode`. The URL segment is kebab; the document key is camel (§7.3). */
function camelOf(slug: string): string {
  return slug.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
