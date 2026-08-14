import type { SessionState } from '@mc/shared/types';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { ConfirmDialog } from '../../../components/Modal.js';
import { Skeleton } from '../../../components/Skeleton.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { endpoints, type Session } from '../../../lib/api/index.js';
import { formatClockSeconds, formatCostUsd, formatDateTime } from '../../../lib/format/index.js';
import { formatRelativePast } from '../../../lib/format/relative.js';
import { useLiveClock } from '../../../lib/liveness.js';
import { useChannel } from '../../../lib/ws/context.js';
import { useResumeWorkflowRun, useStopWorkflowRun } from './mutations.js';
import { useStepSessions, useWorkflow, useWorkflowRun } from './queries.js';
import {
  type ChainPosition,
  canResumeRun,
  canStopRun,
  chainPositions,
  displayState,
  handoffNote,
  runHalt,
  runProgress,
  runStateKind,
  runStatePresentation,
  stepSessionDisagreement,
  stepStatePresentation,
} from './run-state.js';
import type { RunStepView } from './shape.js';

/**
 * `/agents/runs/:runId` — one workflow run, while it is happening (PRD §5.6).
 *
 * ## This screen is an index, not a record
 *
 * Every step **is** a Session, so the transcript, the cost, the files and the commits all belong to
 * that Session and are shown there. This page says which Session each step is, what state the run
 * believes it is in, and what the operator can do next. It deliberately paraphrases nothing: the
 * halt reason, the step error and the hand-off reason are all rendered verbatim, because a summary
 * of why something failed is exactly the kind of helpfulness that costs an hour.
 *
 * ## The three things it must not get wrong
 *
 * **1. A halted run is not a failed run.** A step failed, so the chain stopped rather than handing
 * rejected work to the next agent — that is the design working. It is amber, it names the step and
 * quotes the reason, it says what did *not* happen (the later steps never started) and what is not
 * undone (the earlier steps' commits), and it offers `[Resume]`, because `halted` is not terminal.
 *
 * **2. A running step does not end itself.** `ManagedSessionController` keeps a Session `running`
 * after a turn ends, because Claude Code routinely finishes a turn by asking a question. So the
 * chain advances when the **operator ends the step's Session** — or when it fails. An operator who
 * does not know that will watch a finished-looking step forever, so the running step says it, every
 * time, with a link to the session that has the `[End]` button.
 *
 * **3. Stop must not be able to lie.** Stopping marks the run `stopped` and then ends the in-flight
 * Session; this screen keeps rendering **each step's own Session state** beside the run's account of
 * it and flags a disagreement, so a stop that left a process running would be visible here rather
 * than discoverable from a bill.
 */
export function WorkflowRunPage() {
  const { runId } = useParams();
  return <RunDetail key={runId ?? 'none'} runId={runId ?? null} />;
}

function RunDetail({ runId }: { runId: string | null }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const clock = useLiveClock();
  const [confirmingStop, setConfirmingStop] = useState(false);

  /**
   * Two channels, and both are load-bearing.
   *
   * `agents` carries `agent_workflow.run.*`; `sessions` carries the `session.completed` /
   * `session.failed` that the *advance itself* is driven by — so subscribing to both means this
   * screen refetches at exactly the moments the run moves, without a single poll.
   */
  useChannel('agents');
  useChannel('sessions');

  const detail = useWorkflowRun(runId);
  const run = detail.run;
  const workflow = useWorkflow(run?.workflowId ?? null);
  const stop = useStopWorkflowRun();
  const resume = useResumeWorkflowRun();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const positions = run === null ? [] : chainPositions(run, workflow.workflow);
  const sessionIds = positions
    .flatMap((position) => position.attempts)
    .map((attempt) => attempt.sessionId)
    .filter((sessionId): sessionId is string => sessionId !== null);
  const sessions = useStepSessions(sessionIds);

  const kind = runStateKind(run?.state ?? '');
  const progress = runProgress(positions);
  const halt = runHalt(positions);
  const presentation = runStatePresentation(kind);

  const spent = sessionIds
    .map((sessionId) => sessions.sessionOf(sessionId)?.costUsd ?? null)
    .filter((cost): cost is number => cost !== null)
    .reduce((total, cost) => total + cost, 0);

  /**
   * An agent's **name**, from the definition, matched by id rather than by position.
   *
   * A run records only `agentId` — it is history, and a name can be renamed — so without this the
   * chain reads `ran as 00a002`, which is exactly the useless identifier TDS 05 §9.3 warns about.
   * Matching by id rather than by ordinal is what makes it safe: it does not matter whether the
   * chain has since been reordered or extended, because "this id is called QA" is true either way.
   * A run whose agent is in no current step still falls back to the id tail rather than to nothing.
   */
  const agentNameOf = (agentId: string): string | null =>
    workflow.workflow?.steps.find((step) => step.agentId === agentId && step.agentName.length > 0)
      ?.agentName ?? null;

  return (
    <section className="flex flex-col gap-4 px-4 py-4 md:px-6">
      <div>
        <Link
          to={
            run?.workflowId === undefined || run?.workflowId === null
              ? '/agents/workflows'
              : `/agents/workflows/${run.workflowId}`
          }
          className="rounded-xs text-2xs text-text-muted underline decoration-dotted underline-offset-2"
          style={{ minHeight: 24 }}
        >
          ← {workflow.workflow?.name ?? 'Workflows'}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="font-medium text-text text-xl outline-none">
          {workflow.workflow === null ? 'Workflow run' : `Run of ${workflow.workflow.name}`}
        </h1>
        {run === null ? null : (
          <span
            data-testid="run-state"
            className="inline-flex items-center gap-1 rounded-xs px-2 py-05 font-medium text-2xs"
            style={{
              backgroundColor:
                presentation.subtleVar === null
                  ? 'var(--color-surface-raised)'
                  : `var(${presentation.subtleVar})`,
              color:
                presentation.colorVar === null
                  ? 'var(--color-text-secondary)'
                  : `var(${presentation.colorVar})`,
            }}
            title={`Run state: ${displayState(run.state)}`}
          >
            <span aria-hidden="true">{presentation.glyph}</span>
            {displayState(run.state)}
          </span>
        )}
        {kind === 'unknown' && run !== null && run.state.length > 0 ? (
          <span className="text-2xs text-text-muted">
            (a state this build does not recognise — shown exactly as served)
          </span>
        ) : null}
      </div>

      {detail.unavailable ? <RouteMissing /> : null}
      {detail.isError ? (
        <ErrorPanel
          error={detail.error}
          title="This run could not be read"
          onRetry={detail.refetch}
        />
      ) : null}
      {detail.unreadable ? <Unreadable /> : null}

      {detail.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading run</span>
          <Skeleton height={96} />
          <Skeleton height={160} />
        </div>
      ) : run === null ? null : (
        <>
          <dl
            data-testid="run-facts"
            className="flex flex-wrap gap-6 rounded-md border border-border p-3"
            style={{ backgroundColor: 'var(--color-surface)' }}
          >
            <Fact label="Progress">
              {progress.completed} of {progress.total || (run.stepCount ?? 0)} steps completed
              {progress.notStarted > 0 ? ` · ${progress.notStarted} not started` : ''}
            </Fact>
            <Fact label="Sessions">
              {run.sessionsLaunched ?? '—'} launched of {run.maxSessions ?? '—'} allowed
            </Fact>
            <Fact label="Spent so far">
              {sessionIds.length === 0 ? '—' : formatCostUsd(spent)}
              <span className="ml-1 text-text-muted">
                summed from this run’s sessions, not from the run
              </span>
            </Fact>
            <Fact label="Started">
              {run.startedAt === null ? '—' : formatRelativePast(run.startedAt, clock.now)}
              {run.completedAt === null ? null : (
                <span className="ml-1 text-text-muted">
                  · ended {formatDateTime(run.completedAt)}
                </span>
              )}
            </Fact>
            <Fact label="Working directory">
              {/* Its own fact, and the branch is another one: rendered side by side in one mono
                  run they read as a single path, which is how `D:\Repos\MCS DEV` happened. */}
              <code className="font-mono text-xs">{run.workingDirectory || '—'}</code>
            </Fact>
            {run.branch === null ? null : (
              <Fact label="Branch">
                <code className="font-mono text-xs">{run.branch}</code>
              </Fact>
            )}
          </dl>

          <RunBanner
            kind={kind}
            run={run}
            halt={halt}
            positions={positions}
            sessions={sessions}
            stopping={stop.isPending}
            resuming={resume.isPending}
            onStop={() => setConfirmingStop(true)}
            onResume={() => void resume.mutate({ runId: run.id })}
          />

          <section
            className="rounded-md border border-border"
            style={{ backgroundColor: 'var(--color-surface)' }}
          >
            <div className="border-border border-b px-4 py-3">
              <h2 className="font-medium text-2xs text-text-secondary uppercase">The task</h2>
            </div>
            <div className="px-4 py-3">
              <p
                data-testid="run-task"
                className="whitespace-pre-wrap text-sm text-text leading-150"
              >
                {run.task.length === 0 ? (
                  <span className="text-text-muted">This Backend served no task for this run.</span>
                ) : (
                  run.task
                )}
              </p>
              <p className="mt-1 text-2xs text-text-muted leading-150">
                Sent verbatim to every step, alongside that step’s own instructions and the agent’s
                persona.
              </p>
            </div>
          </section>

          <section
            className="rounded-md border border-border"
            style={{ backgroundColor: 'var(--color-surface)' }}
          >
            <div className="border-border border-b px-4 py-3">
              <h2 className="font-medium text-2xs text-text-secondary uppercase">The chain</h2>
            </div>
            <ol data-testid="run-chain" className="flex flex-col">
              {positions.map((position) => (
                <li key={position.ordinal} className="border-border border-b last:border-b-0">
                  <PositionRow
                    position={position}
                    total={positions.length}
                    sessions={sessions}
                    runKind={kind}
                    agentName={position.agentId === null ? null : agentNameOf(position.agentId)}
                  />
                </li>
              ))}
              {positions.length === 0 ? (
                <li className="px-4 py-4">
                  <p data-testid="run-no-steps" className="text-sm text-text-secondary leading-150">
                    This run has no step rows yet. A step row is written the moment its Session is
                    created, so this is the state between starting a run and its first session
                    existing — not an empty run.
                  </p>
                </li>
              ) : null}
            </ol>
          </section>

          <p className="text-2xs text-text-muted leading-150">
            <span aria-hidden="true">ⓘ</span> Last read from the server at{' '}
            {detail.updatedAt === null ? '—' : formatClockSeconds(detail.updatedAt)}.{' '}
            <button
              type="button"
              onClick={detail.refetch}
              className="rounded-xs underline decoration-dotted underline-offset-2"
              style={{ minHeight: 24 }}
            >
              {detail.isFetching ? 'Refreshing…' : 'Refresh'}
            </button>{' '}
            This page updates when the run moves — it listens on the same events the run itself
            advances on — and never polls.
          </p>

          {run.unrecognised.length > 0 ? (
            <p
              role="note"
              data-testid="run-unrecognised"
              className="text-2xs text-text-muted leading-150"
            >
              <span aria-hidden="true">ⓘ</span> Served on this run and not shown here:{' '}
              <code className="font-mono">{run.unrecognised.join(', ')}</code>.
            </p>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmingStop}
        title="Stop this run?"
        body={stopConfirmBody(positions, progress.runningPosition)}
        confirmLabel="Stop run"
        destructive
        pending={stop.isPending}
        onConfirm={() => {
          setConfirmingStop(false);
          if (run !== null) stop.mutate({ runId: run.id });
        }}
        onCancel={() => setConfirmingStop(false)}
      />
    </section>
  );
}

/**
 * What Stop actually does, said before it is done.
 *
 * Taken from the Backend rather than from an assumption: the run is marked `stopped` **first**, in
 * its own transaction, and then the in-flight Session is **ended** — which is what disposes the
 * runtime. The ordering matters to the operator too, because it is why the `session.completed` that
 * ending produces cannot advance the chain to the next step.
 */
function stopConfirmBody(
  positions: readonly ChainPosition[],
  runningPosition: number | null,
): string {
  const remaining = positions.filter((entry) => entry.kind === 'not_started').length;
  const where =
    runningPosition === null
      ? 'No step is running right now, so there is no session to end.'
      : `Step ${runningPosition} is running: its session is ended, which disposes the Claude Code runtime — the same thing the session’s own [End] button does.`;

  return `${where} The run is marked stopped first, so the session ending cannot advance the chain. ${
    remaining === 0
      ? ''
      : `The ${remaining} step${remaining === 1 ? ' that has' : 's that have'} not started will not start. `
  }Work already committed by earlier steps stays exactly as it is — stopping undoes nothing. A stopped run cannot be resumed; starting again is a new run.`;
}

function RunBanner({
  kind,
  run,
  halt,
  positions,
  sessions,
  stopping,
  resuming,
  onStop,
  onResume,
}: {
  kind: ReturnType<typeof runStateKind>;
  run: NonNullable<ReturnType<typeof useWorkflowRun>['run']>;
  halt: ReturnType<typeof runHalt>;
  positions: readonly ChainPosition[];
  sessions: ReturnType<typeof useStepSessions>;
  stopping: boolean;
  resuming: boolean;
  onStop: () => void;
  onResume: () => void;
}) {
  const running = positions.find((entry) => entry.kind === 'running') ?? null;
  const runningSessionId = running?.latest?.sessionId ?? null;

  if (kind === 'running') {
    return (
      <Banner testId="run-banner-running" tone="info">
        <p className="text-sm text-text leading-150">
          <strong>
            Step {running?.position ?? '—'} of {positions.length}
          </strong>{' '}
          is running
          {running?.latest?.promptSentAt === null
            ? ' — its session exists but the prompt has not been sent yet, which means the launch is waiting for a concurrency slot.'
            : '.'}
        </p>
        <p className="mt-1 text-2xs text-text-secondary leading-150">
          <strong>The chain advances when you end this step’s session</strong>, or when it fails.
          Mission Control does not end it for you: a turn ending is not a session ending — Claude
          Code routinely finishes a turn by asking a question — so auto-advancing would hand the
          next agent work that stopped mid-sentence.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {runningSessionId === null ? null : (
            <Link
              to={`/sessions/${runningSessionId}`}
              className="flex items-center rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
            >
              Open step {running?.position} session
            </Link>
          )}
          <StopButton onStop={onStop} pending={stopping} kind={kind} />
        </div>
      </Banner>
    );
  }

  if (kind === 'halted') {
    const failedSessionId = halt.failedStep?.sessionId ?? null;
    return (
      <Banner testId="run-banner-halted" tone="warning">
        <p className="text-sm text-text leading-150">
          <span aria-hidden="true">▲</span> <strong>This run is halted, not failed.</strong>{' '}
          {halt.failedPosition === null
            ? 'The chain stopped before finishing.'
            : `Step ${halt.failedPosition} of ${halt.total} failed, so the chain stopped there rather than handing rejected work to the next agent.`}
          {halt.unstarted > 0
            ? ` The ${halt.unstarted === 1 ? 'step' : `${halt.unstarted} steps`} after it never started.`
            : ''}
        </p>

        {run.haltReason === null ? null : (
          <p data-testid="run-halt-reason" className="mt-2 text-sm text-text leading-150">
            <span className="text-text-secondary">Reason: </span>
            <code className="font-mono text-xs">{run.haltReason}</code>
          </p>
        )}

        {halt.failedStep?.error == null ? null : (
          <p data-testid="run-step-error" className="mt-1 text-2xs text-text-secondary leading-150">
            The step’s session reported: <code className="font-mono">{halt.failedStep.error}</code>
          </p>
        )}

        <p className="mt-2 text-2xs text-text-secondary leading-150">
          Nothing is rolled back.{' '}
          {halt.completedBefore > 0
            ? `The ${halt.completedBefore === 1 ? 'step' : `${halt.completedBefore} steps`} before it finished, and whatever they wrote or committed is still there. `
            : ''}
          Read the failed step’s transcript, fix what broke, then resume — which re-runs that step
          in a <strong>new</strong> session (session states never move backward) and spends one more
          from this run’s budget of {run.maxSessions ?? '—'}.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {failedSessionId === null ? null : (
            <Link
              to={`/sessions/${failedSessionId}`}
              className="flex items-center rounded-sm border border-border-control px-3 text-sm text-text"
              style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
            >
              Open the failed session
            </Link>
          )}
          <button
            type="button"
            data-testid="run-resume"
            onClick={onResume}
            disabled={resuming || !canResumeRun(kind)}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              minHeight: 24,
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {resuming ? 'Resuming…' : 'Resume run'}
          </button>
          <StopButton onStop={onStop} pending={stopping} kind={kind} />
        </div>

        {(run.sessionsLaunched ?? 0) >= (run.maxSessions ?? Number.POSITIVE_INFINITY) ? (
          <p
            data-testid="run-budget-exhausted"
            className="mt-2 text-2xs leading-150"
            style={{ color: 'var(--color-danger)' }}
          >
            <span aria-hidden="true">✕</span> This run has used its whole session budget (
            {run.maxSessions}), so resuming is refused. Start a new run — with a larger budget if
            the chain genuinely needs the retries.
          </p>
        ) : null}
      </Banner>
    );
  }

  if (kind === 'stopped') {
    const stoppedStep = positions.find((entry) => entry.kind === 'stopped') ?? null;
    const stoppedSession =
      stoppedStep?.latest?.sessionId === undefined || stoppedStep.latest?.sessionId === null
        ? null
        : sessions.sessionOf(stoppedStep.latest.sessionId);
    return (
      <Banner testId="run-banner-stopped" tone="warning">
        <p className="text-sm text-text leading-150">
          <span aria-hidden="true">■</span> <strong>You stopped this run.</strong>{' '}
          {stoppedStep === null
            ? 'No step was running when it was stopped.'
            : `Step ${stoppedStep.position} was in flight and its session was ended, which disposes the runtime.`}{' '}
          A stopped run cannot be resumed; starting the workflow again is a new run.
        </p>
        {stoppedSession === null ? null : (
          <p className="mt-1 text-2xs text-text-secondary leading-150">
            That session is now ‹{stoppedSession.state}›. If it still says <code>running</code>,
            stopping did not reach the process — open it and end it there.
          </p>
        )}
      </Banner>
    );
  }

  if (kind === 'completed') {
    return (
      <Banner testId="run-banner-completed" tone="success">
        <p className="text-sm text-text leading-150">
          <span aria-hidden="true">✓</span> All {positions.length} steps completed. Each step’s work
          is in its own session — open them below for the transcripts, files and commits.
        </p>
      </Banner>
    );
  }

  return (
    <Banner testId="run-banner-unknown" tone="neutral">
      <p className="text-sm text-text leading-150">
        This run’s state is ‹{displayState(run.state)}›, which this build does not recognise.
        Nothing is inferred from it — the steps below are shown exactly as served, and no action is
        offered that depends on knowing what this state means.
      </p>
    </Banner>
  );
}

/**
 * The Stop control, present wherever stopping is legal and **absent** — not disabled — where it is
 * not.
 *
 * Stop is legal from `running` and from `halted` (a halted run still holds its place in the
 * project's one-active-run slot, so releasing it is a real action). A terminal run answers `409`,
 * so no button is drawn for one.
 */
function StopButton({
  onStop,
  pending,
  kind,
}: {
  onStop: () => void;
  pending: boolean;
  kind: ReturnType<typeof runStateKind>;
}) {
  if (!canStopRun(kind)) return null;

  return (
    <button
      type="button"
      data-testid="run-stop"
      onClick={onStop}
      disabled={pending}
      className="rounded-sm border px-3 font-medium text-sm disabled:opacity-50"
      style={{
        height: 'var(--mc-control-md)',
        minHeight: 24,
        borderColor: 'var(--color-danger)',
        color: 'var(--color-danger)',
      }}
    >
      {pending ? 'Stopping…' : 'Stop run'}
    </button>
  );
}

function PositionRow({
  position,
  total,
  sessions,
  runKind,
  agentName,
}: {
  position: ChainPosition;
  total: number;
  sessions: ReturnType<typeof useStepSessions>;
  runKind: ReturnType<typeof runStateKind>;
  /** From the definition, matched by id. `null` when this build cannot name the agent. */
  agentName: string | null;
}) {
  const presentation =
    position.kind === 'not_started'
      ? { glyph: '○', colorVar: null, subtleVar: null }
      : stepStatePresentation(position.kind);

  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="flex items-center justify-center rounded-full font-medium text-2xs"
        style={{
          width: 24,
          height: 24,
          backgroundColor:
            presentation.subtleVar === null
              ? 'var(--color-surface-raised)'
              : `var(${presentation.subtleVar})`,
          color:
            presentation.colorVar === null
              ? 'var(--color-text-secondary)'
              : `var(${presentation.colorVar})`,
        }}
      >
        {position.position}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-text">
          <span className="sr-only">
            Step {position.position} of {total}:{' '}
          </span>
          <span
            data-testid="run-step-state"
            className="inline-flex items-center gap-1 rounded-xs px-2 py-05 font-medium text-2xs"
            style={{
              backgroundColor:
                presentation.subtleVar === null
                  ? 'var(--color-surface-raised)'
                  : `var(${presentation.subtleVar})`,
              color:
                presentation.colorVar === null
                  ? 'var(--color-text-secondary)'
                  : `var(${presentation.colorVar})`,
            }}
          >
            <span aria-hidden="true">{presentation.glyph}</span>
            {position.kind === 'not_started' ? 'not started' : displayState(position.state)}
          </span>

          <AgentName position={position} agentName={agentName} />

          {position.attempts.length > 1 ? (
            <span className="text-2xs text-text-muted">
              attempt {(position.latest?.attempt ?? 0) + 1} of {position.attempts.length}
            </span>
          ) : null}
        </p>

        {position.kind === 'not_started' ? (
          <p className="mt-1 text-2xs text-text-muted leading-150">
            {runKind === 'running'
              ? 'Not started yet. A step row exists only once its session does, so there is nothing to open here.'
              : 'Never started. The chain stopped before reaching it, so no session was ever created for it.'}
            {position.agentFromDefinition
              ? ' The agent named is from the workflow as it stands today.'
              : ' This run does not record which agent would have run here, and the definition has changed since it started — so no agent is named rather than a wrong one.'}
          </p>
        ) : (
          <AttemptDetails position={position} sessions={sessions} />
        )}
      </div>
    </div>
  );
}

/**
 * Which persona ran here.
 *
 * The name when the definition can supply one, the id tail when it cannot — never the raw id and
 * never nothing. A UUIDv7's leading characters encode a timestamp, so the *last* six are the only
 * discriminating part (TDS 05 §9.3); they are a poor label and a far better one than blank.
 */
function AgentName({ position, agentName }: { position: ChainPosition; agentName: string | null }) {
  if (position.agentId === null) {
    return <span className="text-text-muted text-xs">agent not recorded</span>;
  }
  return (
    <span className="text-text-secondary text-xs">
      <Link
        to={`/agents/${position.agentId}`}
        className="rounded-xs underline decoration-dotted underline-offset-2"
      >
        {position.agentFromDefinition ? 'expected agent' : 'ran as'}{' '}
        {agentName ?? `agent …${position.agentId.slice(-6)}`}
      </Link>
    </span>
  );
}

function AttemptDetails({
  position,
  sessions,
}: {
  position: ChainPosition;
  sessions: ReturnType<typeof useStepSessions>;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {position.attempts.map((attempt) => (
        <AttemptRow
          key={`${attempt.ordinal}-${attempt.attempt}`}
          attempt={attempt}
          session={attempt.sessionId === null ? null : sessions.sessionOf(attempt.sessionId)}
          missing={attempt.sessionId !== null && sessions.missing.has(attempt.sessionId)}
          isLatest={attempt === position.latest}
        />
      ))}
    </div>
  );
}

function AttemptRow({
  attempt,
  session,
  missing,
  isLatest,
}: {
  attempt: RunStepView;
  session: Session | null;
  missing: boolean;
  isLatest: boolean;
}) {
  const handoff = handoffNote(attempt);
  const disagreement = stepSessionDisagreement(attempt.state, session?.state ?? null);

  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2 text-2xs text-text-secondary">
        {attempt.sessionId === null ? (
          <span className="text-text-muted">
            This attempt records no session, which the schema says should be impossible.
          </span>
        ) : missing ? (
          <span style={{ color: 'var(--color-warning)' }}>
            Session {attempt.sessionId.slice(-6)} could not be read — it may have been removed.
          </span>
        ) : (
          <>
            <Link
              to={`/sessions/${attempt.sessionId}`}
              data-testid="run-step-session-link"
              className="rounded-xs underline decoration-dotted underline-offset-2"
              style={{ minHeight: 24 }}
            >
              Open the session
            </Link>
            {session === null ? null : (
              <>
                <StatusBadge state={session.state as SessionState} />
                {session.costUsd === null ? null : <span>{formatCostUsd(session.costUsd)}</span>}
              </>
            )}
          </>
        )}
        {isLatest ? null : <span className="text-text-muted">(earlier attempt)</span>}
      </p>

      {disagreement === null ? null : (
        <p
          role="alert"
          data-testid="run-step-disagreement"
          className="text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> {disagreement}
        </p>
      )}

      {attempt.error === null ? null : (
        <p className="text-2xs leading-150" style={{ color: 'var(--color-danger)' }}>
          <span aria-hidden="true">✕</span> <code className="font-mono">{attempt.error}</code>
        </p>
      )}

      {handoff === null ? null : (
        <p
          data-testid={`run-step-handoff-${handoff.kind}`}
          className="text-2xs leading-150"
          style={{
            color: handoff.kind === 'degraded' ? 'var(--color-warning)' : 'var(--color-text-muted)',
          }}
        >
          <span aria-hidden="true">{handoff.kind === 'degraded' ? '▲' : 'ⓘ'}</span>{' '}
          {handoff.kind === 'degraded' ? 'Incomplete hand-off: ' : 'Hand-off: '}
          {handoff.text}
          {attempt.handoffPromptBytes === null
            ? ''
            : ` (${attempt.handoffPromptBytes} bytes of prompt)`}
        </p>
      )}

      {attempt.promptSentAt === null && attempt.sessionId !== null ? (
        <p className="text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> The prompt has not been sent to this session yet — the
          launch is waiting for a concurrency slot. The session exists and nothing has been said to
          it.
        </p>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-text-secondary uppercase">{label}</dt>
      <dd className="mt-05 text-sm text-text">{children}</dd>
    </div>
  );
}

function Banner({
  testId,
  tone,
  children,
}: {
  testId: string;
  tone: 'info' | 'warning' | 'success' | 'neutral';
  children: React.ReactNode;
}) {
  const palette: Record<typeof tone, { background: string; border: string }> = {
    info: { background: 'var(--color-info-subtle)', border: 'var(--color-info)' },
    warning: { background: 'var(--color-warning-subtle)', border: 'var(--color-warning)' },
    success: { background: 'var(--color-success-subtle)', border: 'var(--color-success)' },
    neutral: { background: 'var(--color-surface)', border: 'var(--color-border)' },
  };
  const colors = palette[tone];

  return (
    <div
      role="note"
      data-testid={testId}
      className="rounded-md border p-3"
      style={{ backgroundColor: colors.background, borderColor: colors.border }}
    >
      {children}
    </div>
  );
}

function RouteMissing() {
  return (
    <div
      role="note"
      data-testid="run-route-missing"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> This Backend does not serve{' '}
        <code className="font-mono text-xs">
          /api/v1{endpoints.agentWorkflowRuns.detail('{id}')}
        </code>{' '}
        yet.
      </p>
      <p className="mt-1 max-w-3xl text-2xs text-text-muted leading-150">
        Nothing about this run can be shown, and nothing is guessed at. If a run is genuinely in
        flight, its steps are ordinary Sessions and are all on the Sessions screen.
      </p>
    </div>
  );
}

function Unreadable() {
  return (
    <div
      role="alert"
      data-testid="run-unreadable"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
      }}
    >
      <p className="text-sm text-text leading-150">
        The Backend answered, and the document was not a run this screen can read.
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        It carried no <code className="font-mono">id</code>. Nothing is rendered from a guess: a run
        drawn from a half-understood document could show a chain as finished when it is still
        spending.
      </p>
    </div>
  );
}
