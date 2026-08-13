/**
 * Saving a document the SPA already holds in memory (TDS 04 §6.7).
 *
 * ## Why this exists at all, instead of pointing the browser at the route
 *
 * `POST /sessions/{id}/export` answers with `{ data: { format, filename, content } }` — the F5.4
 * envelope — rather than `Content-Disposition: attachment`, and the Backend's own
 * `sessions/export/routes.ts` header gives that argument from its side. The client side of it is
 * this file:
 *
 *  - **`window.open` / a bare `<a href>` cannot express it.** The route is a `POST`. Turning it
 *    into a navigable `GET` would be changing the contract to suit the download widget.
 *  - **A blob-reading `fetch` loses the typed error path.** `lib/api/client.ts` parses every
 *    response as JSON and converts every non-2xx into an `ApiError` carrying `code`, `details`
 *    and `requestId`. A download path that reads `response.blob()` never inspects the body, so a
 *    `409 CONFLICT` for an unstarted Session lands on disk as a file called `export.md`
 *    containing an error object — a failure the operator discovers in a text editor, later.
 *
 * So the document travels as JSON through the one HTTP path this app has, and the *file* is
 * manufactured here, after the error path has already had its chance to fire.
 */

/** `text/markdown` is the only thing §6.7 emits today; the parameter is here so it can grow. */
export const MARKDOWN_MIME = 'text/markdown;charset=utf-8';

export interface DownloadTextOptions {
  readonly filename: string;
  readonly content: string;
  readonly mimeType?: string;
}

/**
 * Write `content` to the operator's download folder under `filename`.
 *
 * The object URL is revoked on the next task rather than immediately: the browser reads the blob
 * asynchronously after `click()`, and revoking in the same tick is a documented way to get an
 * empty or failed download in Chromium. A leaked object URL survives until the document is
 * discarded, so "revoke a moment later" is the cheap side of that trade — while not revoking at
 * all would pin every exported transcript in memory for the life of the tab.
 */
export function downloadTextFile({ filename, content, mimeType }: DownloadTextOptions): void {
  const blob = new Blob([content], { type: mimeType ?? MARKDOWN_MIME });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  // Appended before clicking: a detached anchor's `click()` is a no-op in Firefox, which is
  // exactly the kind of difference that makes a download work on the developer's machine only.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * A filename for a document the Backend did not name.
 *
 * `POST /sessions/{id}/export` supplies its own `filename` and that one is always preferred — it
 * is deterministic in the Session, so re-exporting replaces its predecessor instead of
 * accumulating `(1)` copies in a Downloads folder. `POST /sessions/{id}/context-package` returns
 * no filename, so this reproduces the same property client-side: same Session, same name, always.
 *
 * A **whitelist**, not a blocklist of reserved characters: the two supported platforms disagree
 * about what is legal (Windows is stricter), and a name assembled from a Session title can carry
 * anything an operator typed. `[A-Za-z0-9._-]` is legal on both, and losing an emoji from a
 * filename costs nothing that the document itself does not already say.
 */
export function safeFilename(parts: readonly string[], extension: string): string {
  const base = parts
    .join(' ')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return `${base.length === 0 ? 'document' : base}${extension}`;
}
