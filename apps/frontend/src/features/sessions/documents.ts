import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { type ApiError, apiSend, endpoints, errorMessage, queryKeys } from '../../lib/api/index.js';
import { downloadTextFile, safeFilename } from '../../lib/download.js';
import { toast } from '../../stores/toast-store.js';
import type { SessionDocumentActionId } from './actions.js';

/**
 * `POST /sessions/{id}/export` and `POST /sessions/{id}/context-package` (TDS 04 §6.7).
 *
 * The shapes are hand-written against `apps/backend/src/sessions/export/`, and they live in the
 * feature slice rather than `lib/api/types.ts` for the reason `features/memory/types.ts` gives
 * for the same choice: `openapi.yaml` is generated from the Fastify *request* schemas, and
 * neither of these routes declares a response, so nothing can be generated for them yet. Keeping
 * the provisional copy here makes the seam obvious.
 *
 * Three properties of this module are decisions rather than defaults:
 *
 *  1. **Neither action is a lifecycle action.** They answer with a document, not a Session, so
 *     they never touch `mutations.ts` — see the type split in `actions.ts`.
 *  2. **The export is assembled into a file *here*, from JSON.** The Backend deliberately does
 *     not send `Content-Disposition`; `lib/download.ts` carries the whole argument.
 *  3. **A degraded context package is detected from `relatedContext.gapReason`, never from the
 *     Markdown.** The field exists precisely so no UI has to regex prose to find out whether the
 *     document it just produced is whole.
 */

/** `SessionExportDocument` in `export/render.ts`. `format` is an enum of one today. */
export interface SessionExportDocument {
  readonly format: string;
  /** The server's suggested name: deterministic in the Session, so a re-export replaces. */
  readonly filename: string;
  readonly content: string;
}

/**
 * `RelatedGapReason` in `export/package.ts`, verbatim — plus `(string & {})`, the same
 * version-tolerance `ErrorCode` uses. A Backend that grows a ninth reason must render as a badge
 * with an unfamiliar label, not as a package that looks complete.
 */
export type ContextGapReason =
  | 'not_configured'
  | 'unavailable'
  | 'stamp_mismatch'
  | 'index_empty'
  | 'below_threshold'
  | 'timed_out'
  | 'no_query'
  | 'only_own_session'
  | (string & {});

export interface ContextPackageRelated {
  readonly resultCount: number;
  /** `null` **only** when semantic memory answered. Anything else is a named, visible gap. */
  readonly gapReason: ContextGapReason | null;
  readonly gapDetail: string | null;
  readonly embeddingModel: string | null;
}

export interface ContextPackage {
  readonly content: string;
  /** An estimate from `bytes`; `bytes` is the fact. Both are shown — the artifact is for pasting. */
  readonly tokenEstimate: number;
  readonly bytes: number;
  readonly generatedAt: string;
  readonly relatedContext: ContextPackageRelated;
}

/**
 * One actionable line per gap.
 *
 * Keyed by `string` rather than by the union so an unknown reason falls back to its own wire
 * name instead of failing to compile against a Backend that has moved on. The badge is the only
 * signal an operator gets that a package is short a section, so an unfamiliar reason must still
 * produce one.
 */
const GAP_LABELS: Readonly<Record<string, string>> = {
  not_configured: 'no embedding model configured',
  unavailable: 'the embedding service could not be reached',
  stamp_mismatch: 'the stored vectors were built by a different model',
  index_empty: 'nothing is indexed yet',
  below_threshold: 'nothing scored above the relevance floor',
  timed_out: 'semantic retrieval ran out of time',
  no_query: 'this session has no title and no prompt to search with',
  only_own_session: 'every match was this session’s own transcript',
};

export function contextGapLabel(reason: ContextGapReason): string {
  return GAP_LABELS[reason] ?? reason;
}

/**
 * The Session facts a document needs — deliberately four nullable fields rather than a `Session`.
 *
 * The list-row menu holds a whole Session it never fully renders, and the detail screen mounts
 * this hook before its Session query resolves; a narrow, tolerant shape serves both without
 * either one faking a Session it does not have.
 */
export interface DocumentSession {
  readonly id: string;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly createdAt: string | null;
}

/**
 * `context-package-2026-08-13-8b1c4f-Refactor-the-queue-port.md`.
 *
 * §6.7 gives the context package no `filename` — unlike the export, which carries the server's
 * own. Reproducing the export's rule client-side keeps the two artifacts of one Session next to
 * each other in a Downloads folder, and keeps regeneration idempotent rather than `(1)`-suffixed.
 */
export function contextPackageFilename(session: DocumentSession): string {
  const day = (session.startedAt ?? session.createdAt ?? '').slice(0, 10);
  return safeFilename(['context-package', day, session.id.slice(-6), session.title ?? ''], '.md');
}

/**
 * What to say when a document is refused.
 *
 * The `409` is the case worth handling by name. It is reachable in exactly one way — the Session
 * is still in `created` — and the menu already gates on that, so an arriving 409 means the cached
 * Session was stale (another tab, another client, a page left open across a restart). Quoting
 * `details.state` turns "Conflict" into the sentence that explains it, and the refetch that
 * follows repairs the menu.
 */
export function describeDocumentFailure(error: ApiError): { message: string; detail: string } {
  const state = typeof error.details?.['state'] === 'string' ? error.details['state'] : null;
  const message =
    state === null ? errorMessage(error) : `${errorMessage(error)} (the session is ${state}).`;
  const detail = error.requestId === null ? error.code : `${error.code} · ${error.requestId}`;
  return { message, detail };
}

export interface SessionDocumentsController {
  /** Fire one of the two §6.7 documents. Non-optimistic: nothing appears until the Backend answers. */
  readonly run: (action: SessionDocumentActionId) => void;
  /** The action in flight, if any. `context-package` opens its dialog on this alone. */
  readonly pendingId: SessionDocumentActionId | null;
  /** The generated package, held until the operator dismisses it. `null` = nothing to show. */
  readonly contextPackage: ContextPackage | null;
  readonly dismiss: () => void;
  readonly session: DocumentSession;
}

/**
 * The one execution path for both documents, mountable on any surface that offers them.
 *
 * Export needs no surface at all — it is a file — so it reports through a toast and is done. The
 * context package is a document to *read*: it is held in state and handed to
 * `ContextPackageDialog`, which also opens on `pendingId` alone. That second part is not
 * decoration. `service.ts` budgets 25 s for semantic retrieval and 10 s for `git status`, and the
 * menu item that started the generation has already closed — so without an immediately-opened
 * surface the operator gets nothing at all for up to half a minute, which reads as a dead menu
 * entry and invites a second click.
 */
export function useSessionDocuments(session: DocumentSession): SessionDocumentsController {
  const queryClient = useQueryClient();
  const [contextPackage, setContextPackage] = useState<ContextPackage | null>(null);

  /**
   * Does the operator still want the package that is being generated?
   *
   * Closing the dialog mid-generation abandons the result rather than letting it re-open the
   * dialog half a minute later, on top of whatever the operator moved on to. The request is not
   * cancelled — the Backend finishes and the answer is dropped — because §6.7 has no idempotency
   * cost worth a cancellation protocol here.
   */
  const wanted = useRef(false);

  const exportMutation = useMutation<SessionExportDocument, ApiError, void>({
    retry: false,
    mutationFn: () =>
      // An explicit body rather than none: the route's schema accepts `null`, but a `POST` with
      // no `content-type` at all depends on server-side parser behaviour to arrive as one, and
      // `format` has exactly one legal value so naming it costs nothing and asserts the contract.
      apiSend<SessionExportDocument>('POST', endpoints.sessions.export(session.id), {
        body: { format: 'markdown' },
      }),
    onSuccess: (document) => {
      downloadTextFile({ filename: document.filename, content: document.content });
      toast({ kind: 'success', message: `Exported ${document.filename}` });
    },
  });

  const packageMutation = useMutation<ContextPackage, ApiError, void>({
    retry: false,
    mutationFn: () =>
      apiSend<ContextPackage>('POST', endpoints.sessions.contextPackage(session.id), { body: {} }),
    onSuccess: (result) => {
      if (wanted.current) setContextPackage(result);
    },
  });

  const pendingId: SessionDocumentActionId | null = exportMutation.isPending
    ? 'export'
    : packageMutation.isPending
      ? 'context-package'
      : null;

  const run = useCallback(
    (action: SessionDocumentActionId) => {
      // A second click while one is in flight would spend another embedding call and another
      // `git status` on a document the first click is already producing.
      if (exportMutation.isPending || packageMutation.isPending) return;

      if (action === 'context-package') wanted.current = true;

      const mutation = action === 'export' ? exportMutation : packageMutation;
      mutation.mutate(undefined, {
        // §11.1: a failed mutation with no more specific inline surface is a toast, and it is
        // never swallowed. There is no inline surface here — the menu item that started this is
        // already closed by the time the answer lands.
        onError: (error) => {
          const { message, detail } = describeDocumentFailure(error);
          toast({ kind: 'danger', message, detail });

          // A `409` means the cached Session is stale — the menu offered an action the Backend
          // refuses for this state. Refetching re-derives the menu from server truth, the same
          // self-correction `SessionDetailPage` applies to `INVALID_STATE_TRANSITION`.
          if (error.status === 409) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.sessions.detail(session.id),
            });
          }
        },
      });
    },
    [exportMutation, packageMutation, queryClient, session.id],
  );

  const dismiss = useCallback(() => {
    wanted.current = false;
    setContextPackage(null);
  }, []);

  return { run, pendingId, contextPackage, dismiss, session };
}
