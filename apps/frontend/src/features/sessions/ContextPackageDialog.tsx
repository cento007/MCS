import { Modal } from '../../components/Modal.js';
import { downloadTextFile } from '../../lib/download.js';
import { formatBytes, formatDateTime } from '../../lib/format/index.js';
import { toast } from '../../stores/toast-store.js';
import {
  contextGapLabel,
  contextPackageFilename,
  type SessionDocumentsController,
} from './documents.js';

/**
 * The generated Context Package (TDS 04 §6.7, TDS 06 §5.5 `[Context Package]`).
 *
 * ## Why a modal, and not a download or a route
 *
 * The artifact's purpose is to be **pasted into another session**. That makes "read it, then take
 * it with you" the operating verb, and rules out the two obvious alternatives:
 *
 *  - **A silent download** answers a question the operator has not asked. The package is
 *    generated in one shot with no preview, and its most important property — whether the
 *    related-context section is whole — is invisible from a filename. Landing it in a Downloads
 *    folder means the degraded case is discovered in an editor, if at all.
 *  - **A route** (`/sessions/:id/context-package`) would evict the Session the operator is
 *    working in, for a document produced from a `POST` that is not addressable by URL — a
 *    reload would have to regenerate it, spending another embedding call and another `git
 *    status` on a document nobody asked to regenerate.
 *
 * A modal over the Session keeps the source in place, is dismissible with `Esc`, and can carry
 * both exits — clipboard for the paste that motivated it, `.md` for the one that is filed.
 *
 * ## The badge is the only signal there is
 *
 * `relatedContext.gapReason` is non-`null` whenever semantic memory did not answer, for any of
 * eight reasons. A package with a degraded memory section looks *complete* otherwise: every other
 * section is present, the prose is intact, and the document's own warning callout is nine screens
 * down. The badge is read from the field, never from the Markdown — that field exists exactly so
 * that no client has to pattern-match prose to find out whether it received a whole document.
 */
export function ContextPackageDialog({ documents }: { documents: SessionDocumentsController }) {
  const contextPackage = documents.contextPackage;
  const generating = documents.pendingId === 'context-package';
  const filename = contextPackageFilename(documents.session);

  const copy = (): void => {
    if (contextPackage === null) return;
    void navigator.clipboard
      ?.writeText(contextPackage.content)
      .then(() => toast({ kind: 'success', message: 'Context package copied' }))
      .catch(() => toast({ kind: 'warning', message: 'Clipboard is not available' }));
  };

  const download = (): void => {
    if (contextPackage === null) return;
    downloadTextFile({ filename, content: contextPackage.content });
  };

  return (
    <Modal
      open={contextPackage !== null || generating}
      onClose={documents.dismiss}
      title="Context package"
      width="wide"
      footer={
        <>
          <button
            type="button"
            onClick={documents.dismiss}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)' }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={download}
            disabled={contextPackage === null}
            className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
            style={{ height: 'var(--mc-control-md)' }}
          >
            Download .md
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={contextPackage === null}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            Copy Markdown
          </button>
        </>
      }
    >
      {contextPackage === null ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <p className="text-sm text-text">Generating…</p>
          <p className="max-w-2xl text-2xs text-text-muted leading-150">
            The package is assembled from this session's prompts, decisions, files and commits, plus
            one <code className="font-mono">git status</code> of the working tree and one
            semantic-memory query for related prior work. The last two reach outside the database
            and are bounded at 10 s and 25 s — if either misses its budget the package is still
            produced, and says so.
          </p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {/* The size facts, first. The document exists to be pasted into another context
              window, so "will it fit" is the first question it has to answer — and the estimate
              is labelled as one, beside the byte count, which is not. */}
          <p className="flex flex-wrap items-center gap-3 text-2xs text-text-muted">
            <span
              className="font-mono text-text-secondary"
              title="Estimated from the byte count — not a tokeniser run. The byte count beside it is exact."
            >
              ~{contextPackage.tokenEstimate.toLocaleString()} tokens
            </span>
            <span className="font-mono">{formatBytes(contextPackage.bytes)}</span>
            <span>generated {formatDateTime(contextPackage.generatedAt)}</span>
            <span className="font-mono">{filename}</span>
          </p>

          <RelatedContextLine related={contextPackage.relatedContext} />

          {/* The APG scrollable-region pattern: a named `<section>` (role `region`) carrying the
              tab stop, with the document inside it. It is the tallest thing in the dialog and the
              only one a reader has to move through, so a keyboard user who cannot focus it cannot
              read past the first screen. */}
          <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs a tab stop or a keyboard user cannot read past its first screen (WAI-ARIA APG) — and this is a named landmark, not a static div
            tabIndex={0}
            aria-label="Context package Markdown"
            className="min-w-0 overflow-auto rounded-sm border border-border"
            style={{ maxHeight: '55vh', backgroundColor: 'var(--color-surface)' }}
          >
            <pre
              data-testid="context-package-content"
              className="whitespace-pre-wrap break-words p-3 font-mono text-2xs text-text leading-150"
            >
              {contextPackage.content}
            </pre>
          </section>
        </div>
      )}
    </Modal>
  );
}

/**
 * One line about the related-context section: what it found, or precisely what it did not.
 *
 * The gap arm is an `alert` rather than a quiet note. It is the difference between a hand-off
 * document that carries the project's prior decisions and one that carries none — and the
 * operator is about to paste it into a session that will treat whatever is there as the whole
 * story. `gapDetail` is the Backend's own sentence, rendered verbatim as both the tooltip and
 * visible prose: a `title` alone is unreachable by touch and by keyboard.
 */
function RelatedContextLine({
  related,
}: {
  related: {
    resultCount: number;
    gapReason: string | null;
    gapDetail: string | null;
    embeddingModel: string | null;
  };
}) {
  if (related.gapReason === null) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <span aria-hidden="true">●</span>
        {related.resultCount} related item{related.resultCount === 1 ? '' : 's'} from semantic
        memory
        {related.embeddingModel === null ? null : (
          <span className="font-mono">{related.embeddingModel}</span>
        )}
      </p>
    );
  }

  return (
    <div
      role="alert"
      data-testid="context-package-gap"
      title={related.gapDetail ?? undefined}
      className="rounded-sm px-2 py-1"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        color: 'var(--color-warning)',
      }}
    >
      <p className="font-medium text-2xs">
        <span aria-hidden="true">⚠</span> Related context is incomplete —{' '}
        {contextGapLabel(related.gapReason)}
      </p>
      {related.gapDetail === null ? null : (
        <p className="mt-1 text-2xs leading-150">{related.gapDetail}</p>
      )}
      <p className="mt-1 text-2xs leading-150">
        Every other section was produced normally. Only prior decisions from other sessions are
        missing.
      </p>
    </div>
  );
}
