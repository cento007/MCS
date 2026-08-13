import { describe, expect, it } from 'vitest';
import {
  AGENT_PERMISSION_TEMPLATES,
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  agentPermissionsFromTemplate,
  isAgentPermissionTemplate,
  isAgentRuntime,
  isAgentScope,
  isEnforceableAgentPermissions,
  normalizeAgentPermissions,
} from './agent.js';

/**
 * The Agent vocabulary is data plus pure functions, so all of it is testable with no database.
 *
 * What is actually being pinned here is the **deny bias**: every path through
 * `normalizeAgentPermissions` must produce an agent that is at most as capable as the input
 * claimed, never more. That is the property the whole permission model rests on — the mapper, the
 * serializer and the launch binding all call this function on untrusted JSONB.
 */

describe('vocabulary', () => {
  it('is PRD §5.2 verbatim, and admits nothing else', () => {
    expect(AGENT_SCOPES).toEqual(['global', 'project', 'session']);
    expect(isAgentScope('project')).toBe(true);
    expect(isAgentScope('workspace')).toBe(false);
    expect(isAgentScope(42)).toBe(false);
  });

  it('names one runtime, because one runtime is launchable', () => {
    // PRD §5.4 also lists Ollama. It is absent on purpose: `ManagedRuntime` drives the Claude
    // Agent SDK for every managed Session, so an agent stored as `ollama` would silently run on
    // Claude Code. This assertion is what would fail if someone widened the list without
    // building the runtime behind it.
    expect(AGENT_RUNTIMES).toEqual(['claude_code']);
    expect(isAgentRuntime('ollama')).toBe(false);
  });

  it('recognises its three templates and nothing else', () => {
    expect(AGENT_PERMISSION_TEMPLATES).toEqual(['read_only', 'read_write', 'full']);
    expect(isAgentPermissionTemplate('full')).toBe(true);
    expect(isAgentPermissionTemplate('admin')).toBe(false);
  });
});

describe('permission templates', () => {
  it('climbs one capability at a time', () => {
    expect(agentPermissionsFromTemplate('read_only')).toEqual({
      repository: { read: true, write: false, shell: false },
    });
    expect(agentPermissionsFromTemplate('read_write')).toEqual({
      repository: { read: true, write: true, shell: false },
    });
    expect(agentPermissionsFromTemplate('full')).toEqual({
      repository: { read: true, write: true, shell: true },
    });
  });

  it('produces only enforceable sets', () => {
    for (const template of AGENT_PERMISSION_TEMPLATES) {
      expect(isEnforceableAgentPermissions(agentPermissionsFromTemplate(template))).toBe(true);
    }
  });
});

describe('normalizeAgentPermissions', () => {
  it('denies everything it cannot read', () => {
    const denied = { repository: { read: false, write: false, shell: false } };

    for (const junk of [undefined, null, 'nonsense', 42, [], {}, { repository: 'yes' }]) {
      expect(normalizeAgentPermissions(junk)).toEqual(denied);
    }
  });

  it('treats anything but `true` as not granted', () => {
    // A stored `"true"` or `1` must not read as a grant: JSONB is untyped enough that a hand-
    // edited row could carry either, and coercing them would widen an agent by accident.
    expect(
      normalizeAgentPermissions({ repository: { read: 'true', write: 1, shell: 'yes' } }),
    ).toEqual({ repository: { read: false, write: false, shell: false } });
  });

  it('drops a shell grant that outlives read or write, rather than implying them', () => {
    // The deny-biased half of the invariant: `{ read: false, shell: true }` describes a
    // restriction the runtime cannot deliver, and the safe repair is to remove the shell, not to
    // grant the reads it implies.
    expect(
      normalizeAgentPermissions({ repository: { read: false, write: true, shell: true } }),
    ).toEqual({ repository: { read: false, write: true, shell: false } });

    expect(
      normalizeAgentPermissions({ repository: { read: true, write: false, shell: true } }),
    ).toEqual({ repository: { read: true, write: false, shell: false } });
  });

  it('is idempotent — its output is a fixed point', () => {
    for (const template of AGENT_PERMISSION_TEMPLATES) {
      const once = agentPermissionsFromTemplate(template);
      expect(normalizeAgentPermissions(once)).toEqual(once);
    }
  });

  it('never produces an unenforceable set, whatever it is fed', () => {
    for (const read of [true, false]) {
      for (const write of [true, false]) {
        for (const shell of [true, false]) {
          const normalized = normalizeAgentPermissions({ repository: { read, write, shell } });
          expect(isEnforceableAgentPermissions(normalized)).toBe(true);
        }
      }
    }
  });
});
