import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { buildQueryNodeCount, buildSearchQuery } from './query.js';
import { SEARCH_TYPES, type SearchType } from './types.js';

/**
 * The §4.6 statement, inspected without a database.
 *
 * `PgDialect.sqlToQuery` is the same renderer the driver uses, so this asserts the SQL that
 * *will* run — specifically the two properties that are structural rather than behavioural:
 * `?types=` prunes branches (so an unrequested table is not scanned), and every value that came
 * from the request is a bind parameter rather than text spliced into the statement. What the
 * query *finds* is `search.int.test.ts`'s job; PostgreSQL is the only honest authority on that.
 */

const dialect = new PgDialect();

function render(
  types: readonly SearchType[],
  cursor?: Parameters<typeof buildSearchQuery>[0]['cursor'],
) {
  return dialect.sqlToQuery(
    buildSearchQuery({ q: 'retry budget', types, limit: 20, ...(cursor ? { cursor } : {}) }),
  );
}

/** Table names as they appear in rendered SQL. */
const TABLE_OF: Readonly<Record<SearchType, string>> = {
  session: '"sessions"',
  adr: '"adrs"',
  commit: '"commits"',
  message: '"messages"',
  pull_request: '"pull_requests"',
};

describe('buildSearchQuery — branch pruning', () => {
  it('emits all five branches by default', () => {
    const { sql } = render(SEARCH_TYPES);

    expect(sql.match(/UNION ALL/g)).toHaveLength(4);
    for (const type of SEARCH_TYPES) expect(sql, type).toContain(TABLE_OF[type]);
  });

  it('emits only the requested branch, and does not scan the others', () => {
    for (const type of SEARCH_TYPES) {
      const { sql } = render([type]);

      expect(sql, type).not.toContain('UNION ALL');
      expect(sql, type).toContain(`'${type}'::text AS type`);

      for (const other of SEARCH_TYPES) {
        // `message` joins `sessions` and `commit`/`pull_request` join `repositories`, so
        // "the table is absent" is only assertable for tables nothing else needs.
        if (other === type || other === 'session') continue;
        expect(sql, `${type} must not scan ${other}`).not.toContain(TABLE_OF[other]);
      }
    }
  });

  it('gives every branch its own column aliases, because any branch can come first', () => {
    // PostgreSQL takes a UNION's column names from the first branch. `?types=` decides which
    // branch that is, so a branch that relied on another one's aliases would break the `page`
    // CTE's `ORDER BY rank` for exactly the type subsets nobody tested.
    for (const type of SEARCH_TYPES) {
      const { sql } = render([type]);

      for (const alias of [
        'AS type',
        'AS id',
        'AS title',
        'AS occurred_at',
        'AS rank',
        'AS source',
        'AS project_id',
        'AS repository_id',
        'AS session_id',
      ]) {
        expect(sql, `${type} / ${alias}`).toContain(alias);
      }
    }
  });

  it('refuses to build a query over no branches', () => {
    expect(() => render([])).toThrow(/at least one search type/);
  });
});

describe('buildSearchQuery — shape', () => {
  it('binds the query text rather than splicing it into the statement', () => {
    const { sql, params } = render(SEARCH_TYPES);

    expect(params).toContain('retry budget');
    expect(sql).not.toContain('retry budget');
  });

  it('ranks every branch with the normalization flag that makes them comparable', () => {
    const { sql } = render(SEARCH_TYPES);

    // Flag 32 = rank/(rank+1), mapping every branch into (0,1). Without it the five branches
    // are on incomparable scales and the merged ordering is meaningless (§4.6, §11).
    expect(sql.match(/ts_rank_cd\([^)]*q\.query, 32\)/g)).toHaveLength(5);
  });

  it('highlights outside the LIMIT, so only the page is re-parsed', () => {
    const { sql } = render(SEARCH_TYPES);

    const limit = sql.indexOf('LIMIT');
    const headline = sql.indexOf('ts_headline');

    expect(limit).toBeGreaterThan(-1);
    expect(headline).toBeGreaterThan(limit);
  });

  it('guards the highlight input at 100000 characters, as §4.6 guards the tsvector', () => {
    expect(render(SEARCH_TYPES).sql).toContain('left(page.source,');
    expect(render(SEARCH_TYPES).params).toContain(100_000);
  });

  it('orders by the full composite key at both levels', () => {
    const { sql } = render(SEARCH_TYPES);

    expect(sql).toContain('ORDER BY hits.rank DESC, hits.occurred_at DESC, hits.id DESC');
    // Repeated on the outer select: the `page` CTE's order is not preserved through the join
    // with `q`, so without this the page arrives shuffled.
    expect(sql).toContain('ORDER BY page.rank DESC, page.occurred_at DESC, page.id DESC');
  });

  it('has no keyset predicate on the first page', () => {
    expect(render(SEARCH_TYPES).sql).toContain('WHERE TRUE');
  });

  it('compares the cursor rank as `real`, matching ts_rank_cd’s own type', () => {
    const { sql, params } = render(SEARCH_TYPES, {
      rankKey: '0.06079271',
      occurredAt: new Date('2026-08-12T10:00:00.000Z'),
      id: '0198f6b2-0000-7000-8000-000000000001',
    });

    expect(sql).toContain('::real');
    expect(sql).toContain('::timestamptz');
    expect(sql).toContain('::uuid');
    expect(params).toContain('0.06079271');
    // All three parts of the key are compared — rank alone collides constantly.
    expect(sql).toContain('hits.occurred_at <');
    expect(sql).toContain('hits.id <');
  });
});

describe('buildQueryNodeCount', () => {
  it('asks PostgreSQL for the parsed size of the query, with the text bound', () => {
    const { sql, params } = dialect.sqlToQuery(buildQueryNodeCount('retry budget'));

    expect(sql).toContain('numnode(websearch_to_tsquery(');
    expect(params).toContain('retry budget');
  });
});
