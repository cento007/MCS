import { describe, expect, it } from 'vitest';
import {
  blockquote,
  closeOpenFences,
  code,
  countControlCharacters,
  estimateTokens,
  fact,
  facts,
  fenced,
  sanitizeText,
} from './text.js';

/**
 * The three ways recorded text breaks a Markdown container, each tested on the value that
 * actually appears in a transcript rather than on a synthetic one.
 *
 * No database and no network: these are pure functions, and that is the point of them living
 * apart from `evidence.ts` (TDS 07 §2.1).
 */

const ESC = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);

describe('sanitizeText', () => {
  it('escapes ANSI escape sequences instead of dropping them', () => {
    // What a `Bash` tool result looks like when the command coloured its own output.
    const captured = `${ESC}[31merror${ESC}[0m: build failed`;

    const sanitized = sanitizeText(captured);

    expect(sanitized).toBe('<U+001B>[31merror<U+001B>[0m: build failed');
    // Escaped, not stripped: a reader can tell a coloured capture from a clean one.
    expect(sanitized).toContain('error');
    expect(sanitized).not.toContain(ESC);
  });

  it('escapes the other C0 controls and DEL, and leaves tab and newline alone', () => {
    expect(sanitizeText(`a${BELL}b`)).toBe('a<U+0007>b');
    expect(sanitizeText(`a${DEL}b`)).toBe('a<U+007F>b');
    expect(sanitizeText('a\tb\nc')).toBe('a\tb\nc');
  });

  it('collapses CRLF to LF but keeps a lone CR visible', () => {
    // CRLF is a line ending and becomes one. A bare CR is a progress bar rewriting its line,
    // which is a control character and must not silently vanish.
    expect(sanitizeText('a\r\nb')).toBe('a\nb');
    expect(sanitizeText('50%\r100%')).toBe('50%<U+000D>100%');
  });

  it('counts exactly what it would escape', () => {
    expect(countControlCharacters(`${ESC}[0m${BELL}`)).toBe(2);
    expect(countControlCharacters('a\r\nb\tc')).toBe(0);
    expect(countControlCharacters('nothing here')).toBe(0);
  });
});

describe('closeOpenFences', () => {
  it('leaves a balanced document untouched', () => {
    const balanced = 'Text\n\n```ts\nconst a = 1;\n```\n\nMore text';
    expect(closeOpenFences(balanced)).toEqual({ text: balanced, repaired: false });
  });

  it('closes a fence a message left open, and says it did', () => {
    const result = closeOpenFences('Here you go:\n\n```ts\nconst a = 1;');

    expect(result.repaired).toBe(true);
    expect(result.text).toBe('Here you go:\n\n```ts\nconst a = 1;\n```');
  });

  it('closes with the same marker and length the opener used', () => {
    // A four-backtick fence exists precisely so its body may contain three; closing it with
    // three would leave the block open and the repair would be worse than the injury.
    expect(closeOpenFences('````md\n```\ninner\n```').text).toBe('````md\n```\ninner\n```\n````');
    expect(closeOpenFences('~~~\nbody').text).toBe('~~~\nbody\n~~~');
  });

  it('does not treat a longer run inside an open block as a second opener', () => {
    const result = closeOpenFences('```\n````\n');
    expect(result.repaired).toBe(false);
  });

  it('ignores a closing candidate that carries an info string', () => {
    // CommonMark: a closing fence may not have an info string. `````ts` twice is two openers'
    // worth of intent and one of them is still open.
    const result = closeOpenFences('```ts\na\n```ts\nb');
    expect(result.repaired).toBe(true);
  });
});

describe('blockquote', () => {
  it('quotes blank lines too, so the quote cannot end early', () => {
    expect(blockquote('one\n\ntwo')).toBe('> one\n>\n> two');
  });

  it('neutralises front-matter delimiters and headings', () => {
    // `---` after a line of text is a setext H2; `## Files` would impersonate a section of the
    // document. Quoted, both are inert.
    const quoted = blockquote('Title\n---\n## Files touched');
    expect(quoted).toBe('> Title\n> ---\n> ## Files touched');
  });
});

describe('fenced and code', () => {
  it('picks a fence the content cannot terminate', () => {
    expect(fenced('```\nnested\n```')).toBe('````\n```\nnested\n```\n````');
  });

  it('pads inline code that starts or ends with a backtick', () => {
    expect(code('a')).toBe('`a`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`x`')).toBe('`` `x` ``');
  });
});

describe('fact / facts', () => {
  it('omits a bullet entirely rather than printing an empty value', () => {
    expect(fact('State', 'running')).toBe('- **State:** running');
    expect(fact('State', null)).toBeNull();
    expect(fact('State', '   ')).toBeNull();
  });

  it('joins only the bullets that had a value', () => {
    expect(facts([fact('A', '1'), fact('B', null), fact('C', '3')])).toBe('- **A:** 1\n- **C:** 3');
  });
});

describe('estimateTokens', () => {
  it('is bytes / 4, rounded up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4_000)).toBe(1_000);
  });
});
