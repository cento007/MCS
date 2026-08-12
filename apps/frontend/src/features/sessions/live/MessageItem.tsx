import type { Message, MessageContentBlock } from '../../../lib/api/index.js';
import { formatClock } from '../../../lib/format/index.js';
import { Markdown } from './markdown.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { countToolCalls, messageText, readString, type ToolResult } from './transcript.js';

/**
 * One committed Message (TDS 05 §6.4 role vocabulary, F4.1: user / assistant / system / tool).
 *
 * Assistant turns are `role="article"` with `tabindex="-1"` and an accessible name of the form
 * `"Claude, 14:03, 4 tool calls"` (TDS 06 §7.4 item 3). Focus is never stolen — the
 * "Read latest response" control moves it deliberately — but the article has to exist and be
 * focusable for that control to have somewhere to land.
 */

export interface MessageItemProps {
  readonly message: Message;
  readonly toolResults: ReadonlyMap<string, ToolResult>;
  /** `tool_use` ids present anywhere in the transcript, so a paired result is not shown twice. */
  readonly pairedToolUseIds: ReadonlySet<string>;
  readonly highlighted?: boolean;
}

export function MessageItem({
  message,
  toolResults,
  pairedToolUseIds,
  highlighted = false,
}: MessageItemProps) {
  switch (message.role) {
    case 'user':
      return <UserMessage message={message} highlighted={highlighted} />;
    case 'system':
      return <SystemMessage message={message} />;
    case 'tool':
      return (
        <ToolMessage
          message={message}
          toolResults={toolResults}
          pairedToolUseIds={pairedToolUseIds}
        />
      );
    default:
      return (
        <AssistantMessage message={message} toolResults={toolResults} highlighted={highlighted} />
      );
  }
}

export function messageAccessibleName(message: Message): string {
  const time = formatClock(message.occurredAt);
  if (message.role === 'user') return `You, ${time}${statusSuffix(message)}`;
  if (message.role === 'system') return `System, ${time}`;
  if (message.role === 'tool') return `Tool activity, ${time}`;

  const tools = countToolCalls(message);
  const toolPart = tools === 0 ? '' : `, ${tools} tool call${tools === 1 ? '' : 's'}`;
  return `Claude, ${time}${toolPart}${statusSuffix(message)}`;
}

function statusSuffix(message: Message): string {
  if (message.status === 'pending') return ', not yet delivered';
  if (message.status === 'interrupted') return ', interrupted';
  return '';
}

function UserMessage({ message, highlighted }: { message: Message; highlighted: boolean }) {
  return (
    <article
      // §6.4: user turns are right-aligned with a surface block — the visual channel that says
      // "this one is yours" without a bubble metaphor the rest of the console does not use.
      tabIndex={-1}
      aria-label={messageAccessibleName(message)}
      data-message-id={message.id}
      className="flex flex-col items-end gap-1 px-4 py-2"
      style={highlighted ? { backgroundColor: 'var(--color-selected)' } : undefined}
    >
      <p className="flex items-center gap-2 text-2xs text-text-muted uppercase">
        <span>You</span>
        <span className="font-mono">{formatClock(message.occurredAt)}</span>
      </p>
      <div
        className="max-w-[46rem] rounded-md px-3 py-2 text-sm text-text leading-150"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <p className="whitespace-pre-wrap break-words">{messageText(message)}</p>
      </div>
      {message.status === 'pending' ? (
        // §6.6: prompts the Backend persisted as pending are redisplayed, never auto-replayed.
        <p className="text-2xs" style={{ color: 'var(--color-warning)' }}>
          ⏳ not delivered to the runtime yet
        </p>
      ) : null}
    </article>
  );
}

function AssistantMessage({
  message,
  toolResults,
  highlighted,
}: {
  message: Message;
  toolResults: ReadonlyMap<string, ToolResult>;
  highlighted: boolean;
}) {
  return (
    <article
      tabIndex={-1}
      aria-label={messageAccessibleName(message)}
      data-message-id={message.id}
      data-role="assistant"
      className="flex flex-col gap-2 px-4 py-2"
      style={highlighted ? { backgroundColor: 'var(--color-selected)' } : undefined}
    >
      <p className="flex items-center gap-2 text-2xs text-text-muted uppercase">
        <span>Claude</span>
        <span className="font-mono">{formatClock(message.occurredAt)}</span>
        {message.model === null ? null : (
          <span className="font-mono lowercase">{message.model}</span>
        )}
      </p>

      {message.content.map((block, index) => (
        // Index keying is correct here and only here: Messages are **content-immutable**
        // (§6.6 — `status` is the one mutable field), so a block's position never changes and
        // the array is never reordered, inserted into, or filtered.
        // biome-ignore lint/suspicious/noArrayIndexKey: content blocks of an immutable Message have a fixed position
        <ContentBlock key={`${message.id}-${index}`} block={block} toolResults={toolResults} />
      ))}

      {message.status === 'interrupted' ? (
        // The canonical interrupted marker comes from the Message, not the client (§6.2).
        <p
          className="border-border-strong border-t pt-1 font-mono text-2xs"
          style={{ color: 'var(--color-warning)' }}
        >
          — turn stopped · partial response retained
        </p>
      ) : null}
    </article>
  );
}

function ContentBlock({
  block,
  toolResults,
}: {
  block: MessageContentBlock;
  toolResults: ReadonlyMap<string, ToolResult>;
}) {
  const type = block['type'];

  if (type === 'text') {
    return <Markdown source={readString(block, 'text') ?? ''} />;
  }

  if (type === 'thinking') {
    return (
      <div className="border-border-strong border-l-2 pl-3 text-text-secondary">
        <p className="text-2xs text-text-muted uppercase">Thinking</p>
        <Markdown source={readString(block, 'text') ?? ''} />
      </div>
    );
  }

  if (type === 'tool_use') {
    const toolUseId = readString(block, 'toolUseId');
    const result = toolUseId === null ? undefined : toolResults.get(toolUseId);
    return (
      <ToolCallBlock
        toolName={readString(block, 'toolName') ?? 'tool'}
        input={block['input']}
        result={result}
        status={result === undefined ? 'running' : result.isError ? 'error' : 'ok'}
      />
    );
  }

  if (type === 'tool_result') {
    // Paired results render inside their `tool_use` card; an orphan is handled by ToolMessage.
    return null;
  }

  // §6.2 forward-compatibility: an unrecognised block type is opaque, not an error. Naming it
  // is more useful than hiding it — the operator can see the runtime emitted something this
  // build does not model, instead of silently missing part of the turn.
  return (
    <p
      className="rounded-xs px-2 py-1 font-mono text-2xs text-text-muted"
      style={{ backgroundColor: 'var(--color-surface-inset)' }}
    >
      unsupported content block: {String(type)}
    </p>
  );
}

function SystemMessage({ message }: { message: Message }) {
  return (
    <div
      // §6.4: de-emphasised inline notice rows, not chat bubbles.
      data-message-id={message.id}
      className="flex items-center gap-3 px-4 py-2"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <p className="text-2xs text-text-muted">
        {messageText(message) || 'system event'} · {formatClock(message.occurredAt)}
      </p>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

function ToolMessage({
  message,
  toolResults,
  pairedToolUseIds,
}: {
  message: Message;
  toolResults: ReadonlyMap<string, ToolResult>;
  pairedToolUseIds: ReadonlySet<string>;
}) {
  const orphans = message.content.filter((block) => {
    if (block['type'] !== 'tool_result') return block['type'] === 'tool_use';
    const id = readString(block, 'toolUseId');
    return id === null || !pairedToolUseIds.has(id);
  });

  if (orphans.length === 0) return null;

  return (
    <div data-message-id={message.id} className="flex flex-col gap-2 px-4 py-1">
      {orphans.map((block) => {
        const id = readString(block, 'toolUseId');
        const result = id === null ? undefined : toolResults.get(id);
        return (
          // Keyed on `toolUseId` where there is one, and otherwise on the block's position in
          // the **source** Message — which is stable because Messages are content-immutable
          // (§6.6), unlike the filtered `orphans` view it is being rendered from.
          <ToolCallBlock
            key={`${message.id}-orphan-${id ?? message.content.indexOf(block)}`}
            toolName={readString(block, 'toolName') ?? 'tool'}
            input={block['input'] ?? {}}
            result={result}
            status={result === undefined ? 'running' : result.isError ? 'error' : 'ok'}
          />
        );
      })}
    </div>
  );
}
