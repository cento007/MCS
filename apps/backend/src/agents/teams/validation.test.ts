import { MAX_AGENT_TEAM_DESCRIPTION_LENGTH, MAX_AGENT_TEAM_NAME_LENGTH } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../http/errors.js';
import {
  assertTeamScopeTarget,
  normalizeIdList,
  normalizeTeamDescription,
  normalizeTeamName,
} from './validation.js';

/**
 * The pure AgentTeam rules — no database, no Fastify, no network (TDS 07 §2.1).
 *
 * The scope⇄target rule is also a database CHECK (`ck_agent_teams_scope_target`), and the
 * integration tier proves *that* by writing rows straight past this file. What is tested here is
 * the half PostgreSQL cannot supply: which field the operator is told about.
 */

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
    expect(normalizeTeamName('  Delivery  ')).toBe('Delivery');
    expect(codeOf(() => normalizeTeamName('   '))).toBe('VALIDATION_FAILED');
  });

  it('refuses a name past the storage bound rather than truncating it', () => {
    // Truncation would store something the operator did not type and then enforce uniqueness on
    // it, which is how two different teams end up sharing a name.
    expect(codeOf(() => normalizeTeamName('a'.repeat(MAX_AGENT_TEAM_NAME_LENGTH + 1)))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('collapses empty and whitespace-only descriptions to null', () => {
    for (const blank of [undefined, null, '', '   ', '\n\t']) {
      expect(normalizeTeamDescription(blank)).toBeNull();
    }
  });

  it('refuses a description past the storage bound', () => {
    expect(
      codeOf(() => normalizeTeamDescription('a'.repeat(MAX_AGENT_TEAM_DESCRIPTION_LENGTH + 1))),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('scope and target agree', () => {
  it('accepts the two representable combinations', () => {
    expect(() => {
      assertTeamScopeTarget({ scope: 'global', projectId: null });
    }).not.toThrow();
    expect(() => {
      assertTeamScopeTarget({ scope: 'project', projectId: 'p' });
    }).not.toThrow();
  });

  it('names projectId when a project team has none', () => {
    expect(
      fieldOf(() => {
        assertTeamScopeTarget({ scope: 'project', projectId: null });
      }),
    ).toBe('projectId');
  });

  it('names projectId when a global team has one', () => {
    // A global team that names a project would be a team available everywhere whose roster is
    // only meaningful in one place.
    expect(
      fieldOf(() => {
        assertTeamScopeTarget({ scope: 'global', projectId: 'p' });
      }),
    ).toBe('projectId');
  });
});

describe('id lists are sets', () => {
  it('collapses repeats instead of rejecting them', () => {
    // `{"agentIds": ["a", "a"]}` says the same thing twice. Rejecting it would answer 409 for a
    // conflict the caller did not create; `ux_agent_team_members_team_agent` would otherwise be
    // the thing that noticed.
    expect(normalizeIdList(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('preserves the order the caller sent, so an error names ids predictably', () => {
    expect(normalizeIdList(['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
  });

  it('passes an empty list through, because empty is a meaningful roster', () => {
    // `agentIds: []` means "this team has nobody", which is different from omitting the field.
    expect(normalizeIdList([])).toEqual([]);
  });
});
