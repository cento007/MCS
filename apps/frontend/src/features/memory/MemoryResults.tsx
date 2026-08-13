import type { MemoryTier } from '@mc/shared/types';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatDateTime } from '../../lib/format/index.js';
import { formatRelativePast } from '../../lib/format/relative.js';
import { useLiveClock } from '../../lib/liveness.js';
import { chunkLabel, resultLink, sourceTypeLabel } from './links.js';
import { describeScore, formatScore, HEADROOM_CEILING, headroom } from './relevance.js';
import type { MemorySearchResult } from './types.js';

/**
 * The result list.
 *
 * Each hit has to answer three questions before the operator clicks anything: *what* matched
 * (title + source type + tier), *how well* (score, honestly — see `relevance.ts`), and *where it
 * is* (a link that reaches a real screen, or a stated reason there is none — see `links.ts`).
 * Enough of the chunk is shown to judge the answer without leaving the page, because a semantic
 * hit whose text is hidden behind a click is a hit the operator has to trust rather than assess.
 *
 * **The chunk text is rendered as text.** No highlighting: a vector match has no matched terms,
 * and inventing keyword marks on it would explain the match with a mechanism that did not produce
 * it. `whitespace-pre-wrap` keeps the source's own line breaks, which is most of what makes a
 * commit message or an ADR section readable.
 */

export function MemoryResults({
  results,
  minScore,
}: {
  results: readonly MemorySearchResult[];
  minScore: number;
}) {
  return (
    <ol className="flex flex-col gap-2">
      {results.map((result, index) => (
        <li key={result.memoryItemId}>
          <MemoryResultCard result={result} rank={index + 1} minScore={minScore} />
        </li>
      ))}
    </ol>
  );
}

export function MemoryResultCard({
  result,
  rank,
  minScore,
}: {
  result: MemorySearchResult;
  rank: number;
  minScore: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const clock = useLiveClock();
  const link = resultLink(result);
  const chunk = chunkLabel(result);

  return (
    <article
      className="rounded-md border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex flex-wrap items-start gap-3">
        {/* Rank is the one property of a compressed-score list that is unambiguously meaningful,
            so it leads. It is decorative for assistive tech — the list is already ordered. */}
        <span
          aria-hidden="true"
          className="font-mono text-2xs text-text-muted"
          style={{ width: 18 }}
        >
          {rank}.
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-sm text-text" title={result.title}>
            {link.to === null ? (
              result.title
            ) : (
              <Link to={link.to} className="rounded-xs" style={{ color: 'var(--color-accent)' }}>
                {result.title}
              </Link>
            )}
          </h3>

          <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
            <span>{sourceTypeLabel(result.sourceType)}</span>
            <TierBadge tier={result.tier} />
            {chunk === null ? null : <span>{chunk}</span>}
            {result.occurredAt === null ? null : (
              <span title={formatDateTime(result.occurredAt)}>
                {formatRelativePast(result.occurredAt, clock.now)}
              </span>
            )}
          </p>

          {/* A file-backed source has no row and no route; its path is its identity, so it is
              shown rather than replaced by a link that would go nowhere. */}
          {result.sourceRef === null ? null : (
            <p
              className="mt-1 truncate font-mono text-2xs text-text-secondary"
              title={result.sourceRef}
            >
              {result.sourceRef}
            </p>
          )}
        </div>

        <ScoreMeter score={result.score} minScore={minScore} />
      </div>

      <p
        className="mt-2 whitespace-pre-wrap rounded-sm p-2 text-text-secondary text-xs leading-150"
        style={{
          backgroundColor: 'var(--color-surface-inset)',
          ...(expanded
            ? {}
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 4,
                overflow: 'hidden',
              }),
        }}
      >
        {result.content}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="rounded-xs text-2xs text-text-muted underline decoration-dotted underline-offset-2"
          style={{ minHeight: 24 }}
        >
          {expanded ? 'Collapse chunk' : 'Show the whole chunk'}
        </button>

        {link.to === null ? null : (
          <Link
            to={link.to}
            className="rounded-xs text-2xs"
            style={{ color: 'var(--color-accent)', display: 'inline-flex', minHeight: 24 }}
          >
            {link.label} →
          </Link>
        )}

        {/* The honest half of `links.ts`: when the link lands one level away from the match, or
            when there is no link at all, the reason is on screen rather than in a comment. */}
        {link.reason === null ? null : (
          <span className="max-w-lg text-2xs text-text-muted leading-150">{link.reason}</span>
        )}
      </div>
    </article>
  );
}

/**
 * The tier, as a neutral chip.
 *
 * Deliberately **not** `StatusBadge`: that component is keyed verbatim to the six F7 session
 * states and its tokens (`--color-state-*`) mean "this Session is running / paused / failed". A
 * memory tier is a scope, not a lifecycle state, and borrowing the state ramp for it is exactly
 * the token misuse `theme.css` calls a review failure.
 */
function TierBadge({ tier }: { tier: MemoryTier }) {
  return (
    <span
      className="inline-flex items-center rounded-xs border border-border px-2 py-05 text-2xs"
      title={`${tier} tier`}
      style={{ color: 'var(--color-text-secondary)' }}
    >
      {tier}
    </span>
  );
}

/**
 * Score, printed raw and drawn against the floor. The reasoning lives in `relevance.ts`; what
 * matters here is that both channels are present — the number is not implied by the bar, and the
 * bar is not the only thing that separates a 0.55 from a 0.65.
 */
export function ScoreMeter({ score, minScore }: { score: number; minScore: number }) {
  const { fraction, aboveCeiling } = headroom(score, minScore);
  const description = describeScore(score, minScore);

  return (
    <div className="shrink-0 text-right" title={description}>
      <span className="font-mono text-sm text-text">{formatScore(score)}</span>
      <span className="sr-only"> — {description}</span>
      <span
        aria-hidden="true"
        className="mt-1 block overflow-hidden rounded-full"
        style={{ width: 72, height: 4, backgroundColor: 'var(--color-border)' }}
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: `${String(Math.round(fraction * 100))}%`,
            backgroundColor: aboveCeiling ? 'var(--color-accent)' : 'var(--color-info)',
          }}
        />
      </span>
      <span aria-hidden="true" className="mt-05 block text-2xs text-text-muted">
        {minScore.toFixed(2)}–{HEADROOM_CEILING.toFixed(2)}
      </span>
    </div>
  );
}
