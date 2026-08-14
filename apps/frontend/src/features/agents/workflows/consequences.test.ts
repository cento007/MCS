import { describe, expect, it } from 'vitest';
import { type AgentView, readAgent } from '../../../lib/agents/index.js';
import { capabilitiesOf, positionList, runConsequences } from './consequences.js';
import { readWorkflow, type WorkflowStepView } from './shape.js';
import {
  DEVELOPER_ID,
  makeReadOnlyAgent,
  makeShellAgent,
  makeWorkflow,
  QA_ID,
} from './test-support.js';

function agentOf(raw: Record<string, unknown>): AgentView {
  const agent = readAgent(raw);
  if (agent === null) throw new Error('fixture is not a readable agent');
  return agent;
}

function stepsOf(overrides: Record<string, unknown> = {}): readonly WorkflowStepView[] {
  return readWorkflow(makeWorkflow(overrides))?.steps ?? [];
}

const shell = agentOf(makeShellAgent());
const readOnly = agentOf(makeReadOnlyAgent());

const lookup = (agents: readonly AgentView[]) => (agentId: string) =>
  agents.find((agent) => agent.id === agentId) ?? null;

describe('capabilitiesOf', () => {
  it('says what shell actually grants, in the words that matter', () => {
    const capabilities = capabilitiesOf(shell);
    expect(capabilities.canShell).toBe(true);
    expect(capabilities.summary).toContain('commit, push and merge');
  });

  it('says a read-only agent cannot commit, rather than staying silent about it', () => {
    const capabilities = capabilitiesOf(readOnly);
    expect(capabilities.canWrite).toBe(false);
    expect(capabilities.summary).toContain('Reads files only');
    expect(capabilities.removes).toContain('Bash');
  });

  it('reports enforcement as unknown when the Backend served no disallowedTools', () => {
    const { disallowedTools: _dropped, ...rest } = makeReadOnlyAgent();
    expect(capabilitiesOf(agentOf(rest)).removes).toBeNull();
  });
});

describe('runConsequences', () => {
  it('numbers steps from the ordinal and locates the dangerous ones', () => {
    const consequences = runConsequences(stepsOf(), lookup([shell, readOnly]));
    expect(consequences.steps.map((entry) => entry.position)).toEqual([1, 2]);
    expect(consequences.shellPositions).toEqual([1]);
    expect(consequences.writePositions).toEqual([1]);
    expect(consequences.requiresAcknowledgement).toBe(true);
  });

  it('needs no acknowledgement for a chain that can only read', () => {
    const consequences = runConsequences(
      stepsOf({
        steps: [
          { ordinal: 0, agentId: QA_ID, agentName: 'QA', agentArchivedAt: null },
          { ordinal: 1, agentId: QA_ID, agentName: 'QA', agentArchivedAt: null },
        ],
      }),
      lookup([readOnly]),
    );
    expect(consequences.shellPositions).toEqual([]);
    expect(consequences.writePositions).toEqual([]);
    expect(consequences.requiresAcknowledgement).toBe(false);
  });

  it('refuses to describe a step whose agent it could not read, and blocks on it', () => {
    const consequences = runConsequences(stepsOf(), lookup([shell]));
    const unresolved = consequences.steps[1];
    expect(unresolved?.agent).toBeNull();
    expect(unresolved?.summary).toContain('could not be read');
    expect(consequences.unresolvedPositions).toEqual([2]);
    expect(consequences.requiresAcknowledgement).toBe(true);
  });

  it('flags a step naming an archived agent from the step’s own field', () => {
    const consequences = runConsequences(
      stepsOf({
        steps: [
          {
            ordinal: 0,
            agentId: DEVELOPER_ID,
            agentName: 'Developer',
            agentArchivedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
      lookup([shell]),
    );
    expect(consequences.archivedPositions).toEqual([1]);
  });

  it('flags a step whose agent has no served deny list as unproven rather than safe', () => {
    const { disallowedTools: _dropped, ...rest } = makeShellAgent();
    const consequences = runConsequences(
      stepsOf({
        steps: [
          { ordinal: 0, agentId: DEVELOPER_ID, agentName: 'Developer', agentArchivedAt: null },
        ],
      }),
      lookup([agentOf(rest)]),
    );
    expect(consequences.toolsNotStatedPositions).toEqual([1]);
    expect(consequences.requiresAcknowledgement).toBe(true);
  });
});

describe('positionList', () => {
  it('reads as prose rather than as a filename', () => {
    expect(positionList([])).toBe('');
    expect(positionList([2])).toBe('2');
    expect(positionList([1, 2])).toBe('1 and 2');
    expect(positionList([1, 2, 4])).toBe('1, 2 and 4');
  });
});
