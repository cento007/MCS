import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitle,
  MAX_DERIVED_TITLE_CODE_POINTS,
  normalizeOperatorTitle,
} from './title.js';

/**
 * TDS 04 §6.11.2, rule by rule, plus its own worked examples table.
 *
 * The derivation is deterministic string handling, so it is fully testable with no database
 * and no runtime — which is the property §6.11 relies on when it says the title must be
 * computable inside the message-insert transaction and identical on replay.
 */

const codePoints = (value: string): number => [...value].length;

describe('deriveSessionTitle — §6.11.2 worked examples', () => {
  it('takes a short single-line prompt verbatim', () => {
    expect(deriveSessionTitle('Refactor the queue port to batch enqueue')).toBe(
      'Refactor the queue port to batch enqueue',
    );
  });

  it('takes the first line only, never folding in later lines', () => {
    expect(deriveSessionTitle('Fix the TLS renewal\n\nIt fails on the nginx reload step.')).toBe(
      'Fix the TLS renewal',
    );
  });

  it('skips a leading code fence and titles from the first line of code', () => {
    expect(deriveSessionTitle('```ts\nexport function enqueue(job: Job) {\n  // …\n}')).toBe(
      'export function enqueue(job: Job) {',
    );
  });

  it('skips a bare fence with no info string, and `~~~` too', () => {
    expect(deriveSessionTitle('```\nSELECT 1;')).toBe('SELECT 1;');
    expect(deriveSessionTitle('~~~\nSELECT 1;')).toBe('SELECT 1;');
  });

  it('cuts a long line at the last space at or before code point 59 and ellipsises', () => {
    const prompt =
      'Investigate why the Sync Worker keeps rescheduling the same Obsidian export job forever';
    const title = deriveSessionTitle(prompt);

    expect(title).not.toBeNull();
    expect(title).toBe('Investigate why the Sync Worker keeps rescheduling the…');
    expect(codePoints(title as string)).toBeLessThanOrEqual(MAX_DERIVED_TITLE_CODE_POINTS);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('hard-cuts a long single token with no space at 59 code points', () => {
    const prompt = 'D:\\Repos\\MCS\\apps\\backend\\src\\sessions\\manager\\session-manager.ts';
    const title = deriveSessionTitle(prompt) as string;

    expect(codePoints(title)).toBe(MAX_DERIVED_TITLE_CODE_POINTS);
    expect(title).toBe(`${[...prompt].slice(0, 59).join('')}…`);
  });

  it('derives nothing from whitespace and a bare fence', () => {
    expect(deriveSessionTitle('   \n```\n   ')).toBeNull();
  });
});

describe('deriveSessionTitle — normalization', () => {
  it('normalizes CRLF and lone CR line endings', () => {
    expect(deriveSessionTitle('First line\r\nSecond')).toBe('First line');
    expect(deriveSessionTitle('First line\rSecond')).toBe('First line');
  });

  it('strips a leading BOM', () => {
    expect(deriveSessionTitle('\uFEFFRefactor the parser')).toBe('Refactor the parser');
  });

  it('collapses runs of space, tab and U+00A0 to one U+0020, then trims', () => {
    expect(deriveSessionTitle('  Refactor \t\u00A0 the   parser  ')).toBe('Refactor the parser');
  });

  it('drops C0 and C1 control characters', () => {
    expect(deriveSessionTitle('Refactor\u0007 the\u009F parser')).toBe('Refactor the parser');
  });

  it('returns null when the surviving line cleans down to nothing', () => {
    expect(deriveSessionTitle('')).toBeNull();
    expect(deriveSessionTitle('\u0000\u0001')).toBeNull();
  });
});

describe('deriveSessionTitle — length is counted in code points', () => {
  it('passes through a line of exactly 60 code points untouched', () => {
    const prompt = 'a'.repeat(60);
    expect(deriveSessionTitle(prompt)).toBe(prompt);
  });

  it('truncates a line of 61 code points', () => {
    const title = deriveSessionTitle('a'.repeat(61)) as string;
    expect(codePoints(title)).toBe(MAX_DERIVED_TITLE_CODE_POINTS);
  });

  it('never splits a surrogate pair', () => {
    // Each rocket is one code point but two UTF-16 units: a UTF-16-based cut would produce a
    // lone surrogate here, which is exactly what §6.11.2 forbids.
    const title = deriveSessionTitle('\u{1F680}'.repeat(70)) as string;

    expect(codePoints(title)).toBe(MAX_DERIVED_TITLE_CODE_POINTS);
    expect(title).toBe(`${'\u{1F680}'.repeat(59)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
  });

  it('is idempotent on its own output', () => {
    const once = deriveSessionTitle('a'.repeat(200)) as string;
    expect(deriveSessionTitle(once)).toBe(once);
  });
});

describe('normalizeOperatorTitle — §6.11.3 "unnamed has one storage representation"', () => {
  it('maps empty, whitespace-only, null and undefined to NULL', () => {
    expect(normalizeOperatorTitle('')).toBeNull();
    expect(normalizeOperatorTitle('   \t ')).toBeNull();
    expect(normalizeOperatorTitle(null)).toBeNull();
    expect(normalizeOperatorTitle(undefined)).toBeNull();
  });

  it('stores an operator title trimmed and verbatim, never ellipsised', () => {
    const long = 'x'.repeat(150);
    expect(normalizeOperatorTitle(`  Nightly refactor  `)).toBe('Nightly refactor');
    // The 60-code-point cap binds derived titles only (§6.11.2).
    expect(normalizeOperatorTitle(long)).toBe(long);
  });
});
