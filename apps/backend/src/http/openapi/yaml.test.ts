import { describe, expect, it } from 'vitest';
import { toYaml } from './yaml.js';

/**
 * The YAML writer (`yaml.ts`).
 *
 * These assert *bytes*, not shapes, because byte stability is the property the staleness check
 * is built on: `pnpm api:spec:check` compares the committed document to a freshly generated
 * one character for character, so a change in quoting or indentation here would read as "every
 * route changed".
 *
 * The quoting cases are the ones a naive emitter gets wrong — a string that YAML would read
 * back as a boolean, a number, `null`, or a comment.
 */

describe('toYaml', () => {
  it('emits a nested document with two-space indentation and one trailing newline', () => {
    const yaml = toYaml({
      openapi: '3.1.0',
      // A plain path key stays unquoted; one carrying a `{param}` cannot, because braces are
      // YAML's flow-mapping indicators.
      paths: { '/sessions': { get: { operationId: 'getSessions' } }, '/sessions/{id}': {} },
    });

    expect(yaml).toBe(
      [
        "openapi: '3.1.0'",
        'paths:',
        '  /sessions:',
        '    get:',
        '      operationId: getSessions',
        "  '/sessions/{id}': {}",
        '',
      ].join('\n'),
    );
  });

  it('quotes anything YAML would read back as something other than a string', () => {
    const yaml = toYaml({
      version: '1.0.0',
      truthy: 'yes',
      nullish: 'null',
      comment: '#/components/schemas/ErrorEnvelope',
      apostrophe: "it's",
      empty: '',
      // A path and a `$ref` key are the two things this document is mostly made of; both stay
      // plain, because neither leads with a YAML indicator.
      $ref: '/api/v1',
    });

    expect(yaml).toBe(
      [
        "version: '1.0.0'",
        "truthy: 'yes'",
        "nullish: 'null'",
        "comment: '#/components/schemas/ErrorEnvelope'",
        "apostrophe: 'it''s'",
        "empty: ''",
        '$ref: /api/v1',
        '',
      ].join('\n'),
    );
  });

  it('writes a multi-line string as a block scalar', () => {
    expect(toYaml({ description: 'first\n\nthird' })).toBe(
      ['description: |-', '  first', '', '  third', ''].join('\n'),
    );
  });

  it('keeps empty collections in flow form — YAML has no block spelling for them', () => {
    expect(toYaml({ security: [], components: {} })).toBe('security: []\ncomponents: {}\n');
  });

  it('starts an object inside a sequence on the dash line', () => {
    expect(
      toYaml({
        parameters: [
          { name: 'id', in: 'path' },
          { name: 'limit', in: 'query' },
        ],
      }),
    ).toBe(
      ['parameters:', '  - name: id', '    in: path', '  - name: limit', '    in: query', ''].join(
        '\n',
      ),
    );
  });

  it('renders the JSON Schema nullable union without turning null into a string', () => {
    // `type: ['string', 'null']` is how every nullable field in the route schemas is spelled.
    expect(toYaml({ type: ['string', 'null'] })).toBe("type:\n  - string\n  - 'null'\n");
  });

  it('refuses a number YAML cannot carry rather than emitting something unreadable', () => {
    expect(() => toYaml({ n: Number.POSITIVE_INFINITY })).toThrow(/cannot carry/);
    expect(() => toYaml({ n: Number.NaN })).toThrow(/cannot carry/);
  });

  it('keeps an exponent-form number a number', () => {
    // JavaScript prints 1e21 as `1e+21`, which YAML 1.1 reads back as a *string*.
    expect(toYaml({ big: 1e21 })).toBe('big: 1.0e+21\n');
  });
});
