import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatNotificationMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  truncate,
} from './format.js';

describe('escapeHtml', () => {
  it('escapes exactly the three characters HTML parse mode reserves', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes the ampersand first, so an escape is never double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves everything MarkdownV2 would have required escaping alone', () => {
    // The whole reason HTML mode was chosen: these appear in session titles, Windows paths and
    // error sentences, and every one of them is a MarkdownV2 landmine.
    const text = 'D:\\Repos\\MCS — fix(queue): drop `retry_after` [#12] (100%)!';
    expect(escapeHtml(text)).toBe(text);
  });
});

describe('formatNotificationMessage', () => {
  it('bolds the title and keeps the pre-rendered body verbatim', () => {
    const message = formatNotificationMessage({
      title: 'Session completed — Refactor the queue port',
      body: 'Project: Mission Control\nCommits: 3',
    });

    expect(message).toBe(
      '<b>Session completed — Refactor the queue port</b>\n\nProject: Mission Control\nCommits: 3',
    );
  });

  it('escapes content that would otherwise be read as markup', () => {
    const message = formatNotificationMessage({
      title: 'Session failed — <script>',
      body: 'Reason: a < b && c > d',
    });

    expect(message).toContain('&lt;script&gt;');
    expect(message).toContain('a &lt; b &amp;&amp; c &gt; d');
    // The only tags in the output are the ones this module put there.
    expect(message.match(/<(?!\/?b>)/g)).toBeNull();
  });

  it('omits the blank line when the body is empty', () => {
    expect(formatNotificationMessage({ title: 'Daily report', body: '' })).toBe(
      '<b>Daily report</b>',
    );
  });

  it("stays inside Telegram's 4096-character limit", () => {
    const message = formatNotificationMessage({
      title: 'Session failed',
      body: 'x'.repeat(10_000),
    });

    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(message.endsWith('…')).toBe(true);
    // The closing tag survives: an unclosed <b> is a 400.
    expect(message).toContain('</b>');
  });

  it('keeps the closing tag even when the title alone would fill the message', () => {
    const message = formatNotificationMessage({ title: 'T'.repeat(9_000), body: 'body' });

    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(message).toContain('</b>');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('never cuts an HTML entity in half — that is a 400 from Telegram', () => {
    // The limit is chosen so a naive cut would land inside `&amp;`.
    const text = `${'x'.repeat(20)}&amp;${'y'.repeat(20)}`;
    const cut = truncate(text, 24);

    expect(cut.endsWith('…')).toBe(true);
    const body = cut.slice(0, -1);
    // Any `&` left in the output is followed by its `;`.
    for (const index of indicesOf(body, '&')) {
      expect(body.slice(index).includes(';')).toBe(true);
    }
  });
});

function indicesOf(text: string, character: string): number[] {
  const found: number[] = [];
  for (
    let index = text.indexOf(character);
    index !== -1;
    index = text.indexOf(character, index + 1)
  ) {
    found.push(index);
  }
  return found;
}
