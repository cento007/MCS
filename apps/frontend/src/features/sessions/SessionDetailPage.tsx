import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { RouteSkeleton } from '../../components/Skeleton.js';
import { type ApiError, errorMessage, type Message, queryKeys } from '../../lib/api/index.js';
import { sessionIdTail } from '../../lib/format/index.js';
import { useConnectionStatus } from '../../lib/liveness.js';
import { useSessionChannel } from '../../lib/ws/context.js';
import { selectLiveSession, useLiveSessionStore } from '../../stores/live-session-store.js';
import { toast } from '../../stores/toast-store.js';
import { useUiStore } from '../../stores/ui-store.js';
import {
  composerMode,
  isComposerEnabled,
  isDocumentAction,
  overflowActions,
  type SessionActionDescriptor,
} from './actions.js';
import { ContextPackageDialog } from './ContextPackageDialog.js';
import { useSessionDocuments } from './documents.js';
import { LaunchSessionModal } from './LaunchSessionModal.js';
import { ANNOUNCEMENTS, useAnnouncer } from './live/announcements.js';
import { Composer } from './live/Composer.js';
import { Conversation } from './live/Conversation.js';
import {
  buildTranscript,
  isTurnInFlight,
  useOnChange,
  useSettlingTurn,
} from './live/transcript.js';
import {
  useInterruptMutation,
  useSessionActionMutation,
  useSubmitPrompt,
  useUpdateSession,
} from './mutations.js';
import { SessionPanel } from './panel/SessionPanel.js';
import { useRunningSessions, useSession, useSessionMessages } from './queries.js';
import { SessionHeader } from './SessionHeader.js';
import { SessionTabBar } from './SessionTabBar.js';

/**
 * `/sessions/:sessionId` — the Live Session view (TDS 05 §6, TDS 06 §5.5).
 *
 * This module is the wiring, not the rendering: it owns the four couplings that no child
 * component can own on its own.
 *
 *  1. **Open-set membership and the `session:{id}` subscription** (§6.5, §5.2).
 *  2. **The prompt pump** (§6.8): typing is never blocked, so a prompt submitted mid-turn is
 *     queued as a visibly-pending entry and delivered when the runtime goes idle. Nothing
 *     about that is optimistic — it becomes history only when the Backend says so.
 *  3. **`[Stop]`** (§6.8): the interrupt is fired here so it can retain the buffer and
 *     announce the stop, and so it can be bound to `Esc` *from the conversation region*.
 *  4. **Announcements** (§7.4): boundary events, one per event, into one polite region.
 */
export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const connection = useConnectionStatus();
  const isLive = connection === 'live';

  const openSession = useUiStore((state) => state.openSession);
  const closeSession = useUiStore((state) => state.closeSession);
  const draft = useUiStore((state) => state.composerDrafts[sessionId] ?? '');
  const setDraft = useUiStore((state) => state.setDraft);
  const clearDraft = useUiStore((state) => state.clearDraft);

  const entry = useLiveSessionStore((state) => selectLiveSession(state, sessionId));
  const clearActivity = useLiveSessionStore((state) => state.clearActivity);
  const queuePrompt = useLiveSessionStore((state) => state.queuePrompt);
  const updatePrompt = useLiveSessionStore((state) => state.updatePrompt);
  const removePrompt = useLiveSessionStore((state) => state.removePrompt);
  const terminateTurn = useLiveSessionStore((state) => state.terminateTurn);

  useSessionChannel(sessionId);

  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;
  const messagesQuery = useSessionMessages(sessionId);
  const running = useRunningSessions();

  const settlingTurn = useSettlingTurn(sessionId, entry.turn, messagesQuery.messages);
  const turnInFlight = isTurnInFlight(entry.turn);
  const streamInterrupted = !isLive && turnInFlight;

  const announcer = useAnnouncer();
  const [launchQueued, setLaunchQueued] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [confirming, setConfirming] = useState<SessionActionDescriptor | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const scrollToTimeRef = useRef<(isoTimestamp: string) => boolean>(() => false);

  const actionMutation = useSessionActionMutation(sessionId);
  const interruptMutation = useInterruptMutation(sessionId);
  const promptMutation = useSubmitPrompt(sessionId);
  const updateMutation = useUpdateSession(sessionId);

  // §6.7's two documents. Mounted unconditionally with whatever identity is known — the menu
  // entries that reach it do not exist until `session` has loaded, so the nulls are never read.
  const documents = useSessionDocuments({
    id: sessionId,
    title: session?.title ?? null,
    startedAt: session?.startedAt ?? null,
    createdAt: session?.createdAt ?? null,
  });

  // ---------------------------------------------------------------- open set (§6.5 / §3.4)

  const protectedSignature = (running.data ?? []).map((item) => item.id).join(',');
  useEffect(() => {
    const result = openSession(sessionId, {
      // §3.4 refines §6.5's eviction rule to "never a `running` one". F7 state is server
      // state, so the caller supplies it rather than `uiStore` guessing.
      protectedIds: protectedSignature.length === 0 ? [] : protectedSignature.split(','),
    });
    clearActivity(sessionId);

    if (result.evictedSessionId !== null) {
      const evicted = result.evictedSessionId;
      toast({
        kind: 'info',
        message: `Closed session ${sessionIdTail(evicted)} to make room (6 open maximum).`,
        action: {
          label: 'Undo',
          run: () => {
            openSession(evicted, { focus: false });
            closeSession(sessionId);
          },
        },
      });
    }
  }, [sessionId, openSession, clearActivity, closeSession, protectedSignature]);

  // ------------------------------------------------------------------- prompt pump (§6.8)

  const pumping = useRef(false);
  const nextQueued = entry.pendingPrompts.find((prompt) => prompt.status === 'queued') ?? null;

  useEffect(() => {
    if (session?.state !== 'running' || turnInFlight || nextQueued === null || pumping.current) {
      return;
    }
    pumping.current = true;
    const clientRef = nextQueued.clientRef;
    updatePrompt(sessionId, clientRef, { status: 'sending', error: null });

    void promptMutation
      .mutateAsync({ content: nextQueued.content })
      .then(async () => {
        // Retire the pending entry only once the canonical Message is actually in the cache.
        // Removing it on the `202` alone blanks the operator's own words for a round trip —
        // the same "never blank the transcript" rule the streaming layer follows (§6.2).
        await queryClient.refetchQueries({ queryKey: queryKeys.sessions.messages(sessionId) });
        removePrompt(sessionId, clientRef);
      })
      .catch((error: unknown) => {
        // §11.3: never converted into fake history — marked with retry/discard, in place.
        updatePrompt(sessionId, clientRef, {
          status: 'failed',
          error: errorMessage(error),
        });
      })
      .finally(() => {
        pumping.current = false;
      });
  }, [
    session?.state,
    turnInFlight,
    nextQueued,
    sessionId,
    updatePrompt,
    removePrompt,
    promptMutation,
    queryClient,
  ]);

  // Clear the "queued for launch" affordance the moment the Session actually moves (§6.2.1).
  useEffect(() => {
    if (session?.state === 'running') setLaunchQueued(false);
  }, [session?.state]);

  // ----------------------------------------------------------------- announcements (§7.4)

  const lastTurnToolCalls = useRef(0);
  const lastTerminationReason = useRef<string | null>(null);
  if (entry.turn !== null) {
    lastTurnToolCalls.current = entry.turn.blocks.filter(
      (block) => block.kind === 'tool_use',
    ).length;
    lastTerminationReason.current = entry.turn.termination?.reason ?? null;
  }

  useOnChange(turnInFlight, (inFlight, previous) => {
    if (previous === undefined) return;
    if (inFlight) {
      announcer.announce(ANNOUNCEMENTS.turnStarted);
    } else if (lastTerminationReason.current === 'interrupted') {
      announcer.announce(ANNOUNCEMENTS.turnStopped);
    } else {
      announcer.announce(ANNOUNCEMENTS.turnComplete(lastTurnToolCalls.current));
    }
  });

  useOnChange(session?.state ?? null, (state, previous) => {
    if (previous === undefined || previous === null || state === null) return;
    if (state === 'failed' || state === 'completed' || state === 'paused') {
      announcer.announce(ANNOUNCEMENTS.sessionState(state));
    }
  });

  useOnChange(streamInterrupted, (interrupted, previous) => {
    if (previous === undefined || !interrupted) return;
    announcer.announce(ANNOUNCEMENTS.streamInterrupted);
  });

  // ------------------------------------------------------------------------------ actions

  const runAction = useCallback(
    (action: SessionActionDescriptor) => {
      // §6.7 documents are not lifecycle actions: no F7 transition, no `session.state_changed`,
      // and an answer that is a document rather than a Session. They leave before
      // `pendingActionId` is touched, so generating a package never disables the header row.
      if (isDocumentAction(action.id)) {
        documents.run(action.id);
        return;
      }

      setPendingActionId(action.id);

      if (action.id === 'stop') {
        void interruptMutation
          .mutateAsync()
          .then(() => {
            // §6.2 case 4: the buffer is retained and marked until the canonical interrupted
            // Message arrives and replaces it. `[Stop]` performs no F7 transition, so nothing
            // here touches Session state.
            terminateTurn(sessionId, {
              reason: 'interrupted',
              at: Date.now(),
              errorCode: null,
              requestId: null,
            });
            announcer.announce(ANNOUNCEMENTS.turnStopped);
          })
          .finally(() => setPendingActionId(null));
        return;
      }

      void actionMutation
        .mutateAsync({ action: action.id })
        .then((outcome) => {
          if (outcome.launch === 'queued') setLaunchQueued(true);
          if (outcome.session.id !== sessionId) {
            // Resume-as-new and clone produce a NEW Session record (F7). The UI follows it —
            // leaving the operator on the old record would make the action look like a no-op.
            void navigate(`/sessions/${outcome.session.id}`);
          }
        })
        .catch(() => {
          // The toast is raised by the mutation; refetching re-derives the UI from server
          // truth, which is what makes an `INVALID_STATE_TRANSITION` self-correcting.
          void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
        })
        .finally(() => setPendingActionId(null));
    },
    [
      actionMutation,
      documents,
      interruptMutation,
      navigate,
      queryClient,
      sessionId,
      terminateTurn,
      announcer,
    ],
  );

  const onAction = useCallback(
    (action: SessionActionDescriptor) => {
      if (action.confirm === undefined) {
        runAction(action);
        return;
      }
      setConfirming(action);
    },
    [runAction],
  );

  // ----------------------------------------------------------------------------- composer

  const mode = session === undefined ? 'prompt' : composerMode(session);

  const submitPrompt = useCallback(() => {
    const content = draft.trim();
    if (content.length === 0 || session === undefined) return;

    const clientRef = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    queuePrompt(sessionId, {
      clientRef,
      content,
      status: 'queued',
      error: null,
      submittedAt: Date.now(),
    });
    clearDraft(sessionId);

    if (turnInFlight) announcer.announce(ANNOUNCEMENTS.promptQueued);

    if (session.state === 'created') {
      // Start-with-prompt: one operator action, one pending state (§6.6). The pump delivers
      // the queued prompt the moment the Session reports `running`.
      setPendingActionId('start');
      void actionMutation
        .mutateAsync({ action: 'start' })
        .then((outcome) => {
          if (outcome.launch === 'queued') setLaunchQueued(true);
        })
        .catch(() => {
          // §11.3: a failure leaves the prompt text in the composer. The operator's words are
          // never silently discarded, and never left looking delivered.
          removePrompt(sessionId, clientRef);
          setDraft(sessionId, content);
        })
        .finally(() => setPendingActionId(null));
    }
  }, [
    draft,
    session,
    sessionId,
    queuePrompt,
    clearDraft,
    turnInFlight,
    announcer,
    actionMutation,
    removePrompt,
    setDraft,
  ]);

  const undeliveredPrompts = useMemo(
    () => undeliveredUserPrompts(messagesQuery.messages),
    [messagesQuery.messages],
  );

  /*
   * The §5.5 failure banner reads its reason from `session.failureReason` inside `Composer`,
   * so there is no failure plumbing here any more.
   *
   * This used to eagerly fetch the timeline for a `failed` Session and dig the reason out of
   * the `session.state_changed` payload — the only source the client had while the column was
   * stored but not serialized. Both are written from the same argument in the same
   * transaction (`state-machine.ts`), so the resource is the same answer without the request,
   * and one fact now has one source.
   */

  const transcript = useMemo(
    () =>
      buildTranscript({
        messages: messagesQuery.messages,
        turn: entry.turn,
        settlingTurn,
        pendingPrompts: entry.pendingPrompts,
      }),
    [messagesQuery.messages, entry.turn, entry.pendingPrompts, settlingTurn],
  );

  const tail = useMemo(() => transcript.filter((item) => item.kind !== 'message'), [transcript]);

  const onScrollHandle = useCallback((fn: (isoTimestamp: string) => boolean) => {
    scrollToTimeRef.current = fn;
  }, []);

  const scrollToTime = useCallback(
    (isoTimestamp: string) => scrollToTimeRef.current(isoTimestamp),
    [],
  );

  // ------------------------------------------------------------------------------ render

  if (sessionQuery.isPending) return <RouteSkeleton />;

  if (sessionQuery.isError || session === undefined) {
    return (
      <div className="p-6">
        <ErrorPanel
          error={sessionQuery.error as ApiError}
          title={`Session ${sessionIdTail(sessionId)} could not be loaded`}
          onRetry={() => void sessionQuery.refetch()}
        />
      </div>
    );
  }

  return (
    // `h-full`, not just `flex-1`: the shell's `<main>` is a block, so a flex-1 child of it
    // sizes to its content and the conversation would collapse to the height of its messages —
    // leaving the composer floating under a short transcript instead of pinned to the bottom.
    <div className="flex h-full min-h-0 flex-col">
      <SessionTabBar onLaunch={() => setLaunchOpen(true)} />

      {isLive ? null : (
        <p
          role="status"
          className="px-4 py-1 text-2xs"
          style={{ backgroundColor: 'var(--color-warning-subtle)', color: 'var(--color-warning)' }}
        >
          Reconnecting… live updates paused. Durations and state marks show their last known values.
        </p>
      )}

      <SessionHeader
        session={session}
        turnInFlight={turnInFlight}
        onAction={onAction}
        pendingActionId={pendingActionId}
        onRename={(title) => updateMutation.mutate({ title })}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* `Esc` from the conversation region stops an in-flight turn (§6.8). From the
              composer, `Esc` first returns focus *here*, so a single stray `Esc` while typing
              can never kill a turn and a second deliberate one always can. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the focus host for the conversation region, not a control — the labelled landmark is the <section> the child renders, and `Esc` must be catchable from anywhere inside it */}
          <div
            ref={conversationRef}
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col outline-none"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !turnInFlight) return;
              event.preventDefault();
              onAction({
                id: 'stop',
                label: 'Stop',
                emphasis: 'warning',
              });
            }}
          >
            <Conversation
              messages={messagesQuery.messages}
              tail={tail}
              streamInterrupted={streamInterrupted}
              hasOlder={messagesQuery.hasOlder}
              isFetchingOlder={messagesQuery.isFetchingOlder}
              fetchOlder={messagesQuery.fetchOlder}
              isPending={messagesQuery.isPending}
              onDiscardPrompt={(clientRef) => removePrompt(sessionId, clientRef)}
              onRetryPrompt={(clientRef) =>
                updatePrompt(sessionId, clientRef, { status: 'queued', error: null })
              }
              announcement={announcer.message}
              announcementNonce={announcer.nonce}
              onScrollHandle={onScrollHandle}
            />
          </div>

          <Composer
            session={session}
            mode={mode}
            value={draft}
            onChange={(value) => setDraft(sessionId, value)}
            onSubmit={submitPrompt}
            onEscape={() => conversationRef.current?.focus()}
            launchQueued={launchQueued}
            submitting={pendingActionId === 'start' || promptMutation.isPending}
            undeliveredPrompts={isComposerEnabled(mode) ? [] : undeliveredPrompts}
            onRestorePrompt={(content) => setDraft(sessionId, content)}
            terminalActions={overflowActions(session)}
            onAction={onAction}
          />
        </div>

        <SessionPanel
          session={session}
          scrollToTime={scrollToTime}
          onSaveNotes={(notes) => updateMutation.mutate({ notes })}
          savingNotes={updateMutation.isPending}
        />
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.confirm?.title ?? ''}
        body={confirming?.confirm?.body ?? ''}
        confirmLabel={confirming?.confirm?.confirmLabel ?? 'Confirm'}
        destructive={confirming?.confirm?.destructive ?? false}
        pending={pendingActionId !== null}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action !== null) runAction(action);
        }}
        onCancel={() => setConfirming(null)}
      />

      <ContextPackageDialog documents={documents} />

      <LaunchSessionModal open={launchOpen} onClose={() => setLaunchOpen(false)} />
    </div>
  );
}

/**
 * Prompts the Backend persisted but never transmitted (§6.4/§6.6 `status: 'pending'`).
 *
 * They are offered back to the composer for **explicit** re-send and are never auto-replayed:
 * a prompt the operator wrote before a pause may be exactly the wrong thing to send after it.
 */
export function undeliveredUserPrompts(messages: readonly Message[]): readonly string[] {
  return messages
    .filter((message) => message.role === 'user' && message.status === 'pending')
    .map((message) =>
      message.content
        .filter((block) => block['type'] === 'text')
        .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
        .join('\n'),
    )
    .filter((content) => content.trim().length > 0);
}
