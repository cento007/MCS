import { type EventEnvelope, newId, type PgBossQueue, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedAgent,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  testWorkingDirectory,
  truncateAll,
} from '../../../test/integration/harness.js';
import { createFakeRuntime, type FakeRuntime } from '../../../test/support/fake-runtime.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import type { WorkflowPromptPort } from './ports.js';

/**
 * PRD §5.6 agent workflows end to end — real database, real pg-boss, real Session domain, real
 * F7 state machine, and `createFakeRuntime` in place of `claude`.
 *
 * Four claims this file exists to make observable rather than plausible:
 *
 *  1. **The cross-table scope rule is the database's.** The first block writes rows directly,
 *     bypassing every line of validation code, and PostgreSQL still refuses them **by constraint
 *     name** — including the NULL cases, which is the defect class 0006 shipped and 0007 fixed.
 *  2. **A run actually advances.** Ending a step's Session launches the next step, with the
 *     previous step's context package in its prompt. No polling loop in the test guesses at
 *     this; it waits for rows the runner wrote.
 *  3. **A failure halts and a halt is recoverable.** A crashed step stops the chain with a
 *     reason, and Resume re-runs that position in a *new* Session as a second attempt.
 *  4. **Stop stops the spend.** The run goes terminal *and* the in-flight Session is closed —
 *     ended when it is running, **cancelled when its launch is still queued** — and the
 *     `session.completed`/`session.failed` that produces advances nothing.
 */

let queue: PgBossQueue;
let app: TestApp;
let runtime: FakeRuntime;
let prompts: RecordingPrompts;
let cookie: string;
let projectId: string;
let userId: string;
let workingDirectory: string;
let events: EventEnvelope[];

interface RecordingPrompts extends WorkflowPromptPort {
  readonly submitted: { sessionId: string; content: string }[];
  fail(next: boolean): void;
}

/**
 * A `WorkflowPromptPort` that records instead of talking to a runtime.
 *
 * Paired with `createFakeRuntime` on purpose: a multi-step run needs a **distinct**
 * `runtime_session_id` per step (`ux_sessions_runtime_session_id`), which the fake runtime issues
 * and a single scripted `MockAgentRuntime` does not.
 */
function createRecordingPrompts(): RecordingPrompts {
  const submitted: { sessionId: string; content: string }[] = [];
  let failNext = false;

  return {
    submitted,
    fail(next: boolean): void {
      failNext = next;
    },
    async submit(input) {
      if (failNext) {
        failNext = false;
        throw new Error('scripted prompt failure');
      }
      submitted.push({ sessionId: input.sessionId, content: input.content });
      return { messageId: newId() };
    },
  };
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  runtime = createFakeRuntime();
  prompts = createRecordingPrompts();
  app = createTestApp({ queue, runtime, workflowPrompts: prompts });

  events = [];
  app.bus.subscribeAll((event) => {
    events.push(event);
  });

  await app.workflows.runs.start();

  const user = await seedUser();
  userId = user.id;

  const login = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = `${SESSION_COOKIE_NAME}=${cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME)}`;

  ({ projectId } = await seedProject());
  workingDirectory = testWorkingDirectory();
});

/**
 * **Release this case's job consumer before the next case subscribes.**
 *
 * `testQueue()` is one pg-boss instance for the whole file and every case builds its own app, so
 * a leaked worker on `agent_workflow.advance` would still be running — and pg-boss is a
 * competing-consumer substrate, so it would *steal* the next case's jobs and record their prompts
 * against its own recorder. The symptom is a prompt that was submitted to nothing, which reads
 * exactly like a broken runner. Found the hard way; pinned here.
 */
afterEach(async () => {
  await app.workflows.runs.shutdown();
});

async function post(url: string, body: Record<string, unknown> = {}) {
  return app.app.inject({ method: 'POST', url, headers: { cookie }, payload: body });
}
async function patch(url: string, body: Record<string, unknown> = {}) {
  return app.app.inject({ method: 'PATCH', url, headers: { cookie }, payload: body });
}
async function get(url: string) {
  return app.app.inject({ method: 'GET', url, headers: { cookie } });
}

const id = (): string => newId();

/**
 * Unique names for fixtures.
 *
 * A counter rather than `newId().slice(0, 8)`: UUIDv7 is time-ordered, so two ids minted in the
 * same millisecond share their leading characters — and `ux_agent_workflows_global_name` then
 * rejects the *second fixture* rather than the thing under test, which is the most misleading
 * failure a constraint test can produce.
 */
let fixtureCounter = 0;
function uniqueName(prefix: string): string {
  fixtureCounter += 1;
  return `${prefix} ${String(fixtureCounter)}`;
}

/** Insert straight into a workflow table, with no service and no validation in the way. */
async function rawInsert(table: 'workflows' | 'steps' | 'runs' | 'runSteps', values: object) {
  const target = {
    workflows: schema.agentWorkflows,
    steps: schema.agentWorkflowSteps,
    runs: schema.agentWorkflowRuns,
    runSteps: schema.agentWorkflowRunSteps,
  }[table];
  await testDatabase()
    .db.insert(target)
    .values(values as never);
}

/**
 * Assert that PostgreSQL refused a write, and that it refused it **by name**.
 *
 * Not `rejects.toThrow(/name/)`: Drizzle wraps the driver error, so its own message is only
 * "Failed query: insert into …" and the constraint name lives on `error.cause`. Matching the
 * wrapper would pass for any failed write at all — including a typo in the fixture — which would
 * make every constraint test in this file vacuous. Same helper, same reasoning, as
 * `agents/agents.int.test.ts`.
 */
async function expectRejectedBy(work: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected the write to be rejected by ${constraint}, but it succeeded`);
  }

  const chain: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    chain.push(current.message);
    current = current.cause;
  }
  expect(chain.join(' | ')).toContain(constraint);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function runStepRows(runId: string) {
  return testDatabase()
    .db.select()
    .from(schema.agentWorkflowRunSteps)
    .where(eq(schema.agentWorkflowRunSteps.runId, runId))
    .orderBy(schema.agentWorkflowRunSteps.ordinal, schema.agentWorkflowRunSteps.attempt);
}

async function runRow(runId: string) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.agentWorkflowRuns)
    .where(eq(schema.agentWorkflowRuns.id, runId));
  return rows[0];
}

async function sessionRow(sessionId: string) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId));
  return rows[0];
}

/** A two-step global chain, created through the API. Returns the workflow id. */
async function seedChain(names: readonly string[] = ['Developer', 'QA']): Promise<string> {
  const agentIds: string[] = [];
  for (const name of names) agentIds.push(await seedAgent({ name: uniqueName(name) }));

  const created = await post('/api/v1/agent-workflows', {
    name: uniqueName('Chain'),
    scope: 'global',
    steps: agentIds.map((agentId) => ({ agentId, instructions: `Do the ${agentId} part` })),
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ data: { id: string } }>().data.id;
}

async function startRun(workflowId: string, body: Record<string, unknown> = {}) {
  return post('/api/v1/agent-workflow-runs', {
    workflowId,
    projectId,
    task: 'Add rate limiting to the login route.',
    workingDirectory,
    ...body,
  });
}

/** The F7 transition a crashed child produces. The one honest way to fail a step from a test. */
async function crashSession(sessionId: string): Promise<void> {
  await app.sessions.stateMachine.transition({
    sessionId,
    to: 'failed',
    trigger: 'system',
    action: 'system',
    reason: 'process_crash',
  });
}

// =============================================================================================

describe('the cross-table scope rule is enforced by PostgreSQL, not by the service', () => {
  it('REJECTS a project workflow with no project, and a global one with one', async () => {
    await expectRejectedBy(
      rawInsert('workflows', { id: id(), name: 'A', scope: 'project' }),
      'ck_agent_workflows_scope_target',
    );
    await expectRejectedBy(
      rawInsert('workflows', { id: id(), name: 'B', scope: 'global', projectId }),
      'ck_agent_workflows_scope_target',
    );
  });

  it('REJECTS a global chain that holds a project-scoped agent', async () => {
    const workflowId = id();
    await rawInsert('workflows', { id: workflowId, name: uniqueName('Global'), scope: 'global' });
    const agentId = await seedAgent({
      name: uniqueName('ERP Architect'),
      scope: 'project',
      projectId,
    });

    // Without this the chain could be defined globally and run against another project, offering
    // an agent `AgentBindingResolver` refuses to bind — the leak `ck_agent_team_members_agent_scope`
    // prevents for rosters, arriving through the ordered door.
    await expectRejectedBy(
      rawInsert('steps', {
        id: id(),
        workflowId,
        workflowScope: 'global',
        workflowProjectId: null,
        ordinal: 0,
        agentId,
        agentScope: 'project',
        agentProjectId: projectId,
      }),
      'ck_agent_workflow_steps_agent_scope',
    );
  });

  it('REJECTS a project agent whose project key is MISSING — the NULL case, by name', async () => {
    // **A CHECK passes when it evaluates to NULL.** Written without `coalesce`,
    // `agent_project_id = workflow_project_id` is NULL here, not false, and this row would be
    // accepted. That is the defect 0006 shipped and 0007 had to correct, tested by name so it
    // cannot come back.
    const workflowId = id();
    await rawInsert('workflows', {
      id: workflowId,
      name: uniqueName('Project chain'),
      scope: 'project',
      projectId,
    });
    const agentId = await seedAgent({ name: uniqueName('Local'), scope: 'project', projectId });

    await expectRejectedBy(
      rawInsert('steps', {
        id: id(),
        workflowId,
        workflowScope: 'project',
        workflowProjectId: projectId,
        ordinal: 0,
        agentId,
        agentScope: 'project',
        agentProjectId: null,
      }),
      'ck_agent_workflow_steps_agent_scope',
    );
  });

  it('REJECTS a project chain whose own project key is missing', async () => {
    const workflowId = id();
    await rawInsert('workflows', {
      id: workflowId,
      name: uniqueName('Project'),
      scope: 'project',
      projectId,
    });
    const agentId = await seedAgent({ name: 'G' });

    await expectRejectedBy(
      rawInsert('steps', {
        id: id(),
        workflowId,
        workflowScope: 'project',
        workflowProjectId: null,
        ordinal: 0,
        agentId,
        agentScope: 'global',
        agentProjectId: null,
      }),
      'ck_agent_workflow_steps_workflow_scope',
    );
  });

  it('REJECTS a step whose copy of the agent scope disagrees with the agent', async () => {
    const workflowId = id();
    await rawInsert('workflows', { id: workflowId, name: uniqueName('Global'), scope: 'global' });
    // A project-scoped agent, described in the row as a global one. The row is **internally
    // consistent** — `ck_agent_workflow_steps_agent_scope` is satisfied, because a global agent is
    // supposed to carry no project — so nothing but the composite FK can catch it. That is the
    // whole reason the denormalized columns are pinned rather than merely written carefully.
    const agentId = await seedAgent({ name: uniqueName('Local'), scope: 'project', projectId });

    await expectRejectedBy(
      rawInsert('steps', {
        id: id(),
        workflowId,
        workflowScope: 'global',
        workflowProjectId: null,
        ordinal: 0,
        agentId,
        agentScope: 'global',
        agentProjectId: null,
      }),
      'agent_workflow_steps_agent_scope_fk',
    );
  });

  it('REJECTS an eleventh step — the spend bound, made structural', async () => {
    const workflowId = id();
    await rawInsert('workflows', { id: workflowId, name: uniqueName('Global'), scope: 'global' });
    const agentId = await seedAgent({ name: uniqueName('Agent') });

    await expectRejectedBy(
      rawInsert('steps', {
        id: id(),
        workflowId,
        workflowScope: 'global',
        workflowProjectId: null,
        ordinal: 10,
        agentId,
        agentScope: 'global',
        agentProjectId: null,
      }),
      'ck_agent_workflow_steps_ordinal',
    );
  });

  it('REJECTS two steps at one position', async () => {
    const workflowId = id();
    await rawInsert('workflows', { id: workflowId, name: uniqueName('Global'), scope: 'global' });
    const first = await seedAgent({ name: uniqueName('One') });
    const second = await seedAgent({ name: uniqueName('Two') });

    const step = (agentId: string) => ({
      id: id(),
      workflowId,
      workflowScope: 'global',
      workflowProjectId: null,
      ordinal: 0,
      agentId,
      agentScope: 'global',
      agentProjectId: null,
    });

    await rawInsert('steps', step(first));
    await expectRejectedBy(rawInsert('steps', step(second)), 'ux_agent_workflow_steps_ordinal');
  });
});

describe('the run constraints are enforced by PostgreSQL', () => {
  async function seedRunRow(overrides: Record<string, unknown> = {}): Promise<string> {
    const workflowId = id();
    await rawInsert('workflows', {
      id: workflowId,
      name: uniqueName('Run chain'),
      scope: 'global',
    });
    const runId = id();
    await rawInsert('runs', {
      id: runId,
      workflowId,
      projectId,
      userId,
      task: 'do it',
      workingDir: workingDirectory,
      stepCount: 2,
      maxSessions: 2,
      ...overrides,
    });
    return runId;
  }

  it('REJECTS a run that has launched more sessions than its budget', async () => {
    await expectRejectedBy(
      seedRunRow({ sessionsLaunched: 3 }),
      'ck_agent_workflow_runs_sessions_launched',
    );
  });

  it('REJECTS a halted run with no reason, and a completed run with no completion moment', async () => {
    await expectRejectedBy(seedRunRow({ state: 'halted' }), 'ck_agent_workflow_runs_state_fields');
    await expectRejectedBy(
      seedRunRow({ state: 'completed' }),
      'ck_agent_workflow_runs_state_fields',
    );
  });

  it('REJECTS a second RUNNING run in one project — the third spend bound', async () => {
    await seedRunRow();
    await expectRejectedBy(seedRunRow(), 'ux_agent_workflow_runs_active');
  });

  it('permits a second run once the first is no longer running', async () => {
    await seedRunRow({ state: 'stopped', completedAt: new Date() });
    await expect(seedRunRow()).resolves.toBeTypeOf('string');
  });
});

describe('the attempt constraints are enforced by PostgreSQL', () => {
  async function seedAttemptParents(): Promise<{
    runId: string;
    agentId: string;
    sessionId: string;
  }> {
    const workflowId = id();
    await rawInsert('workflows', {
      id: workflowId,
      name: uniqueName('Run chain'),
      scope: 'global',
    });
    const runId = id();
    await rawInsert('runs', {
      id: runId,
      workflowId,
      projectId,
      userId,
      task: 'do it',
      workingDir: workingDirectory,
      stepCount: 1,
      maxSessions: 1,
    });
    const agentId = await seedAgent({ name: `A${id().slice(0, 6)}` });
    const sessionId = newId();
    await testDatabase().db.insert(schema.sessions).values({
      id: sessionId,
      projectId,
      userId,
      sessionType: 'managed',
      workingDir: workingDirectory,
    });
    return { runId, agentId, sessionId };
  }

  it('REJECTS a degraded hand-off with no reason — the gap that would be invisible', async () => {
    const { runId, agentId, sessionId } = await seedAttemptParents();

    // The whole point of the flag: "degraded, and we are not saying why" is the plausible-looking
    // gap this feature must never produce, so the row cannot exist.
    await expectRejectedBy(
      rawInsert('runSteps', {
        id: id(),
        runId,
        ordinal: 0,
        agentId,
        sessionId,
        handoffState: 'degraded',
        handoffReason: null,
        prompt: 'x',
      }),
      'ck_agent_workflow_run_steps_handoff',
    );
  });

  it('REJECTS a complete hand-off that carries a reason anyway', async () => {
    const { runId, agentId, sessionId } = await seedAttemptParents();

    await expectRejectedBy(
      rawInsert('runSteps', {
        id: id(),
        runId,
        ordinal: 0,
        agentId,
        sessionId,
        handoffState: 'full',
        handoffReason: 'unavailable',
        prompt: 'x',
      }),
      'ck_agent_workflow_run_steps_handoff',
    );
  });

  it('REJECTS a prompt over the byte ceiling the prompt route enforces', async () => {
    const { runId, agentId, sessionId } = await seedAttemptParents();

    await expectRejectedBy(
      rawInsert('runSteps', {
        id: id(),
        runId,
        ordinal: 0,
        agentId,
        sessionId,
        handoffState: 'none',
        handoffReason: null,
        prompt: 'x'.repeat(262_145),
      }),
      'ck_agent_workflow_run_steps_prompt_bytes',
    );
  });

  it('REJECTS two attempts claiming one Session — what makes the advance unambiguous', async () => {
    const { runId, agentId, sessionId } = await seedAttemptParents();
    const attempt = (extra: object) => ({
      id: id(),
      runId,
      ordinal: 0,
      agentId,
      sessionId,
      handoffState: 'none',
      handoffReason: null,
      prompt: 'x',
      ...extra,
    });

    await rawInsert('runSteps', attempt({ attempt: 0 }));
    await expectRejectedBy(
      rawInsert('runSteps', attempt({ attempt: 1 })),
      'ux_agent_workflow_run_steps_session',
    );
  });
});

// =============================================================================================

describe('defining a chain', () => {
  it('returns the steps in their own order, not the agents’ alphabetical one', async () => {
    const zed = await seedAgent({ name: 'Zed' });
    const abe = await seedAgent({ name: 'Abe' });

    const created = await post('/api/v1/agent-workflows', {
      name: 'Ordered',
      scope: 'global',
      steps: [{ agentId: zed }, { agentId: abe }],
    });

    expect(created.statusCode).toBe(201);
    const body = created.json<{ data: { steps: { ordinal: number; agentName: string }[] } }>();
    expect(body.data.steps.map((step) => step.agentName)).toEqual(['Zed', 'Abe']);
    expect(body.data.steps.map((step) => step.ordinal)).toEqual([0, 1]);
  });

  it('allows the same agent twice — a chain is a sequence, not a roster', async () => {
    const dev = await seedAgent({ name: 'Developer' });

    const created = await post('/api/v1/agent-workflows', {
      name: 'Round trip',
      scope: 'global',
      steps: [{ agentId: dev }, { agentId: await seedAgent({ name: 'QA' }) }, { agentId: dev }],
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<{ data: { stepCount: number } }>().data.stepCount).toBe(3);
  });

  it('refuses an archived agent with a CONFLICT, naming it', async () => {
    const archived = await seedAgent({ name: 'Retired', archivedAt: new Date() });

    const created = await post('/api/v1/agent-workflows', {
      name: 'Bad',
      scope: 'global',
      steps: [{ agentId: archived }],
    });

    expect(created.statusCode).toBe(409);
    expect(created.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
  });

  it('refuses a global chain holding another project’s agent, with a 400 that explains', async () => {
    const local = await seedAgent({ name: 'Local', scope: 'project', projectId });

    const created = await post('/api/v1/agent-workflows', {
      name: 'Leaky',
      scope: 'global',
      steps: [{ agentId: local }],
    });

    expect(created.statusCode).toBe(400);
    expect(created.json<{ error: { message: string } }>().error.message).toContain(
      'global workflow may only use global agents',
    );
  });

  it('refuses an empty chain', async () => {
    const created = await post('/api/v1/agent-workflows', {
      name: 'Empty',
      scope: 'global',
      steps: [],
    });
    expect(created.statusCode).toBe(400);
  });

  it('archives instead of deleting, and hides the archived one from the default list', async () => {
    const workflowId = await seedChain();

    expect(
      (
        await app.app.inject({
          method: 'DELETE',
          url: `/api/v1/agent-workflows/${workflowId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);

    const archived = await patch(`/api/v1/agent-workflows/${workflowId}`, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ data: { archivedAt: string | null } }>().data.archivedAt).not.toBeNull();

    const list = await get('/api/v1/agent-workflows');
    expect(list.json<{ data: { id: string }[] }>().data.map((row) => row.id)).not.toContain(
      workflowId,
    );

    const withArchived = await get('/api/v1/agent-workflows?includeArchived=true');
    expect(withArchived.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toContain(
      workflowId,
    );
  });

  it('emits agent_workflow.created with ids and scalars only', async () => {
    await seedChain();
    const created = events.find((event) => event.type === 'agent_workflow.created');
    expect(created?.payload).toMatchObject({ scope: 'global', stepCount: 2 });
    expect(Object.keys(created?.payload ?? {})).toEqual(
      expect.arrayContaining(['workflowId', 'scope', 'projectId', 'stepCount']),
    );
  });
});

// =============================================================================================

describe('running a chain', () => {
  it('launches step 1, prompts it, and records the run', async () => {
    const workflowId = await seedChain();
    const started = await startRun(workflowId);

    expect(started.statusCode).toBe(201);
    const run = started.json<{ data: { id: string; state: string; steps: unknown[] } }>().data;
    expect(run.state).toBe('running');

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1 to exist');
    const [first] = await runStepRows(run.id);

    expect(first?.ordinal).toBe(0);
    expect(first?.attempt).toBe(0);
    // The first step is `none`, not `degraded`: there is nothing missing.
    expect(first?.handoffState).toBe('none');

    const session = await sessionRow(first?.sessionId ?? '');
    expect(session?.state).toBe('running');
    // The whole execution model in one assertion: the step IS a Session, bound to the step's Agent.
    expect(session?.agentId).toBe(first?.agentId);

    await waitFor(async () => prompts.submitted.length === 1, 'the step-1 prompt');
    expect(prompts.submitted[0]?.sessionId).toBe(first?.sessionId);
    expect(prompts.submitted[0]?.content).toContain('Add rate limiting to the login route.');
    expect(prompts.submitted[0]?.content).toContain('You are the first step in this chain');

    const updated = await runStepRows(run.id);
    expect(updated[0]?.promptSentAt).not.toBeNull();
  });

  it('advances to step 2 when the operator ends step 1, carrying the context package', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    const [first] = await runStepRows(run.id);

    // A managed Session does not complete itself — the operator ends it, and *that* is the
    // signal the chain advances on.
    const ended = await post(`/api/v1/sessions/${first?.sessionId}/end`);
    expect(ended.statusCode).toBe(200);

    await waitFor(async () => (await runStepRows(run.id)).length === 2, 'step 2 to be launched');
    const rows = await runStepRows(run.id);

    expect(rows[0]?.state).toBe('completed');
    expect(rows[1]?.ordinal).toBe(1);
    expect(rows[1]?.sessionId).not.toBe(first?.sessionId);

    // The crux: step 2 was handed step 1's context package, not a blank brief.
    expect(rows[1]?.handoffState).toBe('full');
    expect(rows[1]?.prompt).toContain('Hand-off from the previous step');
    expect(rows[1]?.prompt).toContain('Where this left off');
    expect(rows[1]?.prompt).toContain(first?.sessionId ?? 'no-session');

    await waitFor(async () => prompts.submitted.length === 2, 'the step-2 prompt');

    // The reserved §15.4 names, produced from the Session's own lifecycle rather than a second one.
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'agent_workflow.run.started',
        'agent.execution_started',
        'agent.execution_completed',
      ]),
    );
  });

  it('completes the run when the last step ends', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    await post(`/api/v1/sessions/${(await runStepRows(run.id))[0]?.sessionId}/end`);

    await waitFor(async () => (await runStepRows(run.id)).length === 2, 'step 2');
    await post(`/api/v1/sessions/${(await runStepRows(run.id))[1]?.sessionId}/end`);

    await waitFor(async () => (await runRow(run.id))?.state === 'completed', 'the run to complete');

    const finished = await runRow(run.id);
    expect(finished?.completedAt).not.toBeNull();
    expect(finished?.sessionsLaunched).toBe(2);
    expect(events.map((event) => event.type)).toContain('agent_workflow.run.completed');
  });

  it('refuses a second run in the same project while one is running', async () => {
    const workflowId = await seedChain();
    await startRun(workflowId);

    const second = await startRun(await seedChain(['Security']));
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { message: string } }>().error.message).toContain('in progress');
  });

  it('refuses to run an archived chain, and one with an archived step', async () => {
    const archivedChain = await seedChain();
    await patch(`/api/v1/agent-workflows/${archivedChain}`, { archived: true });
    expect((await startRun(archivedChain)).statusCode).toBe(409);

    const agentId = await seedAgent({ name: 'Doomed' });
    const chain = (
      await post('/api/v1/agent-workflows', {
        name: 'Retires mid-life',
        scope: 'global',
        steps: [{ agentId }],
      })
    ).json<{ data: { id: string } }>().data.id;

    await patch(`/api/v1/agents/${agentId}`, { archived: true });

    const refused = await startRun(chain);
    expect(refused.statusCode).toBe(409);
    // Checked for the WHOLE chain up front: finding out at step 4 costs three sessions of spend.
    expect(refused.json<{ error: { message: string } }>().error.message).toContain(
      'archived agent',
    );
  });

  it('refuses to edit a chain that has a run in flight', async () => {
    const workflowId = await seedChain();
    await startRun(workflowId);

    const edit = await patch(`/api/v1/agent-workflows/${workflowId}`, { name: 'Renamed' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json<{ error: { message: string } }>().error.message).toContain('running run');
  });
});

// =============================================================================================

describe('failure halts, and a halted run is not a dead row', () => {
  it('halts with a reason when a step crashes, and records the failed attempt', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    const [first] = await runStepRows(run.id);

    await crashSession(first?.sessionId ?? '');

    await waitFor(async () => (await runRow(run.id))?.state === 'halted', 'the run to halt');

    const halted = await runRow(run.id);
    expect(halted?.haltReason).toBe('process_crash');
    expect(halted?.completedAt).toBeNull();

    const rows = await runStepRows(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.error).toBe('process_crash');

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['agent.execution_failed', 'agent_workflow.run.halted']),
    );

    // Halting is a stop, not an advance: nothing was launched behind it.
    expect(halted?.sessionsLaunched).toBe(1);
  });

  it('resumes a halted run by re-running the failed position as a second attempt', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    const [first] = await runStepRows(run.id);
    await crashSession(first?.sessionId ?? '');
    await waitFor(async () => (await runRow(run.id))?.state === 'halted', 'the halt');

    const resumed = await post(`/api/v1/agent-workflow-runs/${run.id}/resume`);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ data: { state: string } }>().data.state).toBe('running');

    await waitFor(async () => (await runStepRows(run.id)).length === 2, 'the retry');
    const rows = await runStepRows(run.id);

    // Same position, new attempt, NEW Session — F7 states never move backward.
    expect(rows[1]?.ordinal).toBe(0);
    expect(rows[1]?.attempt).toBe(1);
    expect(rows[1]?.sessionId).not.toBe(first?.sessionId);
    // The failed attempt keeps its own row and its own Session: nothing is rewritten.
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.sessionId).toBe(first?.sessionId);

    expect((await runRow(run.id))?.haltReason).toBeNull();
  });

  it('refuses to resume a run that is not halted', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    const refused = await post(`/api/v1/agent-workflow-runs/${run.id}/resume`);
    expect(refused.statusCode).toBe(409);
  });
});

// =============================================================================================

describe('stop is a kill switch', () => {
  it('ends the in-flight Session and advances nothing afterwards', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    const [first] = await runStepRows(run.id);

    const stopped = await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    expect(stopped.statusCode).toBe(200);

    const body = stopped.json<{
      data: { state: string };
      meta: { stoppedSession: { sessionId: string; outcome: string } | null };
    }>();
    expect(body.data.state).toBe('stopped');
    expect(body.meta.stoppedSession).toEqual({
      sessionId: first?.sessionId,
      outcome: 'ended',
    });

    // The part that actually stops the spend: the runtime was disposed.
    expect(runtime.disposals.map((entry) => entry.sessionId)).toContain(first?.sessionId);
    expect((await sessionRow(first?.sessionId ?? ''))?.state).toBe('completed');

    const rows = await runStepRows(run.id);
    expect(rows[0]?.state).toBe('stopped');

    // The `session.completed` that ending produced must NOT have advanced the chain. Give the
    // queue a real chance to deliver it before asserting that nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await runStepRows(run.id)).toHaveLength(1);
    expect((await runRow(run.id))?.state).toBe('stopped');
  });

  it('stops a halted run, reports no session to stop, and refuses a terminal one', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    await crashSession((await runStepRows(run.id))[0]?.sessionId ?? '');
    await waitFor(async () => (await runRow(run.id))?.state === 'halted', 'the halt');

    const stopped = await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    expect(stopped.statusCode).toBe(200);
    // A halted run has **no** step in flight, so there is nothing to end — and `null` says that,
    // rather than claiming an action the endpoint did not take.
    expect(stopped.json<{ meta: { stoppedSession: unknown } }>().meta.stoppedSession).toBeNull();

    const again = await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    expect(again.statusCode).toBe(409);
  });

  it('says "already_terminal" when the Session finished before the stop landed', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;
    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');

    // Take the runner out so the advance never lands: the attempt row stays `running` while its
    // Session goes terminal underneath it. That is the race the outcome exists to describe, and
    // stopping it must not pretend to have ended something that had already ended.
    await app.workflows.runs.shutdown();
    await post(`/api/v1/sessions/${(await runStepRows(run.id))[0]?.sessionId}/end`);

    const stopped = await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    expect(
      stopped.json<{ meta: { stoppedSession: { outcome: string } } }>().meta.stoppedSession.outcome,
    ).toBe('already_terminal');
  });

  /**
   * **The hole this test was written for: "stopped" used to mean "will start shortly".**
   *
   * A step whose Session is still `created` is a launch the concurrency semaphore has not reached.
   * Stop reported it as `left_unstarted` and left it exactly where it was — with a live
   * `session.launch` job behind it. The moment a slot freed, a run the operator had stopped spawned
   * Claude Code, took a `maxConcurrentSessions` slot and held it until someone pressed End by hand.
   *
   * The test therefore does the one thing that makes that observable: it **frees the slot after the
   * stop** and then asserts the runtime was never asked to launch. Against the old code the step's
   * Session reaches `running` here and `runtime.launches` grows.
   */
  it('cancels a step whose launch was still queued, so freeing a slot spawns nothing', async () => {
    // One slot, already taken: whatever the run creates next has to queue behind it.
    app.sessions.registry.setMaxConcurrentSessions(1);
    await app.sessions.registry.start();

    const decoy = await seedSession({ projectId, userId, state: 'created' });
    await app.sessions.registry.launch({
      session: (await sessionRow(decoy)) as never,
      action: 'start',
      requestedBy: userId,
    });
    expect(app.sessions.registry.slotsInUse).toBe(1);

    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    const [first] = await runStepRows(run.id);
    const stepSessionId = first?.sessionId ?? '';
    const launchesBefore = runtime.launches.length;

    // The Session exists and has *not* started — its launch is a durable job, not a process.
    expect((await sessionRow(stepSessionId))?.state).toBe('created');

    const stopped = await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect(
      stopped.json<{ meta: { stoppedSession: { sessionId: string; outcome: string } } }>().meta
        .stoppedSession,
    ).toEqual({ sessionId: stepSessionId, outcome: 'cancelled' });

    // F7's only exit from `created`, with the reason that says the operator asked for it.
    const cancelled = await sessionRow(stepSessionId);
    expect(cancelled?.state).toBe('failed');
    expect(cancelled?.failureReason).toBe('cancelled');

    // Free the slot. This is the moment the old behaviour spent money.
    await post(`/api/v1/sessions/${decoy}/end`);
    await waitFor(async () => app.sessions.registry.slotsInUse === 0, 'the slot to come back');
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(runtime.launches).toHaveLength(launchesBefore);
    expect((await sessionRow(stepSessionId))?.state).toBe('failed');
    expect(app.sessions.registry.slotsInUse).toBe(0);

    // And the `session.failed` the cancel emitted advanced nothing: the run is stopped, so the
    // chain stays at one attempt.
    expect(await runStepRows(run.id)).toHaveLength(1);
    expect((await runRow(run.id))?.state).toBe('stopped');
  });

  it('frees the project for a new run', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;
    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');

    await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    expect((await startRun(workflowId)).statusCode).toBe(201);
  });
});

// =============================================================================================

describe('the spend bounds an operator can see and set', () => {
  it('reports observed history per step, and null where an agent has never run', async () => {
    const dev = await seedAgent({ name: 'Developer' });
    const qa = await seedAgent({ name: 'QA' });

    const workflowId = (
      await post('/api/v1/agent-workflows', {
        name: 'Estimated',
        scope: 'global',
        steps: [{ agentId: dev }, { agentId: qa }],
      })
    ).json<{ data: { id: string } }>().data.id;

    // Two completed Sessions for the Developer, none for QA.
    for (const cost of ['0.500000', '1.500000']) {
      await testDatabase().db.insert(schema.sessions).values({
        id: newId(),
        projectId,
        userId,
        sessionType: 'managed',
        workingDir: workingDirectory,
        state: 'completed',
        agentId: dev,
        totalCostUsd: cost,
        startedAt: new Date(),
      });
    }

    const estimate = (await get(`/api/v1/agent-workflows/${workflowId}/cost-estimate`)).json<{
      data: {
        basis: string;
        steps: { agentName: string; observed: { sessionCount: number; meanUsd: number } | null }[];
        projected: { meanUsd: number; coveredSteps: number } | null;
        stepsWithoutHistory: number;
        defaultMaxSessions: number;
      };
    }>().data;

    expect(estimate.basis).toBe('observed_sessions');
    expect(estimate.steps[0]?.observed).toEqual({ sessionCount: 2, meanUsd: 1, maxUsd: 1.5 });
    // The honest half: QA has never run, so there is no number to give.
    expect(estimate.steps[1]?.observed).toBeNull();
    expect(estimate.stepsWithoutHistory).toBe(1);
    expect(estimate.projected).toEqual({ meanUsd: 1, maxUsd: 1.5, coveredSteps: 1 });
    expect(estimate.defaultMaxSessions).toBe(5);
  });

  it('refuses a session budget that cannot pay for the chain', async () => {
    const workflowId = await seedChain();
    const refused = await startRun(workflowId, { maxSessions: 1 });

    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('step count');
  });

  it('halts rather than launching past the budget', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId, { maxSessions: 2 })).json<{ data: { id: string } }>()
      .data;

    await waitFor(async () => (await runStepRows(run.id)).length === 1, 'step 1');
    const [first] = await runStepRows(run.id);
    await crashSession(first?.sessionId ?? '');
    await waitFor(async () => (await runRow(run.id))?.state === 'halted', 'the halt');

    // One session left in the budget, so the retry is allowed…
    expect((await post(`/api/v1/agent-workflow-runs/${run.id}/resume`)).statusCode).toBe(200);
    await waitFor(async () => (await runStepRows(run.id)).length === 2, 'the retry');

    await crashSession((await runStepRows(run.id))[1]?.sessionId ?? '');
    await waitFor(async () => (await runRow(run.id))?.state === 'halted', 'the second halt');

    // …and now it is not. The refusal names the budget rather than silently spending past it.
    const exhausted = await post(`/api/v1/agent-workflow-runs/${run.id}/resume`);
    expect(exhausted.statusCode).toBe(409);
    expect(exhausted.json<{ error: { message: string } }>().error.message).toContain(
      'session budget',
    );
    expect((await runRow(run.id))?.sessionsLaunched).toBe(2);
  });
});

// =============================================================================================

/**
 * "A workflow step is waiting for you" — the notification, end to end.
 *
 * The signal itself (a turn ending on its own, and not an interrupted or rate-limited one) is the
 * managed controller's, and `sessions/managed/controller.test.ts` pins which endings fire it. This
 * file starts one step past that, at `noteTurnEnded`, which is the seam the controller calls: what
 * it exercises is the *decision* — is this a step, is the run still going, has it been said
 * already — and the Notification the producer writes.
 *
 * Nothing here ends a Session. The run still advances only when the operator does.
 */
describe('telling the operator a step is waiting', () => {
  async function notifications() {
    return testDatabase()
      .db.select()
      .from(schema.notifications)
      .where(eq(schema.notifications.type, 'workflow_step_waiting'));
  }

  it('produces one notification naming the step, and never a second one for it', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => prompts.submitted.length === 1, 'the step-1 prompt');
    const [first] = await runStepRows(run.id);

    await app.workflows.runs.noteTurnEnded(first?.sessionId ?? '');

    const [written] = await notifications();
    expect(written?.title).toContain('Workflow step 1 of 2 is waiting');
    expect(written?.severity).toBe('info');
    // The run, so everything said about one chain shares a correlation id.
    expect(written?.correlationId).toBe(run.id);
    expect(written?.payload).toMatchObject({ sessionId: first?.sessionId, runId: run.id });
    // No `eventType`: there is no originating F6 event for a runtime going idle.
    // Indexed optionally rather than cast-then-indexed: `written` is typed possibly-undefined,
    // and `(undefined as Record<…>)['eventType']` throws instead of asserting. The `title`
    // assertion above is what actually proves a notification was written.
    expect(
      (written?.payload as Record<string, unknown> | undefined)?.['eventType'],
    ).toBeUndefined();

    // The claim is on the attempt row, and it is what makes the second call silent — an operator
    // answering a question inside the step must not be paged for the turn that answers it.
    expect((await runStepRows(run.id))[0]?.waitingNotifiedAt).not.toBeNull();

    await app.workflows.runs.noteTurnEnded(first?.sessionId ?? '');
    await app.workflows.runs.noteTurnEnded(first?.sessionId ?? '');
    expect(await notifications()).toHaveLength(1);
  });

  it('says nothing about a session that is not a workflow step', async () => {
    // Every managed Session goes idle at the end of every turn. This is the entire filter, and
    // without it the notification would fire for ordinary interactive chat.
    const loose = await seedSession({ projectId, userId, state: 'running' });

    await app.workflows.runs.noteTurnEnded(loose);

    expect(await notifications()).toHaveLength(0);
  });

  it('notifies again for the *next* step, because that is a different thing to be told', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => prompts.submitted.length === 1, 'the step-1 prompt');
    const [first] = await runStepRows(run.id);
    await app.workflows.runs.noteTurnEnded(first?.sessionId ?? '');

    await post(`/api/v1/sessions/${first?.sessionId}/end`);
    await waitFor(async () => prompts.submitted.length === 2, 'the step-2 prompt');
    const rows = await runStepRows(run.id);

    await app.workflows.runs.noteTurnEnded(rows[1]?.sessionId ?? '');

    const written = await notifications();
    expect(written).toHaveLength(2);
    expect(written.map((row) => row.title).sort()).toEqual([
      expect.stringContaining('step 1 of 2'),
      expect.stringContaining('step 2 of 2'),
    ]);
    // The last step's sentence is different, because ending it completes the run rather than
    // handing off to a step that does not exist.
    expect(written.find((row) => row.title.includes('step 2 of 2'))?.body).toContain(
      'completes the run',
    );
  });

  it('says nothing once the run is no longer running', async () => {
    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;

    await waitFor(async () => prompts.submitted.length === 1, 'the step-1 prompt');
    const [first] = await runStepRows(run.id);

    await post(`/api/v1/agent-workflow-runs/${run.id}/stop`);
    await app.workflows.runs.noteTurnEnded(first?.sessionId ?? '');

    expect(await notifications()).toHaveLength(0);
  });

  it('obeys the operator’s toggle rather than inventing a bypass', async () => {
    // `notifications.events.workflowStepWaiting` is a real switch on the same footing as the other
    // five: it goes through `decideNotification`, which is also where quiet hours are applied.
    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/notifications',
      headers: { cookie },
      payload: { events: { workflowStepWaiting: false } },
    });
    expect(saved.statusCode).toBe(200);

    const workflowId = await seedChain();
    const run = (await startRun(workflowId)).json<{ data: { id: string } }>().data;
    await waitFor(async () => prompts.submitted.length === 1, 'the step-1 prompt');
    const [first] = await runStepRows(run.id);

    await app.workflows.runs.noteTurnEnded(first?.sessionId ?? '');

    expect(await notifications()).toHaveLength(0);
  });
});

describe('a Backend with no managed runtime', () => {
  it('refuses a run up front rather than launching a Session it cannot speak to', async () => {
    // No `workflowPrompts`, no `agentRuntime`: `sessions.managed` is null, so there is no prompt
    // surface at all. It shares this file's database, so the cookie above authenticates it.
    const bare = createTestApp({ queue, runtime });

    const workflowId = await seedChain();
    const refused = await bare.app.inject({
      method: 'POST',
      url: '/api/v1/agent-workflow-runs',
      headers: { cookie },
      payload: { workflowId, projectId, task: 'x', workingDirectory },
    });

    expect(refused.statusCode).toBe(503);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('RUNTIME_UNAVAILABLE');
    // Nothing was created — not a run row, not a Session.
    expect(
      await testDatabase()
        .db.select()
        .from(schema.agentWorkflowRuns)
        .where(eq(schema.agentWorkflowRuns.projectId, projectId)),
    ).toHaveLength(0);
  });
});
