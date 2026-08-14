import type { RequestContext } from '../../http/context.js';

/**
 * Who a Session is created for.
 *
 * `{ userId }` rather than a `Principal`, because the advance path runs in a queue consumer where
 * there is no request and no authenticated caller — only the operator whose run this is. It is
 * `SessionActor` from `sessions/service.ts` structurally, which is exactly the point: those
 * methods read the user id and nothing else, so a runner that fabricated a `username`, an
 * `authMethod` and a scope list would be inventing three facts to satisfy a type.
 */
export interface WorkflowActor {
  readonly userId: string;
}

/**
 * The four seams the workflow runner reaches the rest of the Backend through.
 *
 * They are narrow on purpose. The runner's whole job is *sequencing*, and the moment it holds a
 * `SessionService` it can do anything a Session can do — including the one thing this slice must
 * never do, which is invent a second way to run Claude Code. Declaring exactly five session
 * operations, one prompt operation, one hand-off operation and one notification makes the boundary
 * reviewable: if a future change needs another, it has to be added here, in front of everyone.
 *
 * The fifth session verb arrived that way. `cancel` is here because Stop could not stop a step
 * whose Session was still queued behind the concurrency semaphore: it reported the Session "left
 * unstarted" and left the queued launch alive, so the run was `stopped` while its next Claude Code
 * process was still on its way. See `WorkflowSessionPort.cancel`.
 *
 * So did the fourth seam. `WorkflowNotifierPort` exists because a chain that advances on a human
 * ending each step is invisible to a human who is not looking at the run view — and the fix for
 * that is a notification, **not** an auto-advance. There is deliberately no verb here that ends,
 * completes or otherwise finishes a Session on the operator's behalf.
 *
 * All four are satisfied structurally by services that already exist and are already tested —
 * `SessionService`, `PromptService`, `SessionExportService`, `NotificationProducer` — so nothing
 * implements them twice in production. The unit tier substitutes fakes; the integration tier passes
 * the real ones.
 */

/** What the runner needs from a Session. Five verbs, and no access to `sessions.state`. */
export interface WorkflowSessionPort {
  create(
    actor: WorkflowActor,
    input: {
      readonly projectId: string;
      readonly workingDirectory: string;
      readonly repositoryId?: string | undefined;
      readonly branch?: string | undefined;
      readonly title?: string | undefined;
      readonly model?: string | undefined;
      readonly agentId?: string | undefined;
    },
    ctx: RequestContext,
  ): Promise<{ readonly id: string }>;

  /**
   * `POST /sessions/{id}/start`. The disposition matters to the caller: `'queued'` means the
   * concurrency semaphore deferred the launch and the prompt cannot be submitted yet.
   */
  start(
    actor: WorkflowActor,
    id: string,
    ctx: RequestContext,
  ): Promise<{ readonly launch: 'started' | 'queued' }>;

  /** `POST /sessions/{id}/end` — what a Stop does to the Session that is spending money. */
  end(actor: WorkflowActor, id: string, ctx: RequestContext): Promise<unknown>;

  /**
   * `SessionService.cancel` — what a Stop does to the Session that has not spent any *yet*.
   *
   * `end` cannot do this job: F7 has no `created -> completed` edge, so a step whose launch was
   * still sitting in the `session.launch` queue could not be closed at all. Cancelling moves it to
   * `failed(cancelled)`, and that single fact is what revokes the queued launch — the launch path
   * asks F7 whether the Session may reach `running`, and after this it may not.
   *
   * Legal from `created` only, and it **throws** otherwise rather than succeeding quietly, because
   * the caller has to be able to tell "I stopped it before it started" from "it started while I
   * was asking" — those are different outcomes and the operator is shown which one happened.
   */
  cancel(actor: WorkflowActor, id: string, ctx: RequestContext): Promise<unknown>;

  get(id: string): Promise<{ readonly id: string; readonly state: string }>;
}

/**
 * `POST /sessions/{id}/prompts`, and nothing else.
 *
 * No actor: `PromptService.submit` accepts an optional `principal` and reads nothing off it — the
 * Message it writes is attributed to the Session, which already names its user. Passing one here
 * would be a parameter that travels and is never consumed.
 */
export interface WorkflowPromptPort {
  submit(input: {
    readonly sessionId: string;
    readonly content: string;
  }): Promise<{ readonly messageId: string }>;
}

/**
 * Everything the runner knows about a step that is waiting for its operator.
 *
 * IDs plus the two names a sentence needs. The Notification's remaining facts — the project name,
 * the Session's title — are read by the producer from the Session itself (`notifications/facts.ts`
 * already does exactly that for `session.completed`), so the runner does not join tables it has no
 * other reason to touch.
 */
export interface WorkflowStepWaiting {
  readonly runId: string;
  readonly sessionId: string;
  readonly workflowName: string;
  readonly agentName: string;
  /** 0-based, as everywhere else in this module. Rendered as `ordinal + 1`. */
  readonly stepOrdinal: number;
  /** The run's snapshotted `step_count`, so "3 of 4" survives a later edit to the chain. */
  readonly stepCount: number;
}

/**
 * "Tell the operator", and nothing else.
 *
 * Satisfied structurally by `NotificationProducer`, which already owns every decision this port
 * must not make a second time: the per-event toggle, quiet hours, whether Telegram is configured,
 * and who the recipient is. The runner decides **whether a step is waiting**; the producer decides
 * **whether that becomes a Notification and where it goes**. Neither half re-implements the other,
 * which is what stops this from becoming a paging path with its own private idea of quiet hours.
 */
export interface WorkflowNotifierPort {
  notifyWorkflowStepWaiting(input: WorkflowStepWaiting): Promise<unknown>;
}

/**
 * The hand-off source: `POST /sessions/{id}/context-package` (TDS 04 §6.7).
 *
 * **Reuse rather than invention, and that is the design decision.** A context package was built
 * for "someone resuming abandoned work" — it already carries the working tree as of now, the
 * files the session touched, its commits, the ADRs it produced and related semantic memory, with
 * every gap named in place. That is precisely what step N+1 needs from step N, and building a
 * second document would have meant a second set of bounds, a second truncation policy and a
 * second chance to quietly omit something.
 */
export interface WorkflowHandoffPort {
  contextPackage(sessionId: string): Promise<{
    readonly content: string;
    readonly bytes: number;
    readonly relatedContext: {
      readonly gapReason: string | null;
      readonly gapDetail: string | null;
    };
  }>;
}
