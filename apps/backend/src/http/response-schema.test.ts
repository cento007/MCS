import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerResponseConformance } from './response-conformance.js';
import {
  arrayOf,
  dataEnvelopeSchema,
  entityId,
  integerValue,
  listEnvelopeSchema,
  nullable,
  nullableString,
  objectSchema,
  registerNonStrippingSerializer,
  stringValue,
} from './response-schema.js';

/**
 * **The load-bearing test of the whole response-schema change.**
 *
 * A Fastify response schema is a serializer. Left to `fast-json-stringify` it emits exactly the
 * properties the schema lists and *deletes the rest* — no error, no log line, no failing test
 * unless something asserts that precise field. That is the failure mode `Session.agentId` already
 * had on the client side, and declaring 100-odd response schemas carelessly would have moved it
 * server-side, where it silently removes data the code still computes.
 *
 * So the first test here is the one that matters: a route whose schema *omits* a field must still
 * return that field. Everything under it checks that the omission is nonetheless caught loudly
 * where it should be — in the tests.
 *
 * Fastify is driven directly rather than through `buildApp` so the property is demonstrated about
 * the mechanism itself, with no domain, no database and no auth guard in the way.
 */

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function build(options: { readonly conformance: boolean }): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerNonStrippingSerializer(instance);
  if (options.conformance) registerResponseConformance(instance, 'on');
  app = instance;
  return instance;
}

/** A schema that has fallen behind its handler: `agentId` is served and not declared. */
const staleSchema = dataEnvelopeSchema(
  objectSchema('StaleResource', { id: entityId, title: stringValue }),
);

const served = { id: 'session-1', title: 'Refactor the tailer', agentId: 'agent-7' };

describe('the declared response schemas cannot strip', () => {
  it('returns a field the schema does not declare, instead of deleting it', async () => {
    const instance = build({ conformance: false });
    instance.get('/stale', { schema: { response: { 200: staleSchema } } }, async () => ({
      data: served,
    }));
    await instance.ready();

    const response = await instance.inject({ method: 'GET', url: '/stale' });

    // With Fastify's default serializer this body would be `{"id":…,"title":…}` — `agentId` gone,
    // status 200, nothing anywhere to say so.
    expect(response.json()).toEqual({ data: served });
  });

  it('is byte-for-byte what a route with no response schema returns', async () => {
    const instance = build({ conformance: false });
    instance.get('/declared', { schema: { response: { 200: staleSchema } } }, async () => ({
      data: served,
    }));
    instance.get('/undeclared', async () => ({ data: served }));
    await instance.ready();

    const declared = await instance.inject({ method: 'GET', url: '/declared' });
    const undeclared = await instance.inject({ method: 'GET', url: '/undeclared' });

    // The property that makes installing this a no-op on the wire: before this change no route
    // declared a response schema, so every reply went through `JSON.stringify` — and every reply
    // still does.
    expect(declared.body).toBe(undeclared.body);
  });

  it('keeps values a stricter serializer would coerce', async () => {
    const instance = build({ conformance: false });
    const schema = dataEnvelopeSchema(
      objectSchema('Coerced', { count: integerValue, note: nullableString }),
    );
    instance.get('/coerce', { schema: { response: { 200: schema } } }, async () => ({
      data: { count: 3, note: null, extra: { nested: [1, 2] } },
    }));
    await instance.ready();

    expect((await instance.inject({ method: 'GET', url: '/coerce' })).json()).toEqual({
      data: { count: 3, note: null, extra: { nested: [1, 2] } },
    });
  });
});

describe('the conformance hook makes the same drift loud in the test tiers', () => {
  it('fails the request when the response carries an undeclared field', async () => {
    const instance = build({ conformance: true });
    instance.get('/stale', { schema: { response: { 200: staleSchema } } }, async () => ({
      data: served,
    }));
    await instance.ready();

    const response = await instance.inject({ method: 'GET', url: '/stale' });
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('agentId');
  });

  it('fails the request when the handler stops emitting a declared field', async () => {
    const instance = build({ conformance: true });
    instance.get('/thin', { schema: { response: { 200: staleSchema } } }, async () => ({
      data: { id: 'session-1' },
    }));
    await instance.ready();

    const response = await instance.inject({ method: 'GET', url: '/thin' });
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('title');
  });

  it('passes a response that matches, including a list envelope', async () => {
    const instance = build({ conformance: true });
    const item = objectSchema('Item', { id: entityId, tags: arrayOf(stringValue) });
    instance.get(
      '/list',
      { schema: { response: { 200: listEnvelopeSchema(item) } } },
      async () => ({
        data: [{ id: 'a', tags: [] }],
        meta: { nextCursor: null, limit: 50 },
      }),
    );
    await instance.ready();

    const response = await instance.inject({ method: 'GET', url: '/list' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{ id: 'a', tags: [] }],
      meta: { nextCursor: null, limit: 50 },
    });
  });

  it('applies the schema declared for the status the handler actually used', async () => {
    const instance = build({ conformance: true });
    const created = dataEnvelopeSchema(objectSchema('Created', { id: entityId }));
    const ok = dataEnvelopeSchema(objectSchema('Ok', { id: entityId, note: nullableString }));

    instance.post(
      '/two',
      { schema: { response: { 200: ok, 201: created } } },
      async (request, reply) => {
        if ((request.query as { new?: string }).new === '1') {
          reply.code(201);
          // Valid under 201 and invalid under 200 — if the wrong schema were applied, this
          // would fail with "note: missing required property".
          return { data: { id: 'a' } };
        }
        return { data: { id: 'a', note: null } };
      },
    );
    await instance.ready();

    expect((await instance.inject({ method: 'POST', url: '/two' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'POST', url: '/two?new=1' })).statusCode).toBe(201);
  });

  it('leaves a 204 alone — there is no payload to check', async () => {
    const instance = build({ conformance: true });
    instance.delete('/gone', async (_request, reply) => {
      reply.code(204);
      return null;
    });
    await instance.ready();

    const response = await instance.inject({ method: 'DELETE', url: '/gone' });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('ignores a route that declares nothing', async () => {
    const instance = build({ conformance: true });
    instance.get('/free', async () => ({ anything: true }));
    await instance.ready();

    expect((await instance.inject({ method: 'GET', url: '/free' })).statusCode).toBe(200);
  });
});

describe('nullable()', () => {
  it('adds null to a type union without losing the rest of the schema', () => {
    const schema = nullable(objectSchema('Thing', { id: entityId }));
    expect(schema['type']).toEqual(['object', 'null']);
    expect(schema.properties).toEqual({ id: entityId });
  });

  it('is idempotent', () => {
    expect(nullable(nullable(stringValue))['type']).toEqual(['string', 'null']);
  });
});
