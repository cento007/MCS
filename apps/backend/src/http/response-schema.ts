/**
 * Response schemas — the F5.4 envelopes, the JSON-Schema fragments the routes declare for what
 * they *return*, and the two guards that keep those declarations honest.
 *
 * ## The trap this module is built around
 *
 * A Fastify response schema is a **serializer**, not a validator. `fast-json-stringify` emits
 * exactly the properties the schema lists and silently drops everything else — so a schema that
 * forgets one field turns "the API stopped returning `agentId`" into a change with no error, no
 * log line and no failing test unless something asserts that precise field. This codebase has
 * been bitten twice by the request-side twin of that behaviour (`removeAdditional` dropping an
 * unknown query parameter so a filter read as no filter; a stripped `scopes` field turning a typo
 * into a full-access token), and a careless response-schema pass would be strictly worse than the
 * documentation gap it closes.
 *
 * So the declarations here **cannot** strip, by construction:
 *
 *  1. `registerNonStrippingSerializer` (below) replaces Fastify's serializer compiler with one
 *     that ignores the schema and calls `JSON.stringify`. That is byte-for-byte what this Backend
 *     already did before any response schema existed — no route declared one, so every reply went
 *     through the default `JSON.stringify` — which makes installing it a **no-op on the wire** and
 *     makes every schema added afterwards inert at runtime.
 *  2. `response-conformance.ts` then validates the payload against the same schema in the test
 *     tiers, where a mismatch is a loud failure rather than a silent edit. Undeclared property,
 *     missing required property, wrong type, value outside an `enum` — all four are errors, in
 *     both directions.
 *  3. `ExactShape` (below) binds a schema's property names to the serializer's own TypeScript
 *     resource type at **compile time**, so a field added to `SessionResource` without being added
 *     here does not typecheck.
 *
 * The honest trade, stated plainly: the response schemas are documentation the tests enforce, not
 * a runtime filter. Nothing about a reply changes in production. What changes is that
 * `openapi.yaml` can state the success payloads, and `apps/frontend/src/lib/api/types.ts` can be
 * generated from them instead of transcribed from prose.
 *
 * ## The JSON-Schema subset
 *
 * `type` (including the `['string', 'null']` union form), `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`, `title`, `description`. Nothing else — the
 * conformance checker rejects an unknown keyword rather than ignoring it, so a typo in a schema
 * is a failing test and not a rule that quietly does nothing. Value bounds (`minLength`,
 * `minimum`, `pattern`) are deliberately absent: they belong on *requests*, where Ajv enforces
 * them, and on a response they would assert facts about data the server already produced.
 *
 * ## `title` is the type name
 *
 * A schema carrying `title` is hoisted into `components.schemas` by the OpenAPI builder and
 * becomes a named `export interface` in the generated client types. Two schemas may share a title
 * only if they are identical; the builder throws otherwise, because a `Session` that means two
 * things is worse than no `Session` at all.
 */

import type { FastifyInstance } from 'fastify';

// --------------------------------------------------------------------------------- primitives

/** A JSON-Schema fragment. Deliberately loose — it is data, not a type (cf. the key registry). */
export type ResponseSchema = Record<string, unknown>;

export const stringValue = { type: 'string' } as const;
export const nullableString = { type: ['string', 'null'] } as const;
export const numberValue = { type: 'number' } as const;
export const nullableNumber = { type: ['number', 'null'] } as const;
export const integerValue = { type: 'integer' } as const;
export const nullableInteger = { type: ['integer', 'null'] } as const;
export const booleanValue = { type: 'boolean' } as const;

/**
 * An ISO 8601 instant (F4.3 — every timestamp on the wire is UTC ISO).
 *
 * Typed as a bare string rather than `format: 'date-time'`: Fastify's Ajv ships no format
 * vocabulary, so the keyword would validate nothing on the request side and the conformance
 * checker would have to grow a rule that exists nowhere else. `auth/routes.ts` makes the same
 * call for the same reason — a validation rule that looks present and does nothing is worse than
 * none.
 */
export const timestampValue = { type: 'string' } as const;
export const nullableTimestamp = { type: ['string', 'null'] } as const;

/** A UUIDv7 entity id (F4.2). Pattern-checked on the way *in*; a plain string on the way out. */
export const entityId = { type: 'string' } as const;
export const nullableEntityId = { type: ['string', 'null'] } as const;

/**
 * A genuinely open object — `Notification.payload`, `AuditLogEntry.before`, a probe's `meta`.
 *
 * `additionalProperties: true` is the *point* here, not laziness: these carry entity ids and
 * per-source extras whose shape varies by row, and a closed schema would be a promise the data
 * cannot keep.
 */
export const openObject = { type: 'object', additionalProperties: true } as const;
export const nullableOpenObject = { type: ['object', 'null'], additionalProperties: true } as const;

// ----------------------------------------------------------------------------------- builders

interface ObjectOptions<P> {
  /** Property names that may be absent. Everything else is `required`. */
  readonly optional?: readonly (keyof P & string)[];
  readonly description?: string;
}

/**
 * A **type alias**, not an interface, and that is load-bearing: TypeScript gives an implicit
 * index signature to object *type aliases* and not to interfaces, so this stays assignable to
 * `ResponseSchema` (`Record<string, unknown>`). As an interface it was not, which silently
 * widened every `objectSchema(...)` call's inferred property map to `Record<string, ResponseSchema>`
 * — and that in turn made `ExactShape` compare against `string` and pass everything.
 */
export type ObjectSchema<P> = {
  readonly title: string;
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: P;
  readonly description?: string;
};

/**
 * A closed object schema with a name.
 *
 * `additionalProperties: false` and an exhaustive `required` are what make the conformance check
 * two-sided: a property the serializer emits and the schema does not declare fails as
 * "undeclared", and a property the schema declares and the serializer stopped emitting fails as
 * "missing". Either direction is drift, and neither is allowed to pass quietly.
 */
export function objectSchema<P extends Record<string, ResponseSchema>>(
  title: string,
  properties: P,
  options: ObjectOptions<P> = {},
): ObjectSchema<P> {
  const optional = new Set<string>(options.optional ?? []);
  return {
    title,
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((name) => !optional.has(name)),
    properties,
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}

/** An anonymous closed object — inlined in the document and in the generated types. */
export function inlineObject<P extends Record<string, ResponseSchema>>(
  properties: P,
  options: Omit<ObjectOptions<P>, 'description'> = {},
): {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: P;
} {
  const optional = new Set<string>(options.optional ?? []);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((name) => !optional.has(name)),
    properties,
  };
}

/** A named string enum — becomes `export type X = 'a' | 'b'` in the generated types. */
export function enumSchema(
  title: string,
  values: readonly string[],
  description?: string,
): ResponseSchema {
  return {
    title,
    type: 'string',
    enum: [...values],
    ...(description === undefined ? {} : { description }),
  };
}

/** An anonymous string enum. */
export function stringEnum(values: readonly string[]): ResponseSchema {
  return { type: 'string', enum: [...values] };
}

export function arrayOf(items: ResponseSchema): ResponseSchema {
  return { type: 'array', items };
}

/**
 * Attach a `description`, which the OpenAPI document publishes and the type generator turns into
 * JSDoc on the generated field.
 *
 * Used sparingly and on purpose: a field whose *meaning* a consumer can get wrong — an empty
 * string that is not "unset", a `null` that means "inherit", a string that is HTML — carries its
 * note across the generation boundary. Everything else is documented beside the schema, where the
 * prose sits next to the shape it describes and cannot drift from it.
 */
export function describe<S extends ResponseSchema>(
  schema: S,
  description: string,
): S & { readonly description: string } {
  return { ...schema, description };
}

/**
 * Admit `null` alongside whatever the schema already admits.
 *
 * Expressed as a `type` union rather than an `anyOf`, so the conformance checker stays a
 * single-branch walk. The OpenAPI builder translates a nullable *named* schema back into
 * `anyOf: [{ $ref }, { type: 'null' }]`, which is the 3.1 spelling and the one the type
 * generator reads.
 */
export function nullable<S extends ResponseSchema>(
  schema: S,
): Omit<S, 'type'> & { readonly type: readonly string[] } {
  const type = schema['type'];
  const types = Array.isArray(type) ? [...(type as string[])] : [type as string];
  if (!types.includes('null')) types.push('null');

  // `enum` has to grow too, and forgetting it is not a cosmetic slip: JSON Schema requires the
  // instance to be *in* the enum, so `{ type: ['string','null'], enum: ['manual','assisted'] }`
  // rejects `null` — the value it was widened to admit. The integration tier caught exactly that
  // on `Project.workflowMode`, `RepositoryStatus.unavailableReason`, `SessionFiles.
  // completenessReason` and the context package's `gapReason`, all of which are `null` in the
  // ordinary case. `projects/routes.ts` already spells its *request* schema `[...WORKFLOW_MODES,
  // null]` for the same reason.
  const values = schema['enum'];
  const enumeration =
    Array.isArray(values) && !values.includes(null) ? { enum: [...values, null] } : {};

  // `Omit<S, 'type'>` rather than `S & …`: the property map has to survive so `ExactShape` can
  // still see it through a nullable wrapper, and intersecting `'object'` with `string[]` would
  // collapse `type` to `never`.
  return { ...schema, ...enumeration, type: types };
}

// ---------------------------------------------------------------------------------- envelopes

/** F5.4 / TDS 04 §1.2 — `{ data: … }` for a single resource, an action result or a read model. */
export function dataEnvelopeSchema(data: ResponseSchema): ResponseSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data'],
    properties: { data },
  };
}

/** `{ data, meta }` where `meta` is action-specific — `POST /sessions/{id}/start` and friends. */
export function dataWithMetaSchema(data: ResponseSchema, meta: ResponseSchema): ResponseSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: { data, meta },
  };
}

/** F5.3 — the cursor-paginated list envelope. `meta` is identical on every list route. */
export function listEnvelopeSchema(item: ResponseSchema): ResponseSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: {
      data: arrayOf(item),
      meta: {
        // Not `ListMeta`: `apps/frontend/src/lib/api/client.ts` already exports an interface of
        // that name for the same shape, and two `export *` sources declaring one name would
        // silently remove it from the `lib/api` barrel.
        title: 'ListEnvelopeMeta',
        type: 'object',
        additionalProperties: false,
        required: ['nextCursor', 'limit'],
        properties: {
          /** Opaque base64 cursor (F5.3); `null` on the last page. */
          nextCursor: nullableString,
          limit: integerValue,
        },
      },
    },
  };
}

/**
 * A `204 No Content` reply.
 *
 * Declared rather than omitted so "this operation returns nothing" is a *statement* in the
 * document instead of the same silence an undeclared operation produces. The OpenAPI builder
 * recognises it by title and emits a `204` with no content; Fastify never sees a payload to
 * serialize, because `reply.code(204).send()` short-circuits before serialization.
 */
export const noContentSchema: ResponseSchema = { title: 'NoContent', type: 'null' };

// ------------------------------------------------------------------------ compile-time guard

/**
 * `Assert<ExactShape<Resource, typeof schema>>` — a type alias that fails to compile when a
 * schema's property names and its serializer's resource type have drifted apart.
 *
 * This is the guard aimed squarely at the defect that motivated the whole exercise: `agentId` was
 * added to `SessionResource` and never reached the hand-written client type, so an entire runtime
 * binding was unreachable from the browser for a slice. With the client types generated from
 * these schemas, the remaining way to lose a field is to add it to the serializer and forget the
 * schema — and that is exactly what this makes a compile error.
 *
 * It compares *names*, not types. A `string` that should have been a `number` is caught by the
 * conformance checker against real data instead; names are what silently vanish.
 */
export type Assert<T extends true> = T;

/**
 * `Assert<Covers<SomeUnion, typeof VALUES>>` — a compile error when a hand-written `enum` list and
 * the TypeScript union it mirrors disagree in either direction.
 *
 * Most vocabularies in this Backend are `as const` arrays in `@mc/shared` and are spread straight
 * into the schema, so they cannot drift. A handful are declared only as unions (`git.ts`'s
 * `WorkingTreeUnavailableReason`, `retrieval.ts`'s `EmptyReason`), and for those the list has to be
 * written out — this is what stops the written copy from quietly falling behind.
 */
export type Covers<Union extends string, Values extends readonly string[]> = [
  Exclude<Union, Values[number]>,
] extends [never]
  ? [Exclude<Values[number], Union>] extends [never]
    ? true
    : {
        readonly error: 'the enum lists values the union does not have';
        readonly extra: Exclude<Values[number], Union>;
      }
  : {
      readonly error: 'the union has values the enum does not list';
      readonly missing: Exclude<Union, Values[number]>;
    };

type SchemaKeys<S> = S extends { readonly properties: infer P } ? keyof P & string : never;

export type ExactShape<Resource, S> = [
  Exclude<keyof NonNullable<Resource> & string, SchemaKeys<S>>,
] extends [never]
  ? [Exclude<SchemaKeys<S>, keyof NonNullable<Resource> & string>] extends [never]
    ? true
    : {
        readonly error: 'the response schema declares fields the resource does not have';
        readonly extra: Exclude<SchemaKeys<S>, keyof NonNullable<Resource> & string>;
      }
  : {
      readonly error: 'the resource has fields the response schema does not declare';
      readonly missing: Exclude<keyof NonNullable<Resource> & string, SchemaKeys<S>>;
    };

// ------------------------------------------------------------------- the non-stripping serializer

/**
 * Replace Fastify's serializer compiler with one that cannot drop a field.
 *
 * Fastify only consults a serializer compiler for a status code that *has* a response schema;
 * everything else goes through `JSON.stringify` regardless. Before this change no route declared
 * one, so `JSON.stringify` was already the whole story — installing this keeps it that way while
 * the schemas start meaning something to the document and to the type generator.
 *
 * The alternative — letting `fast-json-stringify` serialize against the declared schema — is the
 * strictly more dangerous option and buys nothing here: it would enforce the schemas on a
 * single-operator home server at the cost of turning every schema mistake into silent data loss
 * in production. See this module's header for the full argument.
 */
export function registerNonStrippingSerializer(app: FastifyInstance): void {
  app.setSerializerCompiler(() => (data: unknown) => JSON.stringify(data));
}
