import { MAX_AGENT_WORKFLOW_RUN_SESSIONS, MAX_AGENT_WORKFLOW_STEPS } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../http/errors.js';
import {
  assertMaxSessions,
  assertStepCount,
  assertWorkflowScopeTarget,
  normalizeRunTask,
  normalizeStepInstructions,
  normalizeWorkflowName,
} from './validation.js';

/**
 * Workflow field rules, unit tier — no database, no Fastify.
 *
 * The two rules worth testing here are the ones the database cannot state: a row cannot count its
 * siblings, so "a chain has at least one step" and "a Session budget can pay for the chain" exist
 * only in this file, and both are refusals an operator would otherwise discover as a run that
 * finishes instantly or strands halfway.
 */

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

describe('names and text', () => {
  it('trims a name and refuses a blank one', () => {
    expect(normalizeWorkflowName('  Review chain  ')).toBe('Review chain');
    expect(codeOf(() => normalizeWorkflowName('   '))).toBe('VALIDATION_FAILED');
  });

  it('collapses blank step instructions to null — one representation for "unset"', () => {
    expect(normalizeStepInstructions('   ')).toBeNull();
    expect(normalizeStepInstructions(undefined)).toBeNull();
    expect(normalizeStepInstructions(' review it ')).toBe('review it');
  });

  it('refuses a blank run task, because it is the only brief step 1 gets', () => {
    expect(codeOf(() => normalizeRunTask('  '))).toBe('VALIDATION_FAILED');
    expect(normalizeRunTask(' ship it ')).toBe('ship it');
  });
});

describe('scope and its target', () => {
  it('accepts the two legal pairings', () => {
    expect(() => {
      assertWorkflowScopeTarget({ scope: 'global', projectId: null });
    }).not.toThrow();
    expect(() => {
      assertWorkflowScopeTarget({ scope: 'project', projectId: 'p' });
    }).not.toThrow();
  });

  it('refuses a project workflow with no project, and a global one with one', () => {
    expect(codeOf(() => assertWorkflowScopeTarget({ scope: 'project', projectId: null }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codeOf(() => assertWorkflowScopeTarget({ scope: 'global', projectId: 'p' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('the step count', () => {
  it('refuses an empty chain — it would start, launch nothing and complete instantly', () => {
    expect(codeOf(() => assertStepCount(0))).toBe('VALIDATION_FAILED');
  });

  it('refuses more steps than the ordinal CHECK can store', () => {
    expect(() => {
      assertStepCount(MAX_AGENT_WORKFLOW_STEPS);
    }).not.toThrow();
    expect(codeOf(() => assertStepCount(MAX_AGENT_WORKFLOW_STEPS + 1))).toBe('VALIDATION_FAILED');
  });
});

describe('the session budget', () => {
  it('refuses a budget that cannot pay for the chain once', () => {
    // A run guaranteed to strand at step 4 is worse than a run that never starts.
    expect(codeOf(() => assertMaxSessions(3, 4))).toBe('VALIDATION_FAILED');
  });

  it('accepts exactly enough, and refuses more than the absolute ceiling', () => {
    expect(() => {
      assertMaxSessions(4, 4);
    }).not.toThrow();
    expect(codeOf(() => assertMaxSessions(MAX_AGENT_WORKFLOW_RUN_SESSIONS + 1, 4))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
