import { MEMORY_SOURCE_LABELS, memorySourceLabel } from '../../lib/memory-sources.js';
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

/**
 * The source-type words live in `lib/memory-sources.ts`, not here: Settings → Memory renders a
 * toggle per source (PRD §4.4 item 4) and a feature slice may not import another one
 * (TDS 05 §2.1). Re-exported under their original names so every call site in this slice — and
 * this slice's suites — keeps reading `sourceTypeLabel`.
 */
export { MEMORY_SOURCE_LABELS as SOURCE_TYPE_LABELS, memorySourceLabel as sourceTypeLabel };

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
      return {
        to: null,
        label: 'Obsidian note',
        reason:
          'This lives in the Obsidian vault rather than in Mission Control; its path is shown ' +
          'above.',
      };

    /**
     * Repository documentation. It has a **path, not a row**: `sourceId` is null and `sourceRef`
     * is a repo-relative path, so there is nothing to build an id-shaped route from — and no
     * screen in this SPA renders a file's contents anyway.
     *
     * It is deliberately no longer folded in with `obsidian_note`. Both are file-backed, but the
     * files are in different places and the reason on the card is the operator's only instruction
     * for finding the thing: sending someone to their vault to look for `docs/tds/04-api.md` is a
     * wrong answer that looks like a right one. So the project's Repositories tab is the honest
     * destination — one level away, exactly like the unattributed-commit fallback above, and
     * labelled as the destination rather than as the match.
     */
    case 'document':
      return context.projectId === null
        ? {
            to: null,
            label: 'Document',
            reason:
              'This document is not attached to a project, so nothing in the app renders it. ' +
              'The path above is its whole address.',
          }
        : {
            to: `/projects/${context.projectId}?tab=repositories`,
            label: 'Open project → Repositories',
            reason:
              'Documentation is a file in the repository working tree, and no screen renders a ' +
              'file — the link reaches the repository it lives in; the path above locates it there.',
          };

    default:
      return {
        to: null,
        label: memorySourceLabel(result.sourceType),
        reason: 'This client has no screen for that source type.',
      };
  }
}

/**
 * The path shown on a file-backed card, and the full reference behind it.
 *
 * A `document`'s `source_ref` is `<repositoryId>/<repo-relative path>` — the id is in the key
 * because `ux_memory_items_source_ref_chunk` is unique over it and every repository has a
 * `README.md`. That prefix is a database concern: printed on the card it puts a 36-character
 * UUID in front of the only part an operator reads, and it is the part that makes the line wrap.
 * So the path is shown and the whole reference stays in the `title`, where nothing is lost.
 *
 * The split mirrors `parseDocumentSourceRef` in `@mc/shared`, which is not imported: it lives
 * under `packages/shared/src/memory/`, which the browser-safe `@mc/shared/types` entry does not
 * re-export (its siblings reach the database), and TDS 05 §2.1 holds the SPA to that entry.
 *
 * It is **stricter** than that function on purpose. `parseDocumentSourceRef` splits on the first
 * `/` because its callers already know the ref came from `documentSourceRef`; here the ref is
 * whatever a row happens to hold, and splitting a hand-written `docs/tds/04-api.md` would print
 * `tds/04-api.md` — a path that looks right and is not. So the prefix is trimmed only when it is
 * shaped like the id that put it there; anything else is rendered verbatim.
 */
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

export function displaySourceRef(result: MemorySearchResult): {
  readonly text: string;
  readonly title: string;
} | null {
  const ref = result.sourceRef;
  if (ref === null) return null;
  if (result.sourceType !== 'document') return { text: ref, title: ref };

  const prefix = UUID_PREFIX.exec(ref);
  if (prefix === null) return { text: ref, title: ref };
  const path = ref.slice(prefix[0].length);
  return path.length === 0 ? { text: ref, title: ref } : { text: path, title: ref };
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
