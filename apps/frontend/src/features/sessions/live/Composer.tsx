import { useRef } from 'react';
import type { Session } from '../../../lib/api/index.js';
import { formatCostUsd, formatDateTime, formatDuration } from '../../../lib/format/index.js';
import {
  type ComposerMode,
  composerPlaceholder,
  isComposerEnabled,
  type SessionActionDescriptor,
} from '../actions.js';

/**
 * The prompt composer and the bars that replace it (TDS 05 §6.6, TDS 06 §5.5).
 *
 * The mode is derived **strictly from canonical Session state** (F7) plus session type, so a
 * `running → failed` crash flips this surface to the failure banner with no user action. Two
 * consequences of that are easy to get wrong and are asserted in the tests:
 *
 *  - **`created` is enabled**, not disabled-with-a-hint. Typing is the natural start gesture,
 *    and the operator never meets a dead text box whose only job is to say "press a button
 *    first". `[Start]` remains for the genuine no-prompt case.
 *  - **`running` stays enabled while a turn is streaming.** An operator watching an agent go
 *    down the wrong path must be able to type the correction *while they are thinking it*.
 *    The prompt becomes a visibly-pending entry (§6.8), not a rejection.
 */

export interface ComposerProps {
  readonly session: Session;
  readonly mode: ComposerMode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Focus target for `Esc` — the conversation region, per §9.4's suppression rule. */
  readonly onEscape: () => void;
  /** §6.2.1 — the launch was accepted but deferred; the typed prompt is retained. */
  readonly launchQueued: boolean;
  readonly submitting: boolean;
  /** Backend-persisted prompts that were never delivered (§6.6) — offered for explicit re-send. */
  readonly undeliveredPrompts: readonly string[];
  readonly onRestorePrompt: (content: string) => void;
  readonly terminalActions: readonly SessionActionDescriptor[];
  readonly onAction: (action: SessionActionDescriptor) => void;
}

export function Composer(props: ComposerProps) {
  const { mode } = props;

  if (mode === 'observed') return <ObservedBar />;
  if (mode === 'completed') return <CompletedBar {...props} />;
  if (mode === 'failed') return <FailedBar {...props} />;
  if (mode === 'archived') return <ArchivedBar {...props} />;

  return <PromptComposer {...props} />;
}

function PromptComposer({
  session,
  mode,
  value,
  onChange,
  onSubmit,
  onEscape,
  launchQueued,
  submitting,
  undeliveredPrompts,
  onRestorePrompt,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const enabled = isComposerEnabled(mode);
  const canSend = enabled && value.trim().length > 0 && !submitting;

  return (
    <div
      className="border-border border-t px-4 py-3"
      style={{ backgroundColor: 'var(--color-bg)' }}
    >
      {launchQueued ? (
        <p
          className="mb-2 flex items-center gap-2 text-2xs"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">⏳</span>
          Queued for launch — all runtime slots are busy. Your prompt is kept and sent when a slot
          frees.
        </p>
      ) : null}

      {undeliveredPrompts.length > 0 && mode !== 'prompt' ? (
        <div className="mb-2 rounded-sm border border-border p-2">
          <p className="text-2xs text-text-muted">
            {undeliveredPrompts.length} prompt{undeliveredPrompts.length === 1 ? '' : 's'} were
            never delivered to the runtime. They are never replayed automatically.
          </p>
          {undeliveredPrompts.map((content) => (
            <button
              key={content}
              type="button"
              onClick={() => onRestorePrompt(content)}
              className="mt-1 block max-w-full truncate rounded-xs text-left text-2xs text-text-secondary underline decoration-dotted underline-offset-2"
              style={{ minHeight: 24 }}
            >
              Put back in composer: {content}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={2}
          value={value}
          disabled={!enabled}
          aria-label="Prompt"
          data-testid="composer-input"
          placeholder={
            enabled ? composerPlaceholder(mode) : 'Session is paused — resume to continue'
          }
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // `Ctrl+Enter` and `Escape` are the only two bindings that survive text entry
            // (§9.4). Everything else is suppressed so typing "generate the docs" cannot
            // teleport the operator to another page.
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              if (canSend) onSubmit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              // One press leaves the field; a second (from the conversation) stops the turn.
              // A single stray `Esc` while typing must never kill a turn (§6.8).
              onEscape();
            }
          }}
          className="min-w-0 flex-1 resize-none rounded-sm border bg-transparent px-3 py-2 text-sm text-text placeholder:text-text-muted disabled:text-text-disabled"
          style={{ borderColor: 'var(--color-border-control)' }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send prompt"
          className="rounded-sm px-4 font-medium text-sm disabled:opacity-50"
          style={{
            height: 'var(--mc-control-md)',
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          {submitting ? '…' : '➤'}
        </button>
      </div>

      <p className="mt-1 text-2xs text-text-muted">
        {mode === 'start-with-prompt'
          ? 'Sending starts the session and delivers this as the first turn.'
          : mode === 'paused'
            ? 'Session is paused — resume to continue.'
            : 'Ctrl+Enter to send. Typing is allowed while a turn is streaming.'}
        {session.sessionType === 'managed' ? '' : ''}
      </p>
    </div>
  );
}

function ObservedBar() {
  return (
    <div
      data-testid="observed-bar"
      className="flex items-center gap-2 border-border border-t px-4 py-3 text-sm text-text-secondary"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span aria-hidden="true">👁</span>
      <span>
        Observed session — read-only. Mission Control records this session; it does not drive it.
      </span>
    </div>
  );
}

function CompletedBar({ session, terminalActions, onAction }: ComposerProps) {
  return (
    <div
      className="border-border border-t px-4 py-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <p className="text-sm text-text">
        <span aria-hidden="true" style={{ color: 'var(--color-state-completed)' }}>
          ✓
        </span>{' '}
        Session completed ·{' '}
        <span className="font-mono">{formatDuration(session.durationSeconds)}</span> ·{' '}
        <span className="font-mono">{formatCostUsd(session.costUsd)}</span>
      </p>
      <TerminalActions actions={terminalActions} onAction={onAction} />
    </div>
  );
}

/**
 * §5.5's failure ErrorBanner: "reason, `code`, `requestId`".
 *
 * The reason comes straight off the Session resource. It used to be dug out of the timeline —
 * one extra request for a fact the resource already carried — and before `failureReason` was
 * serialized at all this line could only ever render `—`, which is to say this banner could
 * announce a failure without being able to name it.
 */
function FailedBar({ session, terminalActions, onAction }: ComposerProps) {
  const code = session.failureReason?.trim() ?? '';

  return (
    <div
      role="alert"
      data-testid="failure-banner"
      className="border-t px-4 py-3"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
      }}
    >
      <p className="font-medium text-sm" style={{ color: 'var(--color-danger)' }}>
        Session failed
      </p>
      <p className="mt-1 text-sm text-text">
        The runtime stopped before the session completed. Any partial response above is retained —
        it is the last thing the agent produced.
      </p>
      <p data-testid="failure-detail" className="mt-1 font-mono text-2xs text-text-muted">
        {/* Every segment is rendered even when empty, as `—`. A missing error code is itself
            information — it says the failure carried none — and a line that silently drops
            fields makes "no code" indistinguishable from "no line".
            `requestId` stays `—` on purpose: the F5.4 id exists only when the failure
            surfaced through an API call, nothing persists one against a Session today, and a
            fabricated correlation id is worse than an absent one. */}
        {code.length === 0 ? '—' : code} · requestId — ·{' '}
        <span>{formatDateTime(session.completedAt)}</span>
      </p>
      <TerminalActions actions={terminalActions} onAction={onAction} />
    </div>
  );
}

function ArchivedBar({ terminalActions, onAction }: ComposerProps) {
  return (
    <div
      className="border-border border-t px-4 py-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <p className="text-sm text-text-muted">
        <span aria-hidden="true">▣</span> Archived — read-only transcript.
      </p>
      <TerminalActions actions={terminalActions} onAction={onAction} />
    </div>
  );
}

function TerminalActions({
  actions,
  onAction,
}: {
  actions: readonly SessionActionDescriptor[];
  onAction: (action: SessionActionDescriptor) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => onAction(action)}
          title={action.hint}
          className="rounded-sm border border-border-control px-3 font-medium text-sm text-text"
          style={{ height: 'var(--mc-control-md)' }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
