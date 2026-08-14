import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeProject,
  makeReadOnlyAgent,
  makeShellAgent,
  makeWorkflow,
  mockApi,
  PROJECT_ID,
  QA_ID,
  RUN_ID,
  renderWorkflows,
  WORKFLOW_ID,
} from './test-support.js';

/**
 * The pre-run confirmation — **what the operator is about to set off**.
 *
 * These are the assertions that matter most in this feature: a run spends real money and writes
 * real code, so the dialog has to state how many sessions, which agents, in what order, what each
 * one is permitted to do, and in which directory — before the button works.
 */

let api: ApiMock;

function withWorkflow(workflow: Record<string, unknown> = makeWorkflow()): void {
  api.on('GET', '/api/v1/agent-workflows?', { body: listBody([workflow]) });
  api.on('GET', `/api/v1/agent-workflows/${WORKFLOW_ID}`, { body: dataBody(workflow) });
  api.on('GET', '/agent-workflow-runs', { body: listBody([]) });
  api.on('GET', '/api/v1/projects', { body: listBody([makeProject()]) });
  api.on('GET', '/api/v1/repositories', { body: listBody([]) });
  api.on('GET', '/api/v1/agents', {
    body: listBody([makeShellAgent(), makeReadOnlyAgent()]),
  });
  api.on('GET', '/cost-estimate', {
    body: dataBody({
      workflowId: WORKFLOW_ID,
      stepCount: 2,
      defaultMaxSessions: 5,
      basis: 'observed_sessions',
      steps: [],
      projected: { meanUsd: 0.42, maxUsd: 1.1, coveredSteps: 1 },
      stepsWithoutHistory: 1,
      budget: { dailyUsd: 10, spentTodayUsd: 3.42, remainingUsd: 6.58 },
    }),
  });
}

async function openDialog(): Promise<void> {
  renderWorkflows(`/agents/workflows/${WORKFLOW_ID}`);
  const button = await screen.findByTestId('open-prerun');
  await userEvent.click(button);
  await screen.findByRole('dialog');
}

beforeEach(() => {
  api = mockApi();
});

afterEach(() => {
  api.restore();
});

describe('the chain, before it runs', () => {
  it('names every step, in order, with what that step is allowed to do', async () => {
    withWorkflow();
    await openDialog();

    const steps = await screen.findAllByTestId('prerun-step');
    expect(steps).toHaveLength(2);

    expect(within(steps[0] as HTMLElement).getByText(/Developer/)).toBeTruthy();
    expect(within(steps[0] as HTMLElement).getByText(/runs any shell command/)).toBeTruthy();

    expect(within(steps[1] as HTMLElement).getByText(/QA/)).toBeTruthy();
    expect(within(steps[1] as HTMLElement).getByText(/Reads files only/)).toBeTruthy();
  });

  it('says how many sessions it creates and that nothing asks again between them', async () => {
    withWorkflow();
    await openDialog();

    const headline = await screen.findByTestId('prerun-headline');
    expect(headline.textContent).toContain('2 sessions');
    expect(headline.textContent).toContain('up to 5 in total');
    expect(headline.textContent).toContain('nothing between the steps asks you again');
  });

  it('warns that a shell step can commit, push and merge, and names the directory', async () => {
    withWorkflow();
    await openDialog();

    await userEvent.type(
      screen.getByRole('textbox', { name: /^Working directory/ }),
      'D:\\Repos\\MCS',
    );

    const warning = await screen.findByTestId('prerun-shell-warning');
    expect(warning.textContent).toContain('Step 1');
    expect(warning.textContent).toContain('any shell command');
    expect(warning.textContent).toContain('D:\\Repos\\MCS');
    expect(warning.textContent).toContain('commit, push and merge');
  });

  it('renders the tools a restricted step loses, verbatim from the Backend', async () => {
    withWorkflow();
    await openDialog();

    const tools = await screen.findAllByTestId('prerun-removed-tool');
    expect(tools.map((tool) => tool.textContent)).toContain('Bash');
  });

  it('shows what the chain has cost before, as a floor rather than a forecast', async () => {
    withWorkflow();
    await openDialog();

    const cost = await screen.findByTestId('prerun-cost');
    expect(cost.textContent).toContain('$0.4200');
    expect(cost.textContent).toContain('covers 1 of 2 steps');
    expect(cost.textContent).toContain('floor');
    expect(cost.textContent).toContain('$6.58');
  });

  it('says the cost is unknown rather than free when the estimate cannot be read', async () => {
    withWorkflow();
    api.on('GET', '/cost-estimate', { status: 404, body: { error: { code: 'NOT_FOUND' } } });
    await openDialog();

    const note = await screen.findByTestId('prerun-cost-unavailable');
    expect(note.textContent).toContain('not the same as free');
  });

  it('draws no schedule or repeat control — Phase 5 is not promised here', async () => {
    withWorkflow();
    await openDialog();

    const dialog = screen.getByRole('dialog');
    // The *word* schedule appears, in the sentence that rules scheduling out. What must not exist
    // is a control: a disabled "run nightly" switch would be a promise this product has not made.
    for (const role of ['checkbox', 'combobox', 'textbox', 'button'] as const) {
      expect(
        within(dialog).queryAllByRole(role, { name: /nightly|schedule|repeat|cron|every/i }),
      ).toHaveLength(0);
    }
    expect(dialog.textContent).toContain('A run starts because you pressed the button');
    expect(dialog.textContent).toContain('Phase 5');
  });
});

describe('starting is a deliberate act', () => {
  it('requires an acknowledgement naming the steps and the directory before it can start', async () => {
    withWorkflow();
    await openDialog();

    // A global workflow names no project, so the run has to — and the dialog says what is missing
    // rather than leaving a disabled button to be reverse-engineered.
    expect((await screen.findByTestId('prerun-blockers')).textContent).toContain(
      'choose a project',
    );

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Project/ }), PROJECT_ID);
    await userEvent.type(screen.getByRole('textbox', { name: /^Task/ }), 'Add rate limiting.');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Working directory/ }),
      'D:\\Repos\\MCS',
    );

    const start = screen.getByTestId('start-run');
    expect(start).toBeDisabled();
    expect(screen.getByTestId('prerun-blockers').textContent).toContain('tick the acknowledgement');

    const acknowledgement = screen.getByTestId('prerun-acknowledgement');
    expect(acknowledgement.textContent).toContain('step 1');
    expect(acknowledgement.textContent).toContain('commit, push and merge');
    expect(acknowledgement.textContent).toContain('D:\\Repos\\MCS');
    expect(acknowledgement.textContent).toContain('up to 5 sessions');

    await userEvent.click(within(acknowledgement).getByRole('checkbox'));
    expect(screen.getByTestId('start-run')).toBeEnabled();
  });

  it('needs no acknowledgement when nothing in the chain can write', async () => {
    withWorkflow(
      makeWorkflow({
        steps: [
          {
            ordinal: 0,
            agentId: QA_ID,
            agentName: 'QA',
            agentScope: 'global',
            agentProjectId: null,
            agentArchivedAt: null,
            instructions: null,
          },
        ],
        stepCount: 1,
      }),
    );
    await openDialog();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Project/ }), PROJECT_ID);
    await userEvent.type(screen.getByRole('textbox', { name: /^Task/ }), 'Review it.');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Working directory/ }),
      'D:\\Repos\\MCS',
    );

    expect(screen.queryByTestId('prerun-acknowledgement')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('start-run')).toBeEnabled());
  });

  it('posts the run to /agent-workflow-runs with the four required fields', async () => {
    withWorkflow();
    api.on('POST', '/api/v1/agent-workflow-runs', {
      status: 201,
      body: dataBody({ id: RUN_ID, workflowId: WORKFLOW_ID, state: 'running', steps: [] }),
    });
    await openDialog();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Project/ }), PROJECT_ID);
    await userEvent.type(screen.getByRole('textbox', { name: /^Task/ }), 'Add rate limiting.');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Working directory/ }),
      'D:\\Repos\\MCS',
    );
    await userEvent.click(
      within(screen.getByTestId('prerun-acknowledgement')).getByRole('checkbox'),
    );
    await userEvent.click(screen.getByTestId('start-run'));

    await waitFor(() => {
      const posted = api.calls.find(
        (call) => call.method === 'POST' && call.url.includes('/agent-workflow-runs'),
      );
      expect(posted?.body).toMatchObject({
        workflowId: WORKFLOW_ID,
        projectId: PROJECT_ID,
        task: 'Add rate limiting.',
        workingDirectory: 'D:\\Repos\\MCS',
        maxSessions: 5,
      });
    });
  });

  it('refuses to start a chain naming an archived agent, and says which step', async () => {
    withWorkflow(
      makeWorkflow({
        steps: [
          {
            ordinal: 0,
            agentId: QA_ID,
            agentName: 'QA',
            agentScope: 'global',
            agentProjectId: null,
            agentArchivedAt: '2026-08-01T00:00:00.000Z',
            instructions: null,
          },
        ],
        stepCount: 1,
      }),
    );
    await openDialog();

    const blocker = await screen.findByTestId('prerun-archived-agent');
    expect(blocker.textContent).toContain('Step 1');
    expect(screen.getByTestId('start-run')).toBeDisabled();
  });

  it('says so, and blocks, when a step’s agent cannot be read at all', async () => {
    withWorkflow();
    api.on('GET', '/api/v1/agents', { body: listBody([makeShellAgent()]) });
    await openDialog();

    const note = await screen.findByTestId('prerun-unresolved');
    expect(note.textContent).toContain('Step 2 names an agent');
    expect(note.textContent).toContain('cannot tell you what starting costs you in permissions');
  });
});
