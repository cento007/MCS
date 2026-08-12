import { Fragment, type ReactNode } from 'react';

/**
 * Assistant-message rendering (TDS 05 §6.4).
 *
 * > "markdown rendering with fenced-code syntax highlighting; the streaming buffer renders
 * > through the same markdown pipeline with an **incomplete-markdown-tolerant parse**
 * > (dangling fences render as open code blocks rather than flashing)."
 *
 * The tolerance is the requirement, not the feature list. A token stream passes through every
 * intermediate state of every construct: ` ``` `, then ` ```ts `, then a half-written line.
 * A conventional parser re-lexes that as prose until the closing fence arrives, so the block
 * flips between "paragraph" and "code" on nearly every frame — a strobing panel over the
 * product's primary output surface. Here an unterminated fence simply stays a code block.
 *
 * Deliberately small and dependency-free: fenced code, inline code, headings, list items,
 * block quotes, emphasis and links. There is **no syntax colouring** — that needs a
 * highlighter WS4 does not name, and the component boundary below is where one drops in
 * later without touching a call site.
 */

export type MarkdownNode =
  | {
      readonly type: 'code';
      readonly language: string | null;
      readonly text: string;
      readonly open: boolean;
    }
  | { readonly type: 'heading'; readonly level: number; readonly text: string }
  | { readonly type: 'list-item'; readonly ordered: boolean; readonly text: string }
  | { readonly type: 'quote'; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Block-level parse. Never throws and never rejects input — a stream is always half-written. */
export function parseMarkdown(source: string): readonly MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const lines = source.split('\n');

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n').trim();
    if (text.length > 0) nodes.push({ type: 'paragraph', text });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] as string;
    const fence = FENCE.exec(line);

    if (fence !== null) {
      flushParagraph();
      const language = (fence[1] ?? '').trim();
      const body: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        const candidate = lines[index] as string;
        if (FENCE.test(candidate)) {
          closed = true;
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      nodes.push({
        type: 'code',
        language: language.length > 0 ? language : null,
        text: body.join('\n'),
        // `open` is what the renderer uses to keep an unterminated block visually stable.
        open: !closed,
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      nodes.push({ type: 'heading', level: (heading[1] as string).length, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushParagraph();
      nodes.push({ type: 'list-item', ordered: false, text: bullet[1] ?? '' });
      index += 1;
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      flushParagraph();
      nodes.push({ type: 'list-item', ordered: true, text: ordered[1] ?? '' });
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      nodes.push({ type: 'quote', text: quote[1] ?? '' });
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return nodes;
}

export type InlineToken =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong'; readonly text: string }
  | { readonly type: 'em'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly href: string };

const INLINE = /(`[^`]*`?)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/;

/**
 * Inline parse. An unterminated backtick run still becomes code (`` `const x = ``) for the
 * same reason as an unterminated fence: mid-token flicker is worse than a slightly early
 * commitment to a style.
 */
export function parseInline(source: string): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = source;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (match === null || match.index === undefined) break;

    if (match.index > 0) tokens.push({ type: 'text', text: rest.slice(0, match.index) });
    const raw = match[0];

    if (raw.startsWith('`')) {
      tokens.push({ type: 'code', text: raw.replace(/^`|`$/g, '') });
    } else if (raw.startsWith('**')) {
      tokens.push({ type: 'strong', text: raw.slice(2, -2) });
    } else if (raw.startsWith('*')) {
      tokens.push({ type: 'em', text: raw.slice(1, -1) });
    } else {
      const split = raw.indexOf('](');
      tokens.push({
        type: 'link',
        text: raw.slice(1, split),
        href: raw.slice(split + 2, -1),
      });
    }

    rest = rest.slice(match.index + raw.length);
  }

  if (rest.length > 0) tokens.push({ type: 'text', text: rest });
  return tokens;
}

export function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, index) => (
        // The token list is a pure function of `text` and is re-derived in full on every
        // change, so position IS the identity — there is nothing to preserve across a reorder
        // because a reorder is a different string and therefore a different list.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional identity in a fully re-derived list
        <InlineToken key={`${token.type}-${index}-${token.text.slice(0, 12)}`} token={token} />
      ))}
    </>
  );
}

function InlineToken({ token }: { token: InlineToken }): ReactNode {
  switch (token.type) {
    case 'code':
      return (
        <code
          className="rounded-xs px-1 font-mono text-xs"
          style={{ backgroundColor: 'var(--color-surface-inset)' }}
        >
          {token.text}
        </code>
      );
    case 'strong':
      return <strong className="font-medium">{token.text}</strong>;
    case 'em':
      return <em>{token.text}</em>;
    case 'link':
      // Rendered as a link but not navigable in V1: agent output is untrusted text, and a
      // live anchor to a model-authored URL in an operator console is an invitation.
      return (
        <span className="underline decoration-dotted underline-offset-2" title={token.href}>
          {token.text}
        </span>
      );
    default:
      return <>{token.text}</>;
  }
}

/** The one component every assistant surface renders through — committed and streaming alike. */
export function Markdown({ source }: { source: string }) {
  const nodes = parseMarkdown(source);

  return (
    <div className="flex flex-col gap-2 text-sm text-text leading-150">
      {nodes.map((node, index) => (
        // Positional identity again, and here it is load-bearing for streaming: block N of a
        // growing document stays block N as tokens arrive, so React patches text in place
        // instead of remounting the tail of the transcript on every frame.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional identity in a fully re-derived list
        <Fragment key={`${node.type}-${index}`}>
          <MarkdownBlock node={node} />
        </Fragment>
      ))}
    </div>
  );
}

function MarkdownBlock({ node }: { node: MarkdownNode }): ReactNode {
  switch (node.type) {
    case 'code':
      return (
        <pre
          data-open={node.open ? 'true' : undefined}
          className="overflow-x-auto rounded-sm p-3 font-mono text-xs leading-145"
          style={{ backgroundColor: 'var(--color-surface-inset)' }}
        >
          {node.language === null ? null : (
            <span className="mb-1 block text-2xs text-text-muted">{node.language}</span>
          )}
          <code>{node.text}</code>
        </pre>
      );

    case 'heading':
      return (
        <p
          className="font-medium text-text"
          style={{ fontSize: node.level <= 2 ? 'var(--text-md)' : 'var(--text-sm)' }}
        >
          <InlineMarkdown text={node.text} />
        </p>
      );

    case 'list-item':
      return (
        <p className="flex gap-2 pl-2">
          <span aria-hidden="true" className="text-text-muted">
            {node.ordered ? '·' : '•'}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            <InlineMarkdown text={node.text} />
          </span>
        </p>
      );

    case 'quote':
      return (
        <p className="border-border-strong border-l-2 pl-3 text-text-secondary">
          <InlineMarkdown text={node.text} />
        </p>
      );

    default:
      return (
        <p className="whitespace-pre-wrap break-words">
          <InlineMarkdown text={node.text} />
        </p>
      );
  }
}
