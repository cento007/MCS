import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiMock,
  dataBody,
  makeHaltedRun,
  makeRun,
  makeRunStep,
  makeSession,
  makeWorkflow,
  mockApi,
  QA_ID,
  RUN_ID,
  renderWorkflows,
  SESSION_ONE,
  SESSION_TWO,
  WORKFLOW_ID,
} from './test-support.js';

/**
 * The run view, while money is being spent.
 *
 * Three things must never be wrong here, and each has its own block below: a **halted** run is not
 * a crash, **Stop** must say what it actually did, and a step that is running must say how it ends
 * — because a managed Session does not end itself, so a chain waits for the operator.
 */

let api: ApiMock;

function withRun(run: Record<string, unknown>): void {
  api.on('GET', `/api/v1/agent-workflow-runs/${RUN_ID}`, { body: dataBody(run) });
  api.on('GET', `/api/v1/agent-workflows/${WORKFLOW_ID}`, { body: dataBody(makeWorkflow()) });
  api.on('GET', `/api/v1/sessions/${SESSION_ONE}`, { body: dataBody(makeSession()) });
  api.on('GET', `/api/v1/sessions/${SESSION_TWO}`, {
    body: dataBody(makeSession({ id: SESSION_TWO, state: 'running', costUsd: 0.5 })),
  });
}

beforeEach(() => {
  api = mockApi();
});

afterEach(() => {
  api.restore();
});

describe('a halted run is not a failed run', () => {
  it('says halted, names the failed step, and counts the steps that never started', async () => {
    withRun(makeHaltedRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const banner = await screen.findByTestId('run-banner-halted');
    expect(banner.textContent).toContain('halted, not failed');
    expect(banner.textContent).toContain('Step 2 of 3 failed');
    expect(banner.textContent).toContain('never started');

    // The state badge says the Backend's word, not an interpretation of it.
    expect((await screen.findByTestId('run-state')).textContent).toContain('halted');
    // And nothing anywhere calls the *run* failed.
    expect(banner.textContent).not.toMatch(/the run failed|crashed/i);
  });

  it('quotes the halt reason and the step error verbatim rather than summarising them', async () => {
    withRun(makeHaltedRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    expect((await screen.findByTestId('run-halt-reason')).textContent).toContain(
      'session ended in state failed (process_crash)',
    );
    expect((await screen.findByTestId('run-step-error')).textContent).toContain('process_crash');
  });

  it('offers Resume, and says that resuming spends another session from the budget', async () => {
    withRun(makeHaltedRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const banner = await screen.findByTestId('run-banner-halted');
    expect(within(banner).getByTestId('run-resume')).toBeEnabled();
    expect(banner.textContent).toContain('new');
    expect(banner.textContent).toContain('budget of 5');
    expect(banner.textContent).toContain('Nothing is rolled back');
  });

  it('refuses to promise a resume once the session budget is gone', async () => {
    withRun(makeHaltedRun({ sessionsLaunched: 5, maxSessions: 5 }));
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const note = await screen.findByTestId('run-budget-exhausted');
    expect(note.textContent).toContain('used its whole session budget');
  });

  it('shows a step that never started as never started, not as pending work', async () => {
    withRun(makeHaltedRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const chain = await screen.findByTestId('run-chain');
    const rows = within(chain).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect((rows[2] as HTMLElement).textContent).toContain('not started');
    expect((rows[2] as HTMLElement).textContent).toContain('Never started');
  });
});

describe('the stop control', () => {
  it('is offered while a run is running, and says what stopping does before it does it', async () => {
    withRun(makeRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    await userEvent.click(await screen.findByTestId('run-stop'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Step 2 is running');
    expect(dialog.textContent).toContain('its session is ended');
    expect(dialog.textContent).toContain('disposes the Claude Code runtime');
    expect(dialog.textContent).toContain('marked stopped first');
    expect(dialog.textContent).toContain('stopping undoes nothing');
    expect(dialog.textContent).toContain('cannot be resumed');
  });

  it('posts the stop and reports what happened to the session, in the Backend’s own words', async () => {
    withRun(makeRun());
    api.on('POST', `/api/v1/agent-workflow-runs/${RUN_ID}/stop`, {
      body: {
        data: makeRun({ state: 'stopped', completedAt: '2026-08-14T09:10:00.000Z' }),
        meta: { stoppedSession: { sessionId: SESSION_TWO, outcome: 'ended' } },
      },
    });
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    await userEvent.click(await screen.findByTestId('run-stop'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST' && call.url.includes('/stop'))).toBe(
        true,
      );
    });
    await screen.findByText(/session was ended and its runtime disposed/i);
  });

  it('does not claim the process stopped when the launch had not started', async () => {
    withRun(makeRun());
    api.on('POST', `/api/v1/agent-workflow-runs/${RUN_ID}/stop`, {
      body: {
        data: makeRun({ state: 'stopped' }),
        meta: { stoppedSession: { sessionId: SESSION_TWO, outcome: 'left_unstarted' } },
      },
    });
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    await userEvent.click(await screen.findByTestId('run-stop'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));

    await screen.findByText(/had not started yet/i);
  });

  it('is offered on a halted run and withheld from a terminal one', async () => {
    withRun(makeHaltedRun());
    const halted = renderWorkflows(`/agents/runs/${RUN_ID}`);
    expect(await screen.findByTestId('run-stop')).toBeTruthy();
    halted.unmount();

    api.on('GET', `/api/v1/agent-workflow-runs/${RUN_ID}`, {
      body: dataBody(makeRun({ state: 'completed', completedAt: '2026-08-14T09:20:00.000Z' })),
    });
    renderWorkflows(`/agents/runs/${RUN_ID}`);
    await screen.findByTestId('run-banner-completed');
    expect(screen.queryByTestId('run-stop')).toBeNull();
  });

  it('contradicts a stop that left the session running', async () => {
    withRun(
      makeRun({
        state: 'stopped',
        completedAt: '2026-08-14T09:10:00.000Z',
        steps: [
          makeRunStep(),
          makeRunStep({
            ordinal: 1,
            agentId: QA_ID,
            sessionId: SESSION_TWO,
            state: 'stopped',
            completedAt: '2026-08-14T09:10:00.000Z',
          }),
        ],
      }),
    );
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    // The run says the step is stopped; the Session fixture says it is still running.
    const disagreement = await screen.findByTestId('run-step-disagreement');
    expect(disagreement.textContent).toContain('still ‹running›');
    expect(disagreement.textContent).toContain('open it and end it there');
  });
});

describe('a run still going', () => {
  it('says which step is running and that the chain waits for the operator to end it', async () => {
    withRun(makeRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const banner = await screen.findByTestId('run-banner-running');
    expect(banner.textContent).toContain('Step 2 of 2');
    expect(banner.textContent).toContain('advances when you end this step’s session');
    expect(within(banner).getByRole('link', { name: /Open step 2 session/ })).toBeTruthy();
  });

  it('links every attempted step to its own session and shows that session’s state and cost', async () => {
    withRun(makeRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const links = await screen.findAllByTestId('run-step-session-link');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe(`/sessions/${SESSION_ONE}`);
    expect(links[1]?.getAttribute('href')).toBe(`/sessions/${SESSION_TWO}`);

    // The Session's own F7 badge, beside the run's account of the step.
    await waitFor(() => expect(screen.getAllByTitle('completed').length).toBeGreaterThan(0));
    expect(screen.getByText('$0.1234')).toBeTruthy();
  });

  it('reports the spend so far as summed from the sessions rather than from the run', async () => {
    withRun(makeRun());
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const facts = await screen.findByTestId('run-facts');
    await waitFor(() => expect(facts.textContent).toContain('$0.6234'));
    expect(facts.textContent).toContain('summed from this run’s sessions');
    expect(facts.textContent).toContain('2 launched of 5 allowed');
  });

  it('names a degraded hand-off with the reason the prompt itself carried', async () => {
    withRun(
      makeRun({
        steps: [
          makeRunStep({
            ordinal: 1,
            agentId: QA_ID,
            sessionId: SESSION_TWO,
            state: 'running',
            completedAt: null,
            handoff: {
              state: 'degraded',
              reason: 'context package unavailable: the previous session has no messages',
              promptBytes: 210,
            },
          }),
        ],
      }),
    );
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const note = await screen.findByTestId('run-step-handoff-degraded');
    expect(note.textContent).toContain('Incomplete hand-off');
    expect(note.textContent).toContain('the previous session has no messages');
  });

  it('says nothing has been said to a step whose prompt is still queued', async () => {
    withRun(
      makeRun({
        steps: [makeRunStep({ state: 'running', completedAt: null, promptSentAt: null })],
      }),
    );
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const banner = await screen.findByTestId('run-banner-running');
    expect(banner.textContent).toContain('waiting for a concurrency slot');
  });
});

describe('unbuilt and unreadable', () => {
  it('names the missing route rather than showing an empty run', async () => {
    api.on('GET', `/api/v1/agent-workflow-runs/${RUN_ID}`, {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no route', requestId: 'test-req' } },
    });
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const note = await screen.findByTestId('run-route-missing');
    expect(note.textContent).toContain('does not serve');
  });

  it('renders an unrecognised run state verbatim and offers nothing that depends on knowing it', async () => {
    withRun(makeRun({ state: 'quiesced' }));
    renderWorkflows(`/agents/runs/${RUN_ID}`);

    const banner = await screen.findByTestId('run-banner-unknown');
    expect(banner.textContent).toContain('‹quiesced›');
    expect(screen.queryByTestId('run-stop')).toBeNull();
    expect(screen.queryByTestId('run-resume')).toBeNull();
  });
});
