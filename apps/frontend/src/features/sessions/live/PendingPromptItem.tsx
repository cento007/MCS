import type { PendingPrompt } from '../../../stores/live-session-store.js';

/**
 * A prompt the operator has submitted that the Backend has not accepted yet (TDS 05 §6.8,
 * TDS 06 §5.5 "Typing during a streaming turn").
 *
 * This is **pending-state UI, not an optimistic cache write** (§11.3). It is deliberately
 * distinguishable from a committed user Message — muted, prefixed, and cancellable — because
 * the one thing a console must never do is render an un-transmitted instruction as though the
 * agent had received it.
 */

export interface PendingPromptItemProps {
  readonly prompt: PendingPrompt;
  readonly onDiscard: () => void;
  readonly onRetry: () => void;
}

export function PendingPromptItem({ prompt, onDiscard, onRetry }: PendingPromptItemProps) {
  const failed = prompt.status === 'failed';

  return (
    <div data-testid="pending-prompt" className="flex flex-col items-end gap-1 px-4 py-2">
      <div
        className="max-w-[46rem] rounded-md border px-3 py-2"
        style={{
          backgroundColor: 'var(--color-surface)',
          borderColor: failed ? 'var(--color-danger)' : 'var(--color-border)',
        }}
      >
        <p
          className="flex items-center gap-2 text-2xs"
          style={{ color: failed ? 'var(--color-danger)' : 'var(--color-text-muted)' }}
        >
          <span aria-hidden="true">{failed ? '✕' : '⏳'}</span>
          <span>
            {prompt.status === 'sending'
              ? 'sending…'
              : failed
                ? 'not sent'
                : 'queued — will send when the current turn finishes'}
          </span>
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-muted">
          {prompt.content}
        </p>
        {prompt.error === null ? null : (
          <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--color-danger)' }}>
            {prompt.error}
          </p>
        )}
      </div>

      <div className="flex gap-2">
        {failed ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-border-control px-3 text-2xs text-text"
            style={{ height: 'var(--mc-control-sm)' }}
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDiscard}
          aria-label={failed ? 'Discard this prompt' : 'Cancel this queued prompt'}
          className="rounded-sm border border-border-control px-3 text-2xs text-text-muted"
          style={{ height: 'var(--mc-control-sm)' }}
        >
          {failed ? 'Discard' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
