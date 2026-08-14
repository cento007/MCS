import type { YamlValue } from './yaml.js';

/**
 * `components.schemas` -> TypeScript declarations for the SPA.
 *
 * ## Why a hand-rolled emitter rather than `openapi-typescript`
 *
 * The same three reasons `build.ts` gives for not using `@fastify/swagger`, plus one that is
 * specific to the consumer. `openapi-typescript` emits a `paths`/`components` tree whose types are
 * reached as `components['schemas']['Session']`; every import site in the SPA would have to change,
 * and the resulting names are not the ones the codebase already speaks. This emits
 * `export interface Session` — the exact names `apps/frontend/src/lib/api/types.ts` has always
 * exported — so replacing the hand-written file with a generated one moves nothing else.
 *
 * It also keeps the repository's first-five-minutes property intact (`pnpm install && pnpm test`
 * with no extra tooling), which `yaml.ts` and `build.ts` were both written to preserve.
 *
 * ## The subset
 *
 * Exactly what `http/response-schema.ts` can express, and nothing more: `$ref`, the
 * `anyOf: [{ $ref }, { type: 'null' }]` nullable form the hoister produces, `type` (scalar and
 * union), `enum`, `properties`/`required`/`additionalProperties`, and `items`. An unrecognised
 * construct throws rather than degrading to `unknown` — a generated type that silently widens to
 * `unknown` is the same class of quiet lie this whole exercise exists to remove.
 */

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Emitted from \`openapi.yaml\`'s components by \`pnpm api:types\`, which builds the Backend's route
 * table and reads the response schemas the routes declare. \`pnpm api:types:check\` fails when this
 * file and those routes disagree, exactly as \`pnpm api:spec:check\` does for the document itself.
 *
 * **This file exists because a hand-written copy was wrong twice while typechecking cleanly.**
 * \`ServiceHealthRow.status\` once read \`'ok' | … | 'not_configured'\` against an API answering
 * \`'healthy' | 'disabled'\`; \`Repository.lastSyncError\` was omitted entirely; and \`Session.agentId\`
 * — added to the Backend's serializer in Phase 4 slice 1 — never reached the client type, which
 * made the whole agent runtime binding unreachable from the browser until slice 2 noticed.
 *
 * The prose that used to live here now lives next to the schemas these types are generated from
 * (\`apps/backend/src/<domain>/response-schemas.ts\`), which is the only place it cannot drift from
 * shape it describes. Field-level notes that survived the move are the \`description\` keyword on
 * those schemas and are reproduced below.
 *
 * Types that are still hand-written, and why, are in \`./types.ts\` — the seam is marked there.
 */
`;

interface Schema {
  readonly [keyword: string]: unknown;
}

export function renderApiTypes(document: YamlValue): string {
  const components = (document as { components?: { schemas?: Record<string, Schema> } }).components;
  const schemas = components?.schemas ?? {};

  const blocks = Object.keys(schemas)
    .sort()
    .map((name) => declaration(name, schemas[name] as Schema));

  return `${HEADER}\n${blocks.join('\n\n')}\n`;
}

function declaration(name: string, schema: Schema): string {
  const doc = jsdoc(schema['description'], '');

  if (Array.isArray(schema['enum'])) {
    const inline = literalUnion(schema['enum']);
    // Long vocabularies (the error-code registry, the notification types) are unreadable on one
    // line and produce a useless diff when a value is added; short ones read better inline.
    return inline.length <= 80
      ? `${doc}export type ${name} = ${inline};`
      : `${doc}export type ${name} =\n${schema['enum'].map((value) => `  | ${literal(value)}`).join('\n')};`;
  }

  if (isObjectSchema(schema)) {
    return `${doc}export interface ${name} ${objectBody(schema, '')}`;
  }

  return `${doc}export type ${name} = ${typeOf(schema)};`;
}

function objectBody(schema: Schema, indent: string): string {
  const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  const inner = `${indent}  `;

  const lines: string[] = [];
  for (const [property, child] of Object.entries(properties)) {
    const doc = jsdoc(child['description'], inner);
    if (doc.length > 0) lines.push(doc.replace(/\n$/, ''));
    const optional = required.has(property) ? '' : '?';
    lines.push(`${inner}readonly ${key(property)}${optional}: ${typeOf(child, inner)};`);
  }

  // An open object with named properties still admits anything else; say so rather than
  // publishing a closed type for a payload the server may extend (`MessageContentBlock`).
  if (schema['additionalProperties'] !== false) {
    lines.push(`${inner}readonly [key: string]: unknown;`);
  }

  return `{\n${lines.join('\n')}\n${indent}}`;
}

function typeOf(schema: Schema, indent = ''): string {
  const reference = schema['$ref'];
  if (typeof reference === 'string') return referenceName(reference);

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    return anyOf.map((branch) => typeOf(branch as Schema, indent)).join(' | ');
  }

  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'];
    const union = literalUnion(values);
    // `nullable()` puts `null` in the enum as well as in the type union, so appending it here
    // again would emit `'a' | 'b' | null | null`.
    return nullableTypes(schema).includes('null') && !values.includes(null)
      ? `${union} | null`
      : union;
  }

  const types = nullableTypes(schema);
  if (types.length === 0) {
    throw new Error(
      `Cannot generate a TypeScript type for ${JSON.stringify(schema)} — no \`type\`, \`$ref\`, ` +
        '`enum` or `anyOf`. Response schemas must be explicit (see http/response-schema.ts).',
    );
  }

  return types.map((type) => scalarType(type, schema, indent)).join(' | ');
}

function scalarType(type: string, schema: Schema, indent: string): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema['items'];
      if (!isSchema(items)) throw new Error('An array schema must declare `items`.');
      const element = typeOf(items, indent);
      // Parenthesise unions so `readonly (A | null)[]` cannot be read as `readonly A | (null[])`.
      return /[ |]/.test(element) ? `readonly (${element})[]` : `readonly ${element}[]`;
    }
    case 'object':
      return isObjectSchema(schema)
        ? objectBody(schema, indent)
        : schema['additionalProperties'] === false
          ? 'Record<string, never>'
          : 'Record<string, unknown>';
    default:
      throw new Error(`Unsupported JSON Schema type "${type}".`);
  }
}

function nullableTypes(schema: Schema): readonly string[] {
  const type = schema['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type as string[];
  return [];
}

function isObjectSchema(schema: Schema): boolean {
  return nullableTypes(schema).includes('object') && isSchema(schema['properties']);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function referenceName(reference: string): string {
  const name = reference.split('/').pop();
  if (name === undefined || name.length === 0) {
    throw new Error(`Unresolvable $ref "${reference}".`);
  }
  return name;
}

function literalUnion(values: readonly unknown[]): string {
  return values.map(literal).join(' | ');
}

/** Single-quoted to match the repository's formatter, which Biome would rewrite anyway. */
function literal(value: unknown): string {
  return typeof value === 'string' ? `'${value.replaceAll("'", "\\'")}'` : JSON.stringify(value);
}

/** A safe TypeScript property name, quoted only where it has to be. */
function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function jsdoc(description: unknown, indent: string): string {
  if (typeof description !== 'string' || description.length === 0) return '';
  // A `*/` inside a description closes the comment and takes the rest of the file with it — which
  // is exactly what a path glob in this module's own header did on the first run. Spaced rather
  // than escaped, because there is no escape inside a block comment.
  const lines = description.replaceAll('*/', '* /').split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join('\n')}\n${indent} */\n`;
}
