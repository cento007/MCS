/**
 * Notification row → Telegram message text. Pure.
 *
 * **HTML parse mode, not MarkdownV2.** Telegram's MarkdownV2 requires escaping eighteen
 * characters (`_*[]()~`>#+-=|{}.!`) anywhere in the text, and every one of those appears
 * routinely in the strings we send: session titles, Windows paths, git branch names, error
 * sentences. One missed escape is a `400 Bad Request: can't parse entities` — a delivery
 * failure caused entirely by formatting. HTML mode needs exactly three characters escaped, and
 * that is small enough to get right and to test exhaustively.
 *
 * **The worker never re-words a Notification.** `title` and `body` are pre-rendered by the
 * producer and shared with the UI (TDS 04 §8); this module adds transport formatting — a bold
 * title, a blank line, escaping — and nothing else. A channel that paraphrases is a channel
 * that can disagree with the record an operator is looking at.
 */

/** Telegram's own limit for `sendMessage.text`. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * The title is capped *before* the message is assembled, so the closing `</b>` can never be
 * the thing truncation removes — an unclosed tag is a `400`, and it would be caused by a
 * session title long enough to fill the whole message.
 */
export const TELEGRAM_MAX_TITLE_LENGTH = 200;

/** Room for the truncation marker inside the limit. */
const TRUNCATION_MARKER = '\n…';

/** The three characters HTML parse mode reserves. Order matters: `&` first. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface FormattableNotification {
  readonly title: string;
  readonly body: string;
}

/**
 * `<b>title</b>` then the body, escaped.
 *
 * Truncation is on the **escaped** string and is deliberately conservative: cutting an escaped
 * entity in half (`&amp` without its `;`) is another `400`, so the cut point is walked back to
 * the last character that cannot be inside one.
 */
export function formatNotificationMessage(notification: FormattableNotification): string {
  const title = `<b>${truncate(escapeHtml(notification.title), TELEGRAM_MAX_TITLE_LENGTH)}</b>`;
  const body = escapeHtml(notification.body);
  const text = body.length === 0 ? title : `${title}\n\n${body}`;

  return truncate(text, TELEGRAM_MAX_MESSAGE_LENGTH);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  let cut = limit - TRUNCATION_MARKER.length;
  // Never end inside an HTML entity: back off past a trailing partial `&…`.
  const tail = text.slice(Math.max(0, cut - 8), cut);
  const openEntity = tail.lastIndexOf('&');
  if (openEntity !== -1 && !tail.slice(openEntity).includes(';')) {
    cut -= tail.length - openEntity;
  }

  return `${text.slice(0, Math.max(0, cut))}${TRUNCATION_MARKER}`;
}
