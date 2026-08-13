/**
 * Remove a secret from anything about to be shown, logged, stored or emitted.
 *
 * This is not defence in depth, it is the **primary** defence for Telegram: the Bot API is
 * addressed as `https://api.telegram.org/bot‹TOKEN›/sendMessage`, so the credential is *in the
 * URL* and therefore in any transport error that quotes it, in any `fetch` failure cause, and
 * in anything built from either. Every operator-facing string derived from a failed request
 * goes through here before it can reach a result, a log line, a `telegram_error` column, an
 * event payload or an audit row.
 *
 * It lives in `@mc/shared` because **two processes hold credentials that travel in a URL**: the
 * Backend (Test Connection, the GitHub client) and the Telegram Worker (every delivery). A
 * second copy in the worker would be a second thing to keep correct, and the failure mode of
 * getting it wrong is a bot token in a log file.
 *
 * Short values are ignored on purpose: redacting a 3-character "secret" would blank out
 * ordinary words and make an error message useless while protecting nothing that could be a
 * real credential.
 */

/** Below this length a value is not treated as a redactable secret. */
export const MIN_REDACTABLE_SECRET_LENGTH = 4;

export const REDACTION_PLACEHOLDER = '«redacted»';

export function redactSecret(text: string, ...secrets: readonly (string | null)[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret === null || secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    redacted = redacted.split(secret).join(REDACTION_PLACEHOLDER);
  }
  return redacted;
}
