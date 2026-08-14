import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  canTransition,
  type Db,
  type MessageRole,
  newId,
  type SessionState,
  type SessionType,
  schema,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import type { CommitCursor } from '../commits/cursors.js';
import { listCommits } from '../commits/store.js';
import type { Outbox } from '../events/index.js';
import { ApiError } from '../http/errors.js';
import type { SessionAgentPort } from './agent-binding.js';
import { buildSessionFiles, type SessionFilesReadModel } from './files.js';
import type { LaunchDisposition, ManagedSessionRegistry } from './manager.js';
import {
  findSessionById,
  findTranscriptTailState,
  insertSession,
  insertSessionEvent,
  listMessages,
  listSessionEvents,
  listSessions,
  type SessionRow,
  updateSession,
} from './repository.js';
import type { SessionRuntimePort } from './runtime-port.js';
import {
  type CommitResource,
  type MessageResource,
  type SessionResource,
  serializeCommit,
  serializeMessage,
  serializeObservation,
  serializeSession,
  serializeTimelineEntry,
  type TimelineEntryResource,
} from './serialize.js';
import type { SessionAction, SessionStateMachine } from './state-machine.js';
import { normalizeOperatorTitle } from './title.js';

/**
 * The Session domain service — TDS 04 §6, one method per contract row.
 *
 * `http/` owns no business logic (TDS 02 §2), so `routes.ts` validates and delegates here;
 * everything about *what* a lifecycle action means lives in this file and in
 * `state-machine.ts`, which is the only thing allowed to move `sessions.state`.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly ipAddress: string | null;
}

/**
 * **Everything the lifecycle methods below actually read off a `Principal`** — the user id, which
 * becomes `sessions.user_id` and the audit row's `actor_id`.
 *
 * Declared and used in place of `Principal` on `create`, `start` and `end` so that a caller which
 * genuinely has no request — the agent-workflow runner advancing a chain from a queue consumer
 * (PRD §5.6) — can name the operator whose run it is without fabricating an `authMethod`, a
 * `username` and a scope list that would all be untrue. Every existing caller passes a full
 * `Principal`, which satisfies this structurally, so nothing at a route changes.
 */
export type SessionActor = Pick<Principal, 'userId'>;

/**
 * `sessions.failure_reason` for a Session the operator abandoned before it launched
 * (`SessionService.cancel`).
 *
 * Part of the TDS 03 §3.9 failure-reason vocabulary, alongside `spawn_error`, `process_crash`,
 * `backend_restart`, `resume_target_lost` and `ingest_failure`. It sits beside
 * `BACKEND_RESTART_REASON` (`managed/recovery.ts`) for the same reason that one exists: `failed`
 * is F7's only exit
 * from a Session that never completed its work, and the reason is what distinguishes an outcome
 * the operator asked for from one they need to be told about.
 */
export const CANCELLED_REASON = 'cancelled';

export interface CreateSessionInput {
  readonly projectId: string;
  readonly workingDirectory: string;
  readonly repositoryId?: string | undefined;
  readonly branch?: string | undefined;
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  /** The Agent persona to run as (PRD §5.1). Global or project-scoped only — see `#bindAgent`. */
  readonly agentId?: string | undefined;
}

export interface UpdateSessionInput {
  readonly title?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly projectId?: string | undefined;
  /** Bind (or, with `null`, unbind) an Agent. Legal only while the Session is `created`. */
  readonly agentId?: string | null | undefined;
}

export interface ListSessionsInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly state?: SessionState | undefined;
  readonly projectId?: string | undefined;
  readonly sessionType?: SessionType | undefined;
  readonly repositoryId?: string | undefined;
}

export interface LaunchResult {
  readonly session: SessionResource;
  readonly launch: LaunchDisposition;
}

export interface InterruptResult {
  readonly sessionId: string;
  readonly messageId: string | null;
}

export interface SessionServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly stateMachine: SessionStateMachine;
  readonly registry: ManagedSessionRegistry;
  readonly runtime: SessionRuntimePort;
  /** Validates an `agentId` against the Session's project/id before it is stored (PRD §5.2). */
  readonly agents: SessionAgentPort;
  readonly onRuntimeError?: (error: unknown, sessionId: string) => void;
}

export class SessionService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #stateMachine: SessionStateMachine;
  readonly #registry: ManagedSessionRegistry;
  readonly #runtime: SessionRuntimePort;
  readonly #agents: SessionAgentPort;
  readonly #onRuntimeError: ((error: unknown, sessionId: string) => void) | undefined;

  constructor(options: SessionServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#stateMachine = options.stateMachine;
    this.#registry = options.registry;
    this.#runtime = options.runtime;
    this.#agents = options.agents;
    this.#onRuntimeError = options.onRuntimeError;
  }

  // -------------------------------------------------------------------------- CRUD (§6.2)

  /** `POST /api/v1/sessions` — creates a **managed** Session in state `created`. */
  async create(
    principal: SessionActor,
    input: CreateSessionInput,
    ctx: RequestContext,
  ): Promise<SessionResource> {
    await this.#assertProjectExists(input.projectId);
    if (input.repositoryId !== undefined) await this.#assertRepositoryExists(input.repositoryId);
    assertWorkingDirectory(input.workingDirectory);

    const id = newId();

    // PRD §5.1. Resolved before the transaction opens: a scope mismatch is a `400` about the
    // request, and there is nothing to roll back.
    const agent =
      input.agentId === undefined
        ? null
        : await this.#agents.resolveForSession({
            agentId: input.agentId,
            projectId: input.projectId,
            // The Session does not exist yet, which is exactly what makes a session-scoped Agent
            // unbindable here (`agents/binding.ts` says so in the error).
            sessionId: null,
          });

    const row = await this.#outbox.run(async (outboxTx) => {
      const session = await insertSession(outboxTx.tx, {
        id,
        projectId: input.projectId,
        userId: principal.userId,
        repositoryId: input.repositoryId ?? null,
        // Observed Sessions are created only by the system, on first hook event (§6.2, §6.8).
        sessionType: 'managed',
        workingDir: input.workingDirectory,
        branch: input.branch ?? null,
        model: input.model ?? null,
        ...(agent === null ? {} : { agentId: agent.agentId, runtime: agent.runtime }),
        // §6.11.3: empty and whitespace-only normalize to NULL at write, so "unnamed" has one
        // storage representation and the derivation guard stays total.
        title: normalizeOperatorTitle(input.title),
      });

      const payload = {
        sessionId: session.id,
        projectId: session.projectId,
        sessionType: session.sessionType,
        trigger: 'user' as const,
      };

      await insertSessionEvent(outboxTx.tx, {
        sessionId: session.id,
        type: 'session.created',
        trigger: 'user',
        toState: 'created',
        payload,
        correlationId: session.id,
      });

      await outboxTx.emit(
        this.#outbox.event('session.created', payload, { correlationId: session.id }),
      );

      await recordAuditEntry(outboxTx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'session.created',
        entityType: 'sessions',
        entityId: session.id,
        after: {
          projectId: session.projectId,
          repositoryId: session.repositoryId,
          sessionType: session.sessionType,
          workingDirectory: session.workingDir,
          agentId: session.agentId,
        },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });

      return session;
    });

    return this.#serialize(row);
  }

  /** `GET /api/v1/sessions/{id}`. */
  async get(id: string): Promise<SessionResource> {
    return this.#serialize(await this.#require(id));
  }

  /** `GET /api/v1/sessions` — cursor list with the §6.2 filter set (and only that set). */
  async list(input: ListSessionsInput): Promise<SessionResource[]> {
    const rows = await listSessions(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.sessionType === undefined ? {} : { sessionType: input.sessionType }),
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
    });

    return Promise.all(rows.map(async (row) => this.#serialize(row)));
  }

  /**
   * `PATCH /api/v1/sessions/{id}` — the operator override for `title`, plus `notes`/`projectId`,
   * plus `agentId` (PRD §5.1).
   *
   * `title`, `notes` and `projectId` are legal in **every** state including `archived`
   * (§6.11.4): renaming a record is not a lifecycle action and performs no F7 transition, so
   * nothing here touches the state machine.
   *
   * **`agentId` is not like them.** The Agent's instructions become the runtime's system prompt
   * at spawn and the runtime offers no way to replace it mid-conversation, so binding one to a
   * Session that has already started would be a change with no effect — a stored value that
   * contradicts what is running. It is therefore accepted only in `created`, which is the state
   * in which it is still true. This is also the path by which a **session-scoped** Agent becomes
   * usable: it names the Session it belongs to, so it cannot exist until the Session does.
   */
  async update(
    principal: Principal,
    id: string,
    input: UpdateSessionInput,
    ctx: RequestContext,
  ): Promise<SessionResource> {
    const existing = await this.#require(id);
    if (input.projectId !== undefined) await this.#assertProjectExists(input.projectId);

    const agentChange =
      'agentId' in input ? await this.#resolveAgentChange(existing, input.agentId ?? null) : {};

    const changes = {
      ...('title' in input ? { title: normalizeOperatorTitle(input.title) } : {}),
      ...('notes' in input ? { notes: normalizeNotes(input.notes) } : {}),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...agentChange,
    };

    if (Object.keys(changes).length === 0) return this.#serialize(existing);

    const row = await this.#outbox.run(async (outboxTx) => {
      const updated = await updateSession(outboxTx.tx, id, changes);
      /* c8 ignore next */
      if (updated === null) throw new ApiError('NOT_FOUND', `No session with id ${id}`);

      await recordAuditEntry(outboxTx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'session.updated',
        entityType: 'sessions',
        entityId: id,
        before: subset(existing, Object.keys(changes)),
        after: changes,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });

      return updated;
    });

    // §6.11.6: the title changes at most once per Session and no event is added for it. A
    // PATCH is likewise not a lifecycle fact, so it emits nothing and writes no timeline row.
    return this.#serialize(row);
  }

  // ------------------------------------------------------------ lifecycle actions (§6.3)

  /**
   * `POST /api/v1/sessions/{id}/start` — `created -> running`, or a durable queued launch.
   *
   * Never 409s on capacity (§6.2.1 / arbitration A2). Legality and type-applicability are
   * checked *before* the queue decision, so a queued launch is always one that would have been
   * legal had a slot been free.
   */
  async start(principal: SessionActor, id: string, ctx: RequestContext): Promise<LaunchResult> {
    const session = await this.#require(id);
    assertLaunchable(session, 'start');

    const launch = await this.#registry.launch({
      session,
      action: 'start',
      requestedBy: principal.userId,
    });

    await this.#audit(principal, id, 'session.started', { launch }, ctx);
    return { session: await this.#serialize(await this.#require(id)), launch };
  }

  /**
   * **Cancel a Session that has not launched** — `created -> failed`, reason
   * {@link CANCELLED_REASON}, trigger `user`.
   *
   * This is the missing exit from `created`, and it exists because there was **no way to cancel a
   * queued launch**. `POST /sessions/{id}/start` at capacity enqueues a durable `session.launch`
   * job and leaves the Session in `created` (§6.2.1); until this method existed, nothing could
   * revoke that job. A caller that had decided the Session must not run — a stopped workflow run
   * (PRD §5.6) is the first — could only wait for a slot to free, watch a Claude Code process
   * spawn, and end it by hand. "Stop" that leaves a process starting is not a stop, and it has a
   * bill attached.
   *
   * ## The guarantee, and why it is structural
   *
   * `sessions.state` has exactly one writer (`state-machine.ts`), it takes `FOR UPDATE` on the
   * row, and it validates against F7's table. F7 has **no edge out of `failed` into `running`**.
   * So once this commits, no path can launch the Session — not the queued job, not a redelivery of
   * it, not a concurrent `POST /start`. The launch consumer's own state check
   * (`manager.ts#consumeLaunchJob`) is what stops it *cheaply*, before a slot is taken; it is not
   * what makes it *true*. That distinction is the point: pg-boss is at-least-once and a job may
   * already be in flight, so a guarantee that depended on the check would be best-effort.
   *
   * ## Why `failed` and not a seventh state
   *
   * F7 is the Foundation Contract (F7, `entities/session-state.ts`) and `created` has exactly two
   * exits: `running` and `failed`. Adding `cancelled` would amend the contract, migrate two CHECK
   * constraints and touch every consumer of `SessionState` — for a distinction `failure_reason`
   * already carries. It carries it for `backend_restart` too, which is likewise not a failure of
   * the work: both mean "this Session is over and never did the job", and the reason column is
   * what says which. The notification producer reads that reason and stays silent for this one
   * (`notifications/produce.ts`) — an operator who cancelled a Session does not need to be told it
   * failed.
   *
   * Legal from `created` only. `paused` needs nothing like it: `end` already moves a paused
   * Session to `completed`, which invalidates a queued in-place resume by the same mechanism.
   */
  async cancel(principal: SessionActor, id: string, ctx: RequestContext): Promise<SessionResource> {
    const session = await this.#require(id);
    assertApplicable(session, 'cancel');

    if (session.state !== 'created') {
      throw new ApiError(
        'INVALID_STATE_TRANSITION',
        `Only a session that has not launched can be cancelled; this one is '${session.state}'`,
        { from: session.state, to: 'failed', action: 'cancel' },
      );
    }

    const result = await this.#stateMachine.transition({
      sessionId: id,
      to: 'failed',
      // The *user* asked. `backend_restart` is the `system` case, and conflating the two would
      // make the timeline unable to answer "who stopped this".
      trigger: 'user',
      action: 'cancel',
      reason: CANCELLED_REASON,
    });

    await this.#audit(principal, id, 'session.cancelled', { from: result.from }, ctx);
    return this.#serialize(result.session);
  }

  /** `POST /api/v1/sessions/{id}/pause` — cold pause: the runtime is disposed and the slot freed. */
  async pause(principal: Principal, id: string, ctx: RequestContext): Promise<SessionResource> {
    const session = await this.#require(id);
    assertApplicable(session, 'pause');

    // TDS 02 §5.1 order: interrupt and dispose first, then record the transition. Best-effort
    // because a runtime that is already gone must not block the operator's pause.
    await this.#disposeQuietly(id, 'paused');

    const result = await this.#stateMachine.transition({
      sessionId: id,
      to: 'paused',
      trigger: 'user',
      action: 'pause',
    });

    await this.#audit(principal, id, 'session.paused', { from: result.from }, ctx);
    return this.#serialize(result.session);
  }

  /**
   * `POST /api/v1/sessions/{id}/resume` — two different operations behind one path (§6.3):
   *
   *   - from `paused`: an **in-place** transition on the same row (same id, same
   *     `runtime_session_id`, lineage untouched) -> `200 { data, meta: { launch } }`;
   *   - from `completed`/`failed`/`archived`: a **new** Session linked by `resumedFromSessionId`,
   *     because F7 states never move backward -> `201 { data }`.
   *
   * **`failed` (§6.3, corrected 2026-08-12).** The row previously listed `completed` and
   * `archived` only, which contradicted three other documents: WS1 §4.4 marks Sessions orphaned
   * by a Backend restart as `failed(backend_restart)` and offers one-click Resume as *the*
   * recovery path, and WS4 §6.6 / WS5 §5.5 both render `[Resume as new session]` on the `failed`
   * composer. Refusing `failed` made restart recovery unimplementable — the failed Session still
   * holds the `runtime_session_id` the runtime needs to restore the conversation, and nothing
   * else can reach it. Nothing in **F7** changes: resume-as-new does not transition the source
   * Session at all, so which source states permit it is an API policy question.
   */
  async resume(
    principal: Principal,
    id: string,
    ctx: RequestContext,
  ): Promise<
    | { readonly kind: 'in_place'; readonly result: LaunchResult }
    | {
        readonly kind: 'new_session';
        readonly session: SessionResource;
      }
  > {
    const session = await this.#require(id);

    if (session.state === 'paused') {
      assertApplicable(session, 'resume');
      const launch = await this.#registry.launch({
        session,
        action: 'resume',
        requestedBy: principal.userId,
      });
      await this.#audit(principal, id, 'session.resumed', { launch, mode: 'in_place' }, ctx);
      return {
        kind: 'in_place',
        result: { session: await this.#serialize(await this.#require(id)), launch },
      };
    }

    if (
      session.state === 'completed' ||
      session.state === 'failed' ||
      session.state === 'archived'
    ) {
      const created = await this.#createDescendant(principal, session, 'resumed', null, ctx);
      return { kind: 'new_session', session: created };
    }

    throw new ApiError(
      'INVALID_STATE_TRANSITION',
      `Cannot resume a session in state '${session.state}'`,
      { from: session.state, action: 'resume' },
    );
  }

  /**
   * `POST /api/v1/sessions/{id}/end` — `running`/`paused -> completed`, trigger `user`.
   *
   * For an observed Session this is "stop observing" (WS1 §5.2): Mission Control detaches and
   * closes the record; the external session may keep running, unobserved.
   */
  async end(principal: SessionActor, id: string, ctx: RequestContext): Promise<SessionResource> {
    const session = await this.#require(id);
    assertApplicable(session, 'end');

    await this.#disposeQuietly(id, 'ended');

    const result = await this.#stateMachine.transition({
      sessionId: id,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });

    await this.#audit(principal, id, 'session.completed', { from: result.from }, ctx);
    return this.#serialize(result.session);
  }

  /** `POST /api/v1/sessions/{id}/archive` — `completed`/`failed -> archived` (terminal). */
  async archive(principal: Principal, id: string, ctx: RequestContext): Promise<SessionResource> {
    const session = await this.#require(id);
    assertApplicable(session, 'archive');

    const result = await this.#stateMachine.transition({
      sessionId: id,
      to: 'archived',
      trigger: 'user',
      action: 'archive',
    });

    await this.#audit(principal, id, 'session.archived', { from: result.from }, ctx);
    return this.#serialize(result.session);
  }

  /**
   * `POST /api/v1/sessions/{id}/clone` — a new Session in state `created` with
   * `clonedFromSessionId` set; SDK `forkSession: true` is applied at start (F1.5).
   *
   * Legal from any state that has a `runtimeSessionId`, except `archived` (§6.3). The two
   * rejections are deliberately different codes: `archived` is a *state* rejection, so it is
   * `INVALID_STATE_TRANSITION`; "no runtime session to fork" is not about F7 state at all — a
   * `created` Session is in a perfectly legal state and still has nothing to clone — so it is
   * the registry's generic `CONFLICT`.
   */
  async clone(
    principal: Principal,
    id: string,
    input: { readonly title?: string | undefined },
    ctx: RequestContext,
  ): Promise<SessionResource> {
    const session = await this.#require(id);

    if (session.state === 'archived') {
      throw new ApiError('INVALID_STATE_TRANSITION', 'Cannot clone an archived session', {
        from: session.state,
        action: 'clone',
      });
    }
    if (session.runtimeSessionId === null) {
      throw new ApiError('CONFLICT', 'Session has no runtime session to clone; start it first', {
        from: session.state,
        action: 'clone',
      });
    }

    return this.#createDescendant(principal, session, 'cloned', input.title ?? null, ctx);
  }

  /**
   * `POST /api/v1/sessions/{id}/interrupt` (§6.3.1) — stops the assistant turn in flight
   * **without** changing Session state. No F7 transition happens and **no
   * `session.state_changed` is emitted**; the Session stays `running` and is immediately ready
   * for the next prompt.
   */
  async interrupt(principal: Principal, id: string, ctx: RequestContext): Promise<InterruptResult> {
    const session = await this.#require(id);

    if (session.sessionType === 'observed') {
      throw new ApiError(
        'OPERATION_NOT_SUPPORTED',
        'Mission Control cannot interrupt an external Claude Code session',
        { sessionType: session.sessionType, action: 'interrupt' },
      );
    }
    if (session.state !== 'running') {
      throw new ApiError('SESSION_NOT_RUNNING', 'Session is not running', {
        state: session.state,
        action: 'interrupt',
      });
    }
    if (!this.#runtime.hasTurnInFlight(id)) {
      throw new ApiError('NO_TURN_IN_FLIGHT', 'No assistant turn is currently streaming', {
        action: 'interrupt',
      });
    }

    const outcome = await this.#runtime.interrupt(id);

    await this.#audit(principal, id, 'session.interrupted', { messageId: outcome.messageId }, ctx);
    return { sessionId: id, messageId: outcome.messageId };
  }

  // ------------------------------------------------------------------- nested reads (§6.6+)

  /** `GET /api/v1/sessions/{id}/messages` — ascending `ordinal`, the only conversation order. */
  async listMessages(
    id: string,
    options: {
      readonly limit: number;
      readonly order: 'asc' | 'desc';
      readonly afterOrdinal?: number | undefined;
      readonly role?: MessageRole | undefined;
      readonly status?: 'complete' | 'pending' | 'interrupted' | undefined;
    },
  ): Promise<MessageResource[]> {
    await this.#require(id);
    const rows = await listMessages(this.#db, id, {
      limit: options.limit,
      order: options.order,
      ...(options.afterOrdinal === undefined ? {} : { afterOrdinal: options.afterOrdinal }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    return rows.map(serializeMessage);
  }

  /** `GET /api/v1/sessions/{id}/timeline` — read directly from `session_events` (§6.7). */
  async listTimeline(
    id: string,
    options: { readonly limit: number; readonly afterId?: string | undefined },
  ): Promise<TimelineEntryResource[]> {
    await this.#require(id);
    const rows = await listSessionEvents(this.#db, id, {
      limit: options.limit,
      ...(options.afterId === undefined ? {} : { afterId: options.afterId }),
    });
    return rows.map(serializeTimelineEntry);
  }

  /**
   * `GET /api/v1/sessions/{id}/commits` (§6.10.1) — newest `committedAt` first.
   *
   * The query, the keyset cursor and the serializer all come from `commits/`, which owns the
   * §5.2 resource: this route and `GET /repositories/{id}/commits` differ only in which column
   * scopes them, and two implementations of "one page of commits, newest first" would be two
   * chances to paginate it differently.
   *
   * That cursor carries `committedAt` **and** `id` because `committed_at` is not unique: two
   * commits sharing a second would otherwise be able to hide each other across a page boundary.
   * The cursor stays opaque (§1.2); clients never parse it.
   */
  async listCommits(
    id: string,
    options: { readonly limit: number; readonly after?: CommitCursor | undefined },
  ): Promise<CommitResource[]> {
    await this.#require(id);

    const rows = await listCommits(this.#db, {
      sessionId: id,
      limit: options.limit,
      order: 'desc',
      ...(options.after === undefined ? {} : { after: options.after }),
    });

    return rows.map(serializeCommit);
  }

  /** `GET /api/v1/sessions/{id}/files` (§6.10.2) — bounded read model, no pagination. */
  async listFiles(id: string): Promise<SessionFilesReadModel> {
    const session = await this.#require(id);
    const observation = await this.#observation(session);
    return buildSessionFiles(this.#db, session, observation);
  }

  // -------------------------------------------------------------------------- internals

  /**
   * The `agent_id` (and `runtime`) a `PATCH` should write, or a refusal.
   *
   * Three refusals, each naming a different fact:
   *   - the Session has left `created`, so the system prompt is already fixed (`CONFLICT`);
   *   - the Session is observed, so Mission Control does not own its process and could not apply
   *     a persona to it at all (`OPERATION_NOT_SUPPORTED`);
   *   - the Agent's scope does not admit this Session (`VALIDATION_FAILED`, from the port).
   */
  async #resolveAgentChange(
    session: SessionRow,
    agentId: string | null,
  ): Promise<{ agentId?: string | null; runtime?: string }> {
    if (session.agentId === agentId) return {};

    if (session.sessionType === 'observed') {
      throw new ApiError(
        'OPERATION_NOT_SUPPORTED',
        'Mission Control does not launch an observed session, so an agent cannot steer one',
        { sessionType: session.sessionType, field: 'agentId' },
      );
    }

    if (session.state !== 'created') {
      throw new ApiError(
        'CONFLICT',
        "An agent is bound before launch: this session's state is '" +
          session.state +
          "' and its system prompt is already fixed",
        { state: session.state, field: 'agentId' },
      );
    }

    if (agentId === null) return { agentId: null };

    const agent = await this.#agents.resolveForSession({
      agentId,
      projectId: session.projectId,
      sessionId: session.id,
    });

    return { agentId: agent.agentId, runtime: agent.runtime };
  }

  async #require(id: string): Promise<SessionRow> {
    const session = await findSessionById(this.#db, id);
    if (session === null) throw new ApiError('NOT_FOUND', `No session with id ${id}`);
    return session;
  }

  async #serialize(row: SessionRow): Promise<SessionResource> {
    return serializeSession(row, await this.#observation(row));
  }

  async #observation(row: SessionRow): Promise<ReturnType<typeof serializeObservation>> {
    if (row.sessionType !== 'observed') return null;
    return serializeObservation(row, await findTranscriptTailState(this.#db, row.id));
  }

  /**
   * A resume-as-new or Clone row (arbitration A6): one self-FK plus a `lineage_kind`
   * discriminator, both written once at creation and never mutated. `runtime_session_id` starts
   * NULL — the runtime issues a fresh native id for the resumed/forked conversation, and the
   * launch reaches the parent's id through the FK (TDS 03 §3.9).
   *
   * The descendant is always **managed**: resuming or cloning an observed Session's
   * conversation is the promotion path from observation to management (WS1 §5.2).
   */
  async #createDescendant(
    principal: Principal,
    parent: SessionRow,
    lineageKind: 'resumed' | 'cloned',
    title: string | null,
    ctx: RequestContext,
  ): Promise<SessionResource> {
    const row = await this.#outbox.run(async (outboxTx) => {
      const session = await insertSession(outboxTx.tx, {
        projectId: parent.projectId,
        userId: principal.userId,
        repositoryId: parent.repositoryId,
        sessionType: 'managed',
        runtime: parent.runtime,
        workingDir: parent.workingDir,
        branch: parent.branch,
        model: parent.model,
        title: normalizeOperatorTitle(title),
        resumedFromSessionId: parent.id,
        lineageKind,
        // The persona is inherited with the conversation. A resume that dropped it would replay
        // a transcript written by an Architect into a session that is nobody — and the operator
        // would have no way to tell from the record which half was which.
        agentId: parent.agentId,
      });

      const payload = {
        sessionId: session.id,
        projectId: session.projectId,
        sessionType: session.sessionType,
        trigger: 'user' as const,
      };

      await insertSessionEvent(outboxTx.tx, {
        sessionId: session.id,
        type: 'session.created',
        trigger: 'user',
        toState: 'created',
        payload: { ...payload, lineageKind, parentSessionId: parent.id },
        correlationId: session.id,
      });

      await outboxTx.emit(
        this.#outbox.event('session.created', payload, { correlationId: session.id }),
      );

      await recordAuditEntry(outboxTx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: lineageKind === 'resumed' ? 'session.resumed' : 'session.cloned',
        entityType: 'sessions',
        entityId: session.id,
        after: { parentSessionId: parent.id, lineageKind, mode: 'new_session' },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });

      return session;
    });

    return this.#serialize(row);
  }

  async #disposeQuietly(sessionId: string, reason: 'paused' | 'ended'): Promise<void> {
    try {
      await this.#registry.dispose(sessionId, reason);
    } catch (error) {
      this.#onRuntimeError?.(error, sessionId);
    }
  }

  async #audit(
    principal: SessionActor,
    sessionId: string,
    action: string,
    after: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<void> {
    // TDS 03 §3.14 coverage: "session lifecycle actions triggered by users".
    await recordAuditEntry(this.#db, {
      actorType: 'user',
      actorId: principal.userId,
      action,
      entityType: 'sessions',
      entityId: sessionId,
      after,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
    });
  }

  async #assertProjectExists(projectId: string): Promise<void> {
    const rows = await this.#db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    if (rows.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
        field: 'projectId',
      });
    }
  }

  async #assertRepositoryExists(repositoryId: string): Promise<void> {
    const rows = await this.#db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .limit(1);
    if (rows.length === 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'repositoryId does not reference a known Repository',
        { field: 'repositoryId' },
      );
    }
  }
}

/**
 * Type-applicability, checked in the service as well as in the state machine.
 *
 * The state machine is the authority, but it only sees actions that reach it — and a queued
 * launch (§6.2.1) deliberately performs no transition at request time. Without this check an
 * observed Session's `start` would be silently enqueued at capacity instead of rejected.
 */
function assertApplicable(session: SessionRow, action: SessionAction): void {
  if (session.sessionType !== 'observed') return;
  if (action !== 'start' && action !== 'pause' && action !== 'resume') return;

  throw new ApiError(
    'OPERATION_NOT_SUPPORTED',
    `Action '${action}' is not applicable to an observed session`,
    { from: session.state, action, sessionType: session.sessionType },
  );
}

/**
 * §6.3's "Legal from" column, enforced before the launch is queued.
 *
 * `start` is legal from `created` only and `resume` in-place from `paused` only — the generic
 * F7 check would pass a `start` on a paused Session, because `paused -> running` is a legal
 * edge for a *different* action.
 */
function assertLaunchable(session: SessionRow, action: 'start' | 'resume'): void {
  assertApplicable(session, action);

  const from = session.state as SessionState;
  const requiredFrom: SessionState = action === 'start' ? 'created' : 'paused';

  if (from !== requiredFrom || !canTransition(from, 'running')) {
    throw new ApiError(
      'INVALID_STATE_TRANSITION',
      `Cannot ${action} a session in state '${from}'`,
      { from, to: 'running', action },
    );
  }
}

function assertWorkingDirectory(workingDirectory: string): void {
  // F8.1 path rules: user-provided paths are stored as absolute native paths.
  if (!isAbsolute(workingDirectory)) {
    throw new ApiError('VALIDATION_FAILED', 'workingDirectory must be an absolute native path', {
      field: 'workingDirectory',
    });
  }
  // §6.2: "validated to exist".
  if (!existsSync(workingDirectory)) {
    throw new ApiError('VALIDATION_FAILED', 'workingDirectory does not exist', {
      field: 'workingDirectory',
    });
  }
}

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes === null || notes === undefined) return null;
  return notes.length === 0 ? null : notes;
}

function subset(row: SessionRow, keys: readonly string[]): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = source[key] ?? null;
  return result;
}
