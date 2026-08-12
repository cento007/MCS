import { create } from 'zustand';

/**
 * `liveSessionStore` — the streaming layer (TDS 05 §3, §6.1–§6.5).
 *
 * A **registry keyed by Session id**: each open Session owns an independent turn buffer,
 * pending-prompt list and activity counter. Nothing is global-per-"current session", which
 * is what makes concurrent A/B/C monitoring (PRD §4.2) work — switching Sessions is a route
 * change, and buffers survive because they live here, not in a component.
 *
 * Two rules from §6.2 are structural, not incidental:
 *
 *  - **Deltas never touch the query cache.** They append/patch a buffer and render one
 *    component. Invalidating per token would issue a REST refetch per character.
 *  - **A partial buffer is never discarded merely because the stream stopped.** The partial
 *    output is the most diagnostic artifact a failed session leaves behind, so `terminate`
 *    marks it and keeps it; only a canonical Message (`commit`) replaces it.
 *
 * Writes are batched to an animation frame. A fast token stream then costs ~60 renders/s on
 * one component instead of one render per delta.
 */

export type LiveBlockKind = 'text' | 'thinking' | 'tool_use' | 'unknown';

export interface LiveBlock {
  readonly index: number;
  readonly kind: LiveBlockKind;
  /** Accumulated text for `text`/`thinking` blocks. */
  readonly text: string;
  /** Accumulated `input_json_delta` fragments — parsed by the renderer, not here. */
  readonly partialJson: string;
  readonly complete: boolean;
}

export type LiveTurnStatus =
  /** Deltas are still expected. */
  | 'streaming'
  /** The runtime signalled the end of the turn; awaiting the canonical Message. */
  | 'awaiting_commit'
  /** The stream died (failure, disconnect, interrupt). Retained and read-only (§6.2). */
  | 'terminated';

export interface LiveTurn {
  readonly sessionId: string;
  /** Server-assigned Message id, once the runtime has told us one. */
  readonly messageId: string | null;
  readonly blocks: readonly LiveBlock[];
  readonly status: LiveTurnStatus;
  /** Why a terminated turn ended — rendered as the §6.2 rule line. */
  readonly termination: TurnTermination | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface TurnTermination {
  readonly reason: 'failed' | 'disconnected' | 'interrupted';
  readonly at: number;
  readonly errorCode: string | null;
  readonly requestId: string | null;
}

export type PendingPromptStatus = 'queued' | 'sending' | 'failed';

export interface PendingPrompt {
  /** Client-generated correlation, distinct from any Message id. */
  readonly clientRef: string;
  readonly content: string;
  readonly status: PendingPromptStatus;
  readonly error: string | null;
  readonly submittedAt: number;
}

export interface LiveSessionEntry {
  readonly turn: LiveTurn | null;
  readonly pendingPrompts: readonly PendingPrompt[];
  /** New committed Messages since the Session was last focused; display caps at `9+`. */
  readonly activityCount: number;
  /** True while the Session has activity the operator has not looked at. */
  readonly unread: boolean;
  readonly lastActivityAt: number | null;
}

/** §6.5 — background buffers are bounded; the committed history is the durable record. */
export const MAX_LIVE_BLOCKS = 200;

/** The §14.5 delta payload, verbatim. Unknown values are tolerated, never thrown on. */
export interface DeltaPayload {
  readonly sessionId: string;
  readonly messageId?: string | null;
  readonly blockIndex?: number | null;
  readonly deltaType?: string | null;
  readonly text?: string | null;
  readonly partialJson?: string | null;
  readonly streamEventType?: string | null;
}

export interface LiveSessionStoreState {
  readonly sessions: Readonly<Record<string, LiveSessionEntry>>;

  /** Apply one `session.message.delta_appended` payload. Batched to the next frame. */
  applyDelta(payload: DeltaPayload): void;
  /** Replace a buffer with server truth (`session.message.appended` for that turn). */
  commitTurn(sessionId: string, messageId: string | null): void;
  /** Retain and mark a partial turn (§6.2) — never blanks it. */
  terminateTurn(sessionId: string, termination: TurnTermination): void;

  queuePrompt(sessionId: string, prompt: PendingPrompt): void;
  updatePrompt(sessionId: string, clientRef: string, patch: Partial<PendingPrompt>): void;
  removePrompt(sessionId: string, clientRef: string): void;

  /** Count a committed Message / tool call / state change while the Session is not focused. */
  noteActivity(sessionId: string, at?: number): void;
  /** Focusing a Session clears its dot and counter (§6.5). */
  clearActivity(sessionId: string): void;

  /** Drop everything for one Session — closing a switcher entry. */
  dropSession(sessionId: string): void;
  reset(): void;
}

const EMPTY_ENTRY: LiveSessionEntry = Object.freeze({
  turn: null,
  pendingPrompts: [],
  activityCount: 0,
  unread: false,
  lastActivityAt: null,
});

export function emptyLiveSessionEntry(): LiveSessionEntry {
  return EMPTY_ENTRY;
}

// ------------------------------------------------------------------------ frame batching

type FlushScheduler = (flush: () => void) => void;

const defaultScheduler: FlushScheduler = (flush) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => flush());
    return;
  }
  setTimeout(flush, 16);
};

let scheduler: FlushScheduler = defaultScheduler;

/**
 * Swap the flush scheduler. Tests pass a synchronous one so a delta is observable on the
 * next line instead of on the next frame; nothing else should call this.
 */
export function setLiveFlushScheduler(next: FlushScheduler | null): void {
  scheduler = next ?? defaultScheduler;
}

/** Mutable drafts, deliberately outside the store: they change per token. */
interface DraftBlock {
  index: number;
  kind: LiveBlockKind;
  text: string;
  partialJson: string;
  complete: boolean;
}

interface DraftTurn {
  sessionId: string;
  messageId: string | null;
  blocks: DraftBlock[];
  status: LiveTurnStatus;
  termination: TurnTermination | null;
  startedAt: number;
  updatedAt: number;
}

const drafts = new Map<string, DraftTurn>();
const dirty = new Set<string>();
let flushScheduled = false;

function blockKind(deltaType: string | null | undefined): LiveBlockKind {
  switch (deltaType) {
    case 'text_delta':
      return 'text';
    case 'thinking_delta':
      return 'thinking';
    case 'input_json_delta':
      return 'tool_use';
    default:
      // Forward-compatible per §6.2: an unrecognised block type is opaque, not an error.
      return 'unknown';
  }
}

function freezeTurn(draft: DraftTurn): LiveTurn {
  return {
    sessionId: draft.sessionId,
    messageId: draft.messageId,
    blocks: draft.blocks.map((block) => ({ ...block })),
    status: draft.status,
    termination: draft.termination,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
  };
}

export const useLiveSessionStore = create<LiveSessionStoreState>((set, get) => {
  const flush = (): void => {
    flushScheduled = false;
    if (dirty.size === 0) return;
    const touched = [...dirty];
    dirty.clear();

    set((previous) => {
      const sessions = { ...previous.sessions };
      for (const sessionId of touched) {
        const draft = drafts.get(sessionId);
        const entry = sessions[sessionId] ?? EMPTY_ENTRY;
        sessions[sessionId] = { ...entry, turn: draft === undefined ? null : freezeTurn(draft) };
      }
      return { sessions };
    });
  };

  const markDirty = (sessionId: string): void => {
    dirty.add(sessionId);
    if (flushScheduled) return;
    flushScheduled = true;
    scheduler(flush);
  };

  const patchEntry = (
    sessionId: string,
    patch: (entry: LiveSessionEntry) => LiveSessionEntry,
  ): void =>
    set((previous) => ({
      sessions: {
        ...previous.sessions,
        [sessionId]: patch(previous.sessions[sessionId] ?? EMPTY_ENTRY),
      },
    }));

  return {
    sessions: {},

    applyDelta: (payload) => {
      const sessionId = payload.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      const now = Date.now();

      let draft = drafts.get(sessionId);
      if (draft === undefined || draft.status === 'terminated') {
        // A retained (terminated) turn is read-only — a new stream starts a new buffer
        // rather than resurrecting one the operator has already been told ended.
        draft = {
          sessionId,
          messageId: payload.messageId ?? null,
          blocks: [],
          status: 'streaming',
          termination: null,
          startedAt: now,
          updatedAt: now,
        };
        drafts.set(sessionId, draft);
      }

      if (payload.messageId != null) draft.messageId = payload.messageId;
      draft.updatedAt = now;

      const index = typeof payload.blockIndex === 'number' ? payload.blockIndex : 0;
      const streamEventType = payload.streamEventType ?? 'content_block_delta';

      if (streamEventType === 'message_stop') {
        draft.status = 'awaiting_commit';
        markDirty(sessionId);
        return;
      }
      if (streamEventType === 'message_start' || streamEventType === 'message_delta') {
        draft.status = 'streaming';
        markDirty(sessionId);
        return;
      }

      let block = draft.blocks.find((candidate) => candidate.index === index);
      if (block === undefined) {
        block = {
          index,
          kind: blockKind(payload.deltaType),
          text: '',
          partialJson: '',
          complete: false,
        };
        draft.blocks.push(block);
        draft.blocks.sort((a, b) => a.index - b.index);
        if (draft.blocks.length > MAX_LIVE_BLOCKS)
          draft.blocks.splice(0, draft.blocks.length - MAX_LIVE_BLOCKS);
      } else if (block.kind === 'unknown' && payload.deltaType != null) {
        block.kind = blockKind(payload.deltaType);
      }

      if (streamEventType === 'content_block_stop') {
        block.complete = true;
      } else {
        if (typeof payload.text === 'string') block.text += payload.text;
        if (typeof payload.partialJson === 'string') block.partialJson += payload.partialJson;
      }

      markDirty(sessionId);
    },

    commitTurn: (sessionId, messageId) => {
      const draft = drafts.get(sessionId);
      // §6.2: the committed Message wins ONLY when it is the turn we were streaming. A
      // late `appended` for some other Message must not blank an in-flight buffer.
      if (
        draft !== undefined &&
        (messageId === null || draft.messageId === null || draft.messageId === messageId)
      ) {
        drafts.delete(sessionId);
        dirty.delete(sessionId);
      }
      patchEntry(sessionId, (entry) => ({ ...entry, turn: null }));
    },

    terminateTurn: (sessionId, termination) => {
      const draft = drafts.get(sessionId);
      if (draft === undefined) return;
      draft.status = 'terminated';
      draft.termination = termination;
      draft.updatedAt = termination.at;
      markDirty(sessionId);
    },

    queuePrompt: (sessionId, prompt) =>
      patchEntry(sessionId, (entry) => ({
        ...entry,
        pendingPrompts: [...entry.pendingPrompts, prompt],
      })),

    updatePrompt: (sessionId, clientRef, patch) =>
      patchEntry(sessionId, (entry) => ({
        ...entry,
        pendingPrompts: entry.pendingPrompts.map((prompt) =>
          prompt.clientRef === clientRef ? { ...prompt, ...patch } : prompt,
        ),
      })),

    removePrompt: (sessionId, clientRef) =>
      patchEntry(sessionId, (entry) => ({
        ...entry,
        pendingPrompts: entry.pendingPrompts.filter((prompt) => prompt.clientRef !== clientRef),
      })),

    noteActivity: (sessionId, at = Date.now()) =>
      patchEntry(sessionId, (entry) => ({
        ...entry,
        activityCount: entry.activityCount + 1,
        unread: true,
        lastActivityAt: at,
      })),

    clearActivity: (sessionId) =>
      patchEntry(sessionId, (entry) => ({ ...entry, activityCount: 0, unread: false })),

    dropSession: (sessionId) => {
      drafts.delete(sessionId);
      dirty.delete(sessionId);
      set((previous) => {
        if (previous.sessions[sessionId] === undefined) return previous;
        const sessions = { ...previous.sessions };
        delete sessions[sessionId];
        return { sessions };
      });
    },

    reset: () => {
      drafts.clear();
      dirty.clear();
      set({ sessions: {} });
      void get;
    },
  };
});

/** Read one Session's slice without subscribing to the whole registry. */
export function selectLiveSession(
  state: LiveSessionStoreState,
  sessionId: string | null,
): LiveSessionEntry {
  if (sessionId === null) return EMPTY_ENTRY;
  return state.sessions[sessionId] ?? EMPTY_ENTRY;
}

/** `9+` display cap for the activity counter (§6.5 / TDS 06 §3.4). */
export function formatActivityCount(count: number): string {
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}
