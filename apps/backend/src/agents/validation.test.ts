import { MAX_AGENT_INSTRUCTIONS_LENGTH, MAX_AGENT_NAME_LENGTH } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import {
  assertScopeTarget,
  normalizeAgentDescription,
  normalizeAgentInstructions,
  normalizeAgentName,
  normalizeRequestedPermissions,
} from './validation.js';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  throw new Error('expected an ApiError');
}

function fieldOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error.details?.['field'];
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('text fields', () => {
  it('trims a name and refuses a blank one', () => {
    expect(normalizeAgentName('  Architect  ')).toBe('Architect');
    expect(codeOf(() => normalizeAgentName('   '))).toBe('VALIDATION_FAILED');
  });

  it('refuses a name past the storage bound rather than truncating it', () => {
    // Truncation would store something the operator did not type and then enforce uniqueness on
    // it, which is how two different agents end up sharing a name.
    expect(codeOf(() => normalizeAgentName('a'.repeat(MAX_AGENT_NAME_LENGTH + 1)))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('collapses empty and whitespace-only optional text to null', () => {
    // One storage representation for "unset", so `description IS NULL` is the whole question.
    for (const blank of [undefined, null, '', '   ', '\n\t']) {
      expect(normalizeAgentDescription(blank)).toBeNull();
      expect(normalizeAgentInstructions(blank)).toBeNull();
    }
  });

  it('refuses instructions past the context budget', () => {
    expect(
      codeOf(() => normalizeAgentInstructions('x'.repeat(MAX_AGENT_INSTRUCTIONS_LENGTH + 1))),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('assertScopeTarget (PRD §5.2)', () => {
  it('accepts each scope with exactly its own target', () => {
    expect(() =>
      assertScopeTarget({ scope: 'global', projectId: null, sessionId: null }),
    ).not.toThrow();
    expect(() =>
      assertScopeTarget({ scope: 'project', projectId: 'p', sessionId: null }),
    ).not.toThrow();
    expect(() =>
      assertScopeTarget({ scope: 'session', projectId: null, sessionId: 's' }),
    ).not.toThrow();
  });

  it('refuses a scoped agent with no target', () => {
    expect(
      fieldOf(() => assertScopeTarget({ scope: 'project', projectId: null, sessionId: null })),
    ).toBe('projectId');
    expect(
      fieldOf(() => assertScopeTarget({ scope: 'session', projectId: null, sessionId: null })),
    ).toBe('sessionId');
  });

  it('refuses a target the scope does not admit', () => {
    // These are the cases the database also refuses (`ck_agents_scope_target`). The point of
    // duplicating them here is the message: a constraint violation names a constraint, not a
    // field, and would reach the operator as DATABASE_SCHEMA_MISMATCH.
    expect(
      fieldOf(() => assertScopeTarget({ scope: 'global', projectId: 'p', sessionId: null })),
    ).toBe('projectId');
    expect(
      fieldOf(() => assertScopeTarget({ scope: 'global', projectId: null, sessionId: 's' })),
    ).toBe('sessionId');
    expect(
      fieldOf(() => assertScopeTarget({ scope: 'project', projectId: 'p', sessionId: 's' })),
    ).toBe('sessionId');
    expect(
      fieldOf(() => assertScopeTarget({ scope: 'session', projectId: 'p', sessionId: 's' })),
    ).toBe('projectId');
  });
});

describe('normalizeRequestedPermissions', () => {
  it('canonicalises a partial document into all three booleans', () => {
    expect(normalizeRequestedPermissions({ repository: { read: true } })).toEqual({
      repository: { read: true, write: false, shell: false },
    });
  });

  it('reads an empty document as granting nothing', () => {
    expect(normalizeRequestedPermissions({})).toEqual({
      repository: { read: false, write: false, shell: false },
    });
  });

  it('refuses a shell grant without read and write instead of quietly dropping it', () => {
    // The difference between this and `normalizeAgentPermissions`: a stored row is *repaired*
    // (deny-biased), a request is *answered*. An operator who asked for shell and silently got a
    // narrower agent would believe the agent can run commands.
    const code = codeOf(() =>
      normalizeRequestedPermissions({ repository: { read: true, write: false, shell: true } }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('accepts a shell grant that carries read and write', () => {
    expect(
      normalizeRequestedPermissions({ repository: { read: true, write: true, shell: true } }),
    ).toEqual({ repository: { read: true, write: true, shell: true } });
  });
});
