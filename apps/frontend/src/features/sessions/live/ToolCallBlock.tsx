import { useId, useState } from 'react';
import { primaryArgument, type ToolResult } from './transcript.js';

/**
 * The collapsible tool-call card (TDS 05 §6.4, TDS 06 §5.5).
 *
 * The accessible name is the specification's exact requirement (§7.4 item 4):
 *
 *   "tool Read, packages/shared/queue.ts, completed in 1.2 seconds"
 *
 * — tool, primary argument, outcome, duration, all carried **without expanding**, because a
 * collapsed row must be comprehensible to a screen-reader user for the same reason it is to a
 * sighted one: scanning a 40-call transcript by opening every card is not scanning.
 */

export type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolCallBlockProps {
  readonly toolName: string;
  readonly input: unknown;
  readonly result?: ToolResult | undefined;
  /** `running` while the block is still open in the stream. */
  readonly status: ToolStatus;
}

/** Long output is clamped; ~40 lines is TDS 06 §5.5's number. */
const OUTPUT_CLAMP_LINES = 40;

export function accessibleToolName(
  toolName: string,
  argument: string | null,
  status: ToolStatus,
  durationSeconds: number | null | undefined,
): string {
  const parts = [`tool ${toolName}`];
  if (argument !== null) parts.push(argument);

  if (status === 'running') {
    parts.push('running');
  } else if (status === 'error') {
    parts.push('failed');
  } else if (durationSeconds === null || durationSeconds === undefined) {
    parts.push('completed');
  } else {
    parts.push(`completed in ${formatSeconds(durationSeconds)} seconds`);
  }

  return parts.join(', ');
}

export function formatSeconds(seconds: number): string {
  return seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1);
}

export function ToolCallBlock({ toolName, input, result, status }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const bodyId = useId();

  const argument = primaryArgument(input);
  const duration = result?.durationSeconds ?? null;
  const label = accessibleToolName(toolName, argument, status, duration);

  const output = result?.output ?? '';
  const lines = output.length === 0 ? [] : output.split('\n');
  const clamped = !showFull && lines.length > OUTPUT_CLAMP_LINES;
  const shown = clamped ? lines.slice(0, OUTPUT_CLAMP_LINES).join('\n') : output;

  return (
    <div
      className="rounded-sm border border-border"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={label}
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-2 px-3 text-left"
        style={{ minHeight: 'var(--mc-control-md)' }}
      >
        <span aria-hidden="true" className="text-text-muted text-xs">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="font-mono text-text-secondary text-xs">tool: {toolName}</span>
        {argument === null ? null : (
          <span
            className="min-w-0 flex-1 truncate font-mono text-2xs text-text-muted"
            title={argument}
          >
            {argument}
          </span>
        )}
        <ToolStatusChip status={status} durationSeconds={duration} />
      </button>

      {expanded ? (
        <div id={bodyId} className="border-border border-t p-3">
          <ToolSection title="Input" body={formatInput(input)} />
          {result === undefined ? null : (
            <div className="mt-3">
              <ToolSection title={result.isError ? 'Error output' : 'Output'} body={shown} />
              {clamped ? (
                <button
                  type="button"
                  onClick={() => setShowFull(true)}
                  className="mt-2 rounded-xs text-2xs text-text-muted underline decoration-dotted underline-offset-2"
                  style={{ minHeight: 24 }}
                >
                  Show full output ({lines.length} lines)
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        // The body is absent rather than hidden while collapsed: the transcript is virtualized
        // and every offscreen tool payload kept in the DOM is measured memory for nothing.
        <div id={bodyId} hidden />
      )}
    </div>
  );
}

function ToolStatusChip({
  status,
  durationSeconds,
}: {
  status: ToolStatus;
  durationSeconds: number | null;
}) {
  if (status === 'running') {
    return (
      <span className="shrink-0 font-mono text-2xs" style={{ color: 'var(--color-state-running)' }}>
        <span aria-hidden="true" className="mc-spin-slow">
          ⣾
        </span>{' '}
        running…
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="shrink-0 font-mono text-2xs" style={{ color: 'var(--color-danger)' }}>
        error
      </span>
    );
  }
  return (
    <span className="shrink-0 font-mono text-2xs text-text-muted">
      ok{durationSeconds === null ? '' : ` · ${formatSeconds(durationSeconds)}s`}
    </span>
  );
}

function ToolSection({ title, body }: { title: string; body: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(body)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => {
        // Denied clipboard permission: the payload is on screen and selectable, which is why
        // it is rendered as text rather than living only behind this button.
      });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-2xs text-text-muted uppercase">{title}</p>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${title.toLowerCase()}`}
          className="rounded-xs px-2 text-2xs text-text-muted"
          style={{ minHeight: 24, minWidth: 24 }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="mt-1 max-h-96 overflow-auto rounded-sm p-2 font-mono text-2xs leading-145"
        style={{ backgroundColor: 'var(--color-surface-inset)' }}
      >
        <code>{body}</code>
      </pre>
    </div>
  );
}

/** JSON pretty-printing, with a raw fallback so a non-JSON payload is still shown. */
export function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
