import { useState } from 'react';
import { ApiError, errorMessage } from '../lib/api/errors.js';

/**
 * Inline error surface for query failures (TDS 05 §11.1, TDS 06 §4.3).
 *
 * Renders the F5.4 envelope consistently: human message, `code` as a mono chip, a Retry
 * affordance, and a de-emphasised click-to-copy `requestId` line.
 *
 * **The `requestId` is always shown.** F5.4 guarantees the same value appears in the
 * Backend log and in the `X-Request-Id` header, which makes it the operator's only bridge
 * from a red box on screen to the line that explains it. An error UI that drops it turns a
 * two-minute diagnosis into a log-grep.
 */
export function ErrorPanel({
  error,
  onRetry,
  title = 'Something went wrong',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;

  return (
    <div
      role="alert"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
      }}
    >
      <p className="font-medium text-sm" style={{ color: 'var(--color-danger)' }}>
        {title}
      </p>
      <p className="mt-1 text-sm text-text">{errorMessage(error)}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {apiError === null ? null : (
          <code className="rounded-xs bg-surface-inset px-2 py-05 font-mono text-2xs text-text-secondary">
            {apiError.code}
          </code>
        )}
        {onRetry === undefined ? null : (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-border-control px-3 font-medium text-sm text-text"
            style={{ height: 'var(--mc-control-sm)' }}
          >
            Retry
          </button>
        )}
      </div>

      {apiError?.requestId == null ? null : <RequestIdLine requestId={apiError.requestId} />}
    </div>
  );
}

export function RequestIdLine({ requestId }: { requestId: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(requestId)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => {
        // Clipboard permission denied — the value is still selectable on screen, which is
        // the reason it is rendered as text rather than hidden behind the button.
      });
  };

  return (
    <p className="mt-3 text-2xs text-text-muted">
      Reference:{' '}
      <button
        type="button"
        onClick={copy}
        className="rounded-xs font-mono underline decoration-dotted underline-offset-2"
        title="Copy request ID"
      >
        {requestId}
      </button>
      {copied ? <span className="ml-2">Copied</span> : null}
    </p>
  );
}
