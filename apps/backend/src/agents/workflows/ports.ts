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
 * The three seams the workflow runner reaches the rest of the Backend through.
 *
 * They are narrow on purpose. The runner's whole job is *sequencing*, and the moment it holds a
 * `SessionService` it can do anything a Session can do — including the one thing this slice must
 * never do, which is invent a second way to run Claude Code. Declaring exactly four session
 * operations, one prompt operation and one hand-off operation makes the boundary reviewable: if a
 * future change needs a fifth, it has to be added here, in front of everyone.
 *
 * All three are satisfied structurally by services that already exist and are already tested —
 * `SessionService`, `PromptService`, `SessionExportService` — so nothing implements them twice in
 * production. The unit tier substitutes fakes; the integration tier passes the real ones.
 */

/** What the runner needs from a Session. Four verbs, and no access to `sessions.state`. */
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
