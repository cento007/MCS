import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseInline, parseMarkdown } from './markdown.js';

/**
 * §6.4's "incomplete-markdown-tolerant parse".
 *
 * The property being defended is stability under a token stream: an unterminated fence must
 * already be a code block, because the alternative is the transcript flipping between
 * "paragraph" and "code" on nearly every frame of the product's primary output surface.
 */

describe('parseMarkdown', () => {
  it('treats a dangling fence as an open code block rather than prose', () => {
    const nodes = parseMarkdown('Here we go\n```ts\nconst x = 1');
    expect(nodes[0]).toEqual({ type: 'paragraph', text: 'Here we go' });
    expect(nodes[1]).toEqual({ type: 'code', language: 'ts', text: 'const x = 1', open: true });
  });

  it('closes a completed fence', () => {
    const nodes = parseMarkdown('```\nbody\n```\nafter');
    expect(nodes[0]).toMatchObject({ type: 'code', text: 'body', open: false });
    expect(nodes[1]).toEqual({ type: 'paragraph', text: 'after' });
  });

  it('is stable across every prefix of a fenced block', () => {
    // Simulates the stream: at no point may the block stop being a code block once opened.
    const full = '```ts\nconst a = 1;\nconst b = 2;\n```';
    for (let length = 6; length <= full.length; length += 1) {
      const nodes = parseMarkdown(full.slice(0, length));
      expect(nodes.some((node) => node.type === 'code')).toBe(true);
    }
  });

  it('reads headings, list items and quotes', () => {
    const nodes = parseMarkdown('## Plan\n- first\n1. second\n> note');
    expect(nodes.map((node) => node.type)).toEqual(['heading', 'list-item', 'list-item', 'quote']);
    expect(nodes[0]).toMatchObject({ level: 2, text: 'Plan' });
    expect(nodes[2]).toMatchObject({ ordered: true, text: 'second' });
  });
});

describe('parseInline', () => {
  it('handles code, emphasis and links', () => {
    expect(parseInline('run `pnpm test` **now** [docs](http://x)')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'pnpm test' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'now' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'docs', href: 'http://x' },
    ]);
  });

  it('commits an unterminated backtick run to code, for the same anti-flicker reason', () => {
    expect(parseInline('use `const x =')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'const x =' },
    ]);
  });
});

describe('<Markdown>', () => {
  it('renders code blocks as preformatted regions', () => {
    render(<Markdown source={'intro\n```\ncode here\n```'} />);
    expect(screen.getByText('intro')).toBeInTheDocument();
    expect(screen.getByText('code here')).toBeInTheDocument();
  });

  it('does not render agent-authored links as navigable anchors', () => {
    render(<Markdown source="see [here](http://evil.example)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTitle('http://evil.example')).toBeInTheDocument();
  });
});
