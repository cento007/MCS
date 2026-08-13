import type { MemorySourceType } from '@mc/shared/types';
import type { MemorySearchResult } from './types.js';

/**
 * Turning a memory hit into somewhere the operator can actually go.
 *
 * This is the reason `MemorySearchResult.context` exists at all. TDS 05 §2.2 has pages for
 * Sessions, Projects and ADRs and for nothing else: **there is no `/commits/:id` and no
 * `/pull-requests/:id`**, and a Message is rendered inside its Session rather than on a route of
 * its own. The Phase 2 search learned this the hard way — three of its five result types were
 * unclickable because an id alone cannot build a link — so the memory contract carries
 * `projectId` / `repositoryId` / `sessionId` alongside the match.
 *
 * Two rules govern what comes out of here, and they are the difference between a useful link and
 * a dishonest one:
 *
 *  1. **The label names the destination, not the match.** A commit hit with no session
 *     attribution links to the Project's Repositories tab, and the link says so. Labelling that
 *     "Open commit" would promise a commit page that does not exist and never opens.
 *  2. **No link is better than a wrong one.** A vault note has no in-app route; it renders its
 *     path as text with the reason attached, rather than a dead click or a link to `/memory`.
 */

export interface ResultLink {
  /** The in-app route, or `null` when nothing in this SPA renders the thing that matched. */
  readonly to: string | null;
  /** What the link says it opens. Always the destination's own name. */
  readonly label: string;
  /**
   * Why the link is absent, or why it lands one level away from the match. `null` when the link
   * reaches the matched thing exactly.
   */
  readonly reason: string | null;
}

export const SOURCE_TYPE_LABELS: Readonly<Record<MemorySourceType, string>> = {
  session: 'Session',
  commit: 'Commit',
  adr: 'ADR',
  obsidian_note: 'Obsidian note',
  pull_request: 'Pull request',
  document: 'Document',
};

export function sourceTypeLabel(sourceType: string): string {
  return SOURCE_TYPE_LABELS[sourceType as MemorySourceType] ?? sourceType;
}

export function resultLink(result: MemorySearchResult): ResultLink {
  const { context } = result;

  switch (result.sourceType) {
    case 'session': {
      // `context.sessionId` is the Session's own id for a session-tier chunk; `sourceId` is the
      // same value from the row. Either is exact.
      const sessionId = context.sessionId ?? result.sourceId;
      return sessionId === null
        ? { to: null, label: 'Session', reason: 'This chunk no longer names a session.' }
        : { to: `/sessions/${sessionId}`, label: 'Open session', reason: null };
    }

    case 'adr':
      return result.sourceId === null
        ? { to: null, label: 'ADR', reason: 'This chunk no longer names an ADR.' }
        : { to: `/adrs/${result.sourceId}`, label: 'Open ADR', reason: null };

    case 'commit': {
      // A commit attributed to a Session is reachable exactly: the Session's Commits panel lists
      // it, and `?panel=` is how that panel is linked (TDS 05 §6.7).
      if (context.sessionId !== null) {
        return {
          to: `/sessions/${context.sessionId}?panel=commits`,
          label: 'Open session → Commits',
          reason: null,
        };
      }
      if (context.projectId !== null) {
        return {
          to: `/projects/${context.projectId}?tab=repositories`,
          label: 'Open project → Repositories',
          reason:
            'There is no route for a single commit, and this one is not attributed to a ' +
            'session — the link reaches the repository it belongs to.',
        };
      }
      return {
        to: null,
        label: 'Commit',
        reason: 'This commit is not attached to a project, so nothing in the app renders it.',
      };
    }

    case 'pull_request':
      return context.projectId === null
        ? {
            to: null,
            label: 'Pull request',
            reason: 'This pull request is not attached to a project.',
          }
        : {
            to: `/projects/${context.projectId}?tab=repositories`,
            label: 'Open project → Repositories',
            reason:
              'Pull requests have no screen of their own yet — the read route ' +
              '`GET /repositories/{id}/pull-requests` is specified but unbuilt — so the link ' +
              'reaches the repository instead.',
          };

    case 'obsidian_note':
    case 'document':
      return {
        to: null,
        label: sourceTypeLabel(result.sourceType),
        reason:
          'This lives in the Obsidian vault rather than in Mission Control; its path is shown ' +
          'above.',
      };

    default:
      return {
        to: null,
        label: sourceTypeLabel(result.sourceType),
        reason: 'This client has no screen for that source type.',
      };
  }
}

/**
 * The stable identity of a hit, for `key` and for the "which chunk" line.
 *
 * `memoryItemId` alone would be enough for React, but two chunks of one document must be
 * distinguishable to a *person* as well — "4 of 9" is what makes a long-document hit meaningful
 * rather than mysteriously partial.
 */
export function chunkLabel(result: MemorySearchResult): string | null {
  if (result.chunkCount <= 1) return null;
  return `chunk ${String(result.chunkOrdinal + 1)} of ${String(result.chunkCount)}`;
}
