import { RequestIdLine } from '../../../components/ErrorPanel.js';
import { formatClockSeconds } from '../../../lib/format/index.js';
import type { LiveBlock, LiveTurn, TurnTermination } from '../../../stores/live-session-store.js';
import { Markdown } from './markdown.js';
import { ToolCallBlock } from './ToolCallBlock.js';

/**
 * The live tail — at most one in-progress assistant turn per Session (TDS 05 §6.1).
 *
 * This is the only component in the app that re-renders at stream frequency, which is the
 * whole point of keeping the buffer out of the query cache (§6.2). It renders through the
 * same markdown pipeline as a committed turn, with the incomplete-tolerant parse, so the text
 * does not reflow into a different shape the moment the turn commits.
 *
 * **A partial turn is never blanked.** A terminated buffer is rendered at *normal* emphasis —
 * not dimmed, not collapsed — closed by a terminating rule. TDS 06 §5.5 states the reason
 * plainly: the last thing the agent said before it died is usually why it died, and it is
 * unrecoverable once dropped because the runtime never re-emits it.
 */

export interface StreamingTurnProps {
  readonly turn: LiveTurn;
  /**
   * True while the socket is not `live` and the turn is still open: the stream is not dead,
   * the wire is. §6.2 case 3 — mark it, keep the text, never blank the transcript.
   */
  readonly streamInterrupted: boolean;
}

export function StreamingTurn({ turn, streamInterrupted }: StreamingTurnProps) {
  const live = turn.status === 'streaming';
  const inFlight = live || turn.status === 'awaiting_commit';

  return (
    <article
      tabIndex={-1}
      data-testid="streaming-turn"
      aria-label="Claude, responding"
      // §7.4 item 5: assistive technology must know this subtree is mid-update, so a
      // truncated sentence is not presented as a finished one. Removed on commit — which
      // happens by this component unmounting.
      aria-busy={inFlight ? true : undefined}
      className="flex flex-col gap-2 px-4 py-2"
    >
      <p className="flex items-center gap-2 text-2xs text-text-muted uppercase">
        <span>Claude</span>
        {live ? (
          <span aria-hidden="true" className="mc-spin-slow">
            ⣾
          </span>
        ) : null}
      </p>

      {turn.blocks.length === 0 && !inFlight ? (
        <p className="text-sm text-text-muted">No output was received for this turn.</p>
      ) : null}

      {turn.blocks.map((block) => (
        <LiveBlockView key={block.index} block={block} streaming={live} />
      ))}

      {streamInterrupted && turn.status !== 'terminated' ? (
        <p className="font-mono text-2xs" style={{ color: 'var(--color-warning)' }}>
          ⏸ stream interrupted — reconnecting
        </p>
      ) : live ? (
        <p className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1 rounded-xs px-2 py-05 text-2xs"
            style={{
              backgroundColor: 'var(--color-state-running-subtle)',
              color: 'var(--color-state-running)',
            }}
          >
            <span aria-hidden="true" className="mc-pulse">
              ●
            </span>
            Streaming…
          </span>
        </p>
      ) : null}

      {turn.termination === null ? null : <TerminationRule termination={turn.termination} />}
    </article>
  );
}

function LiveBlockView({ block, streaming }: { block: LiveBlock; streaming: boolean }) {
  if (block.kind === 'tool_use') {
    return (
      <ToolCallBlock
        toolName={toolNameOf(block.partialJson) ?? 'tool'}
        input={parsePartialJson(block.partialJson)}
        status={block.complete ? 'ok' : 'running'}
      />
    );
  }

  if (block.kind === 'thinking') {
    return (
      <div className="border-border-strong border-l-2 pl-3 text-text-secondary">
        <p className="text-2xs text-text-muted uppercase">Thinking</p>
        <Markdown source={block.text} />
      </div>
    );
  }

  if (block.kind === 'unknown' && block.text.length === 0) {
    return (
      <p
        className="rounded-xs px-2 py-1 font-mono text-2xs text-text-muted"
        style={{ backgroundColor: 'var(--color-surface-inset)' }}
      >
        …
      </p>
    );
  }

  return (
    <div className="relative">
      <Markdown source={block.text} />
      {streaming && !block.complete ? (
        // The block cursor at the text tip (TDS 06 §5.5). Class-based so the global
        // reduced-motion reset flattens the blink without a per-component opt-in.
        <span aria-hidden="true" className="mc-pulse font-mono text-text">
          ▌
        </span>
      ) : null}
    </div>
  );
}

/**
 * The terminating rule of §6.2 / §5.5, with omitted segments rendered as `—` rather than
 * dropped. A missing error code is itself information: it says the failure carried none.
 */
function TerminationRule({ termination }: { termination: TurnTermination }) {
  const at = formatClockSeconds(termination.at);

  if (termination.reason === 'interrupted') {
    return (
      <p
        className="border-border-strong border-t pt-1 font-mono text-2xs"
        style={{ color: 'var(--color-warning)' }}
      >
        — turn stopped by operator {at}
      </p>
    );
  }

  if (termination.reason === 'disconnected') {
    return (
      <p
        className="border-border-strong border-t pt-1 font-mono text-2xs"
        style={{ color: 'var(--color-warning)' }}
      >
        — stream interrupted {at}
      </p>
    );
  }

  return (
    <div className="border-border-strong border-t pt-1">
      <p className="font-mono text-2xs" style={{ color: 'var(--color-danger)' }}>
        — stream ended here · session failed {at} · {termination.errorCode ?? '—'}
      </p>
      {termination.requestId === null ? (
        <p className="font-mono text-2xs text-text-muted">requestId —</p>
      ) : (
        <RequestIdLine requestId={termination.requestId} />
      )}
    </div>
  );
}

/**
 * `input_json_delta` fragments accumulate as a string and are parsed here, not in the store
 * (§6.2): a half-written JSON object is the normal mid-stream state, so parsing has to be
 * allowed to fail on every frame until the last one without that being an error condition.
 */
export function parsePartialJson(partial: string): unknown {
  if (partial.trim().length === 0) return {};
  try {
    return JSON.parse(partial) as unknown;
  } catch {
    return { '…': partial };
  }
}

function toolNameOf(partial: string): string | null {
  const parsed = parsePartialJson(partial);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const name =
    (parsed as Record<string, unknown>)['toolName'] ?? (parsed as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : null;
}
