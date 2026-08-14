import { describe, expect, it } from 'vitest';
import { checkResponse, conformanceModeFromEnv } from './response-conformance.js';
import {
  arrayOf,
  booleanValue,
  entityId,
  inlineObject,
  integerValue,
  nullable,
  nullableString,
  objectSchema,
  openObject,
  stringEnum,
  stringValue,
} from './response-schema.js';

/**
 * The conformance checker is the runtime half of the anti-drift argument, so it gets the same
 * scrutiny as the thing it guards: if it silently passed a dropped field, every response schema in
 * the Backend would be unverified and the document would be confidently wrong.
 *
 * The two directions that matter are the first two tests. Everything else is the checker refusing
 * to be vague.
 */

const resource = objectSchema(
  'Widget',
  {
    id: entityId,
    name: stringValue,
    count: integerValue,
    note: nullableString,
    kind: stringEnum(['a', 'b']),
    tags: arrayOf(stringValue),
    nested: inlineObject({ flag: booleanValue }),
    optionalThing: stringValue,
    payload: openObject,
    child: nullable(objectSchema('WidgetChild', { at: stringValue })),
  },
  { optional: ['optionalThing'] },
);

const valid = {
  id: 'x',
  name: 'n',
  count: 1,
  note: null,
  kind: 'a',
  tags: ['t'],
  nested: { flag: true },
  payload: { anything: 1, else: { deep: true } },
  child: null,
};

describe('checkResponse', () => {
  it('accepts a payload that matches', () => {
    expect(checkResponse({ ...valid, optionalThing: 's' }, resource)).toEqual([]);
  });

  it('reports a property the response carries and the schema does not declare', () => {
    // THE test. This is the field `fast-json-stringify` would have deleted in production without
    // an error, a log line or a failing assertion — the exact failure mode `Session.agentId` had.
    const issues = checkResponse({ ...valid, optionalThing: 's', agentId: 'a' }, resource);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('agentId');
    expect(issues[0]?.message).toContain('undeclared property');
  });

  it('reports a property the schema requires and the response omits', () => {
    const { name: _dropped, ...withoutName } = { ...valid, optionalThing: 's' };
    const issues = checkResponse(withoutName, resource);
    expect(issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'name: missing required property',
    ]);
  });

  it('treats an explicit `undefined` as missing, because JSON.stringify drops it', () => {
    const issues = checkResponse({ ...valid, optionalThing: undefined, name: undefined }, resource);
    expect(issues.map((issue) => issue.path)).toEqual(['name']);
  });

  it('reports every issue rather than the first', () => {
    const issues = checkResponse(
      { ...valid, optionalThing: 's', count: 'not a number', extra: 1, another: 2 },
      resource,
    );
    expect(issues.map((issue) => issue.path).sort()).toEqual(['another', 'count', 'extra']);
  });

  it('checks values against an enum, not only their type', () => {
    const issues = checkResponse({ ...valid, optionalThing: 's', kind: 'c' }, resource);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('"c" is not one of');
  });

  it('descends into arrays and nested objects, naming the path', () => {
    const issues = checkResponse(
      {
        ...valid,
        optionalThing: 's',
        tags: ['ok', 7],
        nested: { flag: true, sneaky: 1 },
        child: { at: 'now', extra: true },
      },
      resource,
    );
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      'child.extra',
      'nested.sneaky',
      'tags[1]',
    ]);
  });

  it('admits null wherever the type union does, and only there', () => {
    expect(checkResponse({ ...valid, optionalThing: 's', child: null }, resource)).toEqual([]);
    const issues = checkResponse({ ...valid, optionalThing: 's', name: null }, resource);
    expect(issues[0]?.message).toBe('expected string, got null');
  });

  it('leaves a genuinely open object open', () => {
    expect(checkResponse({ ...valid, optionalThing: 's', payload: { a: 1 } }, resource)).toEqual(
      [],
    );
  });

  it('accepts an integer where a number is declared, and not the reverse', () => {
    expect(checkResponse(1, { type: 'number' })).toEqual([]);
    expect(checkResponse(1.5, { type: 'number' })).toEqual([]);
    expect(checkResponse(1.5, { type: 'integer' })[0]?.message).toBe(
      'expected integer, got number',
    );
  });

  it('refuses a keyword it does not implement rather than ignoring it', () => {
    // A schema keyword that silently does nothing is the defect this whole module exists to
    // prevent, so an unimplemented one is an error in the schema, not a shrug.
    const issues = checkResponse('x', { type: 'string', minLength: 5 });
    expect(issues[0]?.message).toContain('minLength');
  });

  it('stops descending once the type is wrong, so one fault is not reported as ten', () => {
    const issues = checkResponse('a string', resource);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('expected object, got string');
  });
});

describe('conformanceModeFromEnv', () => {
  it('is on under NODE_ENV=test, which is what Vitest sets', () => {
    expect(conformanceModeFromEnv({ NODE_ENV: 'test' })).toBe('on');
  });

  it('is off in production, so a schema bug cannot 500 the operator’s dashboard', () => {
    expect(conformanceModeFromEnv({ NODE_ENV: 'production' })).toBe('off');
    expect(conformanceModeFromEnv({ NODE_ENV: 'development' })).toBe('off');
    expect(conformanceModeFromEnv({})).toBe('off');
  });

  it('lets the env override in both directions', () => {
    expect(conformanceModeFromEnv({ NODE_ENV: 'production', MC_VALIDATE_RESPONSES: 'on' })).toBe(
      'on',
    );
    expect(conformanceModeFromEnv({ NODE_ENV: 'test', MC_VALIDATE_RESPONSES: 'off' })).toBe('off');
  });
});
