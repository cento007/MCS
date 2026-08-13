import { describe, expect, it } from 'vitest';
import {
  HEADLINE_OPTIONS,
  HEADLINE_START_SENTINEL,
  HEADLINE_STOP_SENTINEL,
  SNIPPET_MAX_CHARS,
  toSnippet,
} from './highlight.js';

/**
 * Snippet safety (TDS 04 §11's `<mark>` promise, TDS 03 §4.6's `ts_headline`).
 *
 * The invariant every case here exists to defend: **`<mark>` and `</mark>` are the only markup a
 * snippet can contain.** A client has to render this string as HTML — that is what a highlight
 * *is* — so anything else that survives is executable in the operator's browser. `ts_headline`
 * copies the source document verbatim and escapes nothing, and the source documents include
 * commit messages, PR descriptions and assistant Message text.
 *
 * No database: the substitution is a pure function over what PostgreSQL returns, and these
 * fixtures are that output.
 */

/** What PostgreSQL emits: source text, with the private sentinels wrapped around matches. */
function headline(...parts: string[]): string {
  return parts.join('');
}

function mark(word: string): string {
  return `${HEADLINE_START_SENTINEL}${word}${HEADLINE_STOP_SENTINEL}`;
}

describe('HEADLINE_OPTIONS', () => {
  it('carries §4.6’s fragment bounds and the sentinels rather than raw tags', () => {
    expect(HEADLINE_OPTIONS).toContain('MaxFragments=2');
    expect(HEADLINE_OPTIONS).toContain('MinWords=5');
    expect(HEADLINE_OPTIONS).toContain('MaxWords=18');
    expect(HEADLINE_OPTIONS).toContain(`StartSel=${HEADLINE_START_SENTINEL}`);
    expect(HEADLINE_OPTIONS).toContain(`StopSel=${HEADLINE_STOP_SENTINEL}`);
    // The raw tag must never be handed to PostgreSQL: once it is in the string, a `<` from the
    // corpus is indistinguishable from a `<` PostgreSQL wrote.
    expect(HEADLINE_OPTIONS).not.toContain('StartSel=<mark>');
  });
});

describe('toSnippet', () => {
  it('turns the sentinels into `<mark>` — the markup §11 promises', () => {
    expect(toSnippet(headline('retry the ', mark('budget'), ' before failing'))).toBe(
      'retry the <mark>budget</mark> before failing',
    );
  });

  it('escapes HTML that came from the corpus', () => {
    const snippet = toSnippet(headline('a <script>alert(1)</script> ', mark('note')));

    expect(snippet).toBe('a &lt;script&gt;alert(1)&lt;/script&gt; <mark>note</mark>');
    expect(snippet).not.toContain('<script>');
  });

  it('escapes attribute-breaking characters, not just angle brackets', () => {
    // `<img src=x onerror=...>` is the obvious one; `"` and `'` matter because a client may
    // interpolate a snippet into an attribute, and `&` matters because escaping it late
    // double-escapes everything else.
    expect(toSnippet(`he said "don't" & <b>left</b>`)).toBe(
      'he said &quot;don&#39;t&quot; &amp; &lt;b&gt;left&lt;/b&gt;',
    );
  });

  it('leaves nothing but `<mark>` tags in the output, for a `q` full of HTML', () => {
    // The search term itself is HTML here, so the highlighted span is the dangerous one.
    const snippet = toSnippet(
      headline('config ', mark('<img src=x onerror="alert(1)">'), ' was rejected'),
    );

    expect(snippet).toBe(
      'config <mark>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</mark> was rejected',
    );
    expect(snippet.replaceAll('<mark>', '').replaceAll('</mark>', '')).not.toMatch(/[<>]/);
  });

  it('cannot be tricked into emitting a tag by corpus text that mimics escaped markup', () => {
    // `&lt;script&gt;` in the source must survive as visible text, not decay into a tag: that
    // only works because `&` is escaped first.
    expect(toSnippet('literally &lt;script&gt;')).toBe('literally &amp;lt;script&amp;gt;');
  });

  it('degrades to a stray `<mark>` — never to markup — if the corpus contains the sentinel', () => {
    const snippet = toSnippet(`a ${HEADLINE_START_SENTINEL} in the source`);

    expect(snippet).toBe('a <mark> in the source');
    expect(snippet).not.toContain('<script');
  });

  it('passes short headlines through untouched', () => {
    expect(toSnippet('nothing matched here')).toBe('nothing matched here');
  });
});

describe('toSnippet — bounds', () => {
  it('caps a snippet whose single “word” is enormous', () => {
    // `MaxWords=18` bounds words, not characters: one base64 blob in an assistant Message is a
    // single token, and without a character cap it lands in the response whole.
    const snippet = toSnippet('x'.repeat(SNIPPET_MAX_CHARS * 10));

    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 4);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('closes a highlight the cut left open', () => {
    const snippet = toSnippet(`${HEADLINE_START_SENTINEL}${'y'.repeat(SNIPPET_MAX_CHARS * 2)}`);

    expect(snippet.startsWith('<mark>')).toBe(true);
    expect(snippet).toContain('</mark>');
    expect((snippet.match(/<mark>/g) ?? []).length).toBe((snippet.match(/<\/mark>/g) ?? []).length);
  });

  it('does not leave half a sentinel in the output', () => {
    // Position the cut so the slice ends inside `<<<mc-hl>>>`.
    const prefix = 'z'.repeat(SNIPPET_MAX_CHARS - 4);
    const snippet = toSnippet(`${prefix}${mark('term')}${'z'.repeat(SNIPPET_MAX_CHARS)}`);

    expect(snippet).not.toContain('&lt;');
    expect(snippet).not.toContain('mc-hl');
  });
});
