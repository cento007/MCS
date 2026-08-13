import { describe, expect, it } from 'vitest';
import { buildSessionQueryOptions } from './claude-agent-runtime.js';
import type { AgentSessionOptions } from './runtime-events.js';

/**
 * **"The agent's instructions reach the runtime" asserted against the actual SDK argument.**
 *
 * Everything else in the Agent vertical can be checked through a fake — the port records what it
 * was launched with, and `agents.int.test.ts` reads it back. This file is the last link: the
 * object literal handed to `query({ options })`. Nothing downstream of it is ours, so if the
 * persona is not in *this* object it is nowhere.
 *
 * No child process is spawned and no network call is made: `buildSessionQueryOptions` exists so
 * the mapping can be inspected rather than inferred (see its header).
 */

function session(overrides: Partial<AgentSessionOptions> = {}): AgentSessionOptions {
  return {
    sessionId: '018f0000-0000-7000-8000-000000000001',
    workingDirectory: '/repo',
    model: null,
    resume: null,
    fork: false,
    systemPromptAppend: null,
    disallowedTools: [],
    strictMcpConfig: false,
    ...overrides,
  };
}

describe('a Session with no Agent', () => {
  it('names none of the three agent options at all', () => {
    const options = buildSessionQueryOptions(session());

    // Absent, not `undefined`-valued: binding no agent has to leave the SDK on exactly the
    // behaviour every Session had before Phase 4, and an explicit `systemPrompt: undefined` is a
    // different statement from not passing one.
    expect('systemPrompt' in options).toBe(false);
    expect('disallowedTools' in options).toBe(false);
    expect('strictMcpConfig' in options).toBe(false);
  });

  it('still carries the Phase 1 options', () => {
    expect(buildSessionQueryOptions(session())).toMatchObject({
      cwd: '/repo',
      includePartialMessages: true,
      permissionMode: 'acceptEdits',
      settingSources: ['user', 'project', 'local'],
    });
  });
});

describe('a Session bound to an Agent', () => {
  const instructions = 'You are the Architect. Refuse to write code; produce ADRs.';

  it('appends the instructions to Claude Code’s own system prompt', () => {
    const options = buildSessionQueryOptions(session({ systemPromptAppend: instructions }));

    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: instructions,
    });
  });

  it('does not replace the runtime’s prompt with the persona', () => {
    // A bare string `systemPrompt` would discard Claude Code's own prompt — its tool
    // conventions, its CLAUDE.md handling — and a persona is meant to steer that, not delete it.
    const options = buildSessionQueryOptions(session({ systemPromptAppend: instructions }));

    expect(typeof options.systemPrompt).toBe('object');
  });

  it('passes the deny list through verbatim', () => {
    const options = buildSessionQueryOptions(
      session({ disallowedTools: ['Bash', 'Edit', 'Write'] }),
    );

    expect(options.disallowedTools).toEqual(['Bash', 'Edit', 'Write']);
  });

  it('ignores on-disk MCP configuration for a restricted agent', () => {
    // Without this, an `mcp__server__write_file` named in the operator's own settings would sit
    // outside a deny list that only knows built-in tool names.
    expect(buildSessionQueryOptions(session({ strictMcpConfig: true })).strictMcpConfig).toBe(true);
  });

  it('leaves permissionMode alone — agent permissions only ever subtract', () => {
    // Raising the mode for an agent would auto-approve *more* than a Session without one gets.
    const restricted = buildSessionQueryOptions(
      session({
        systemPromptAppend: instructions,
        disallowedTools: ['Bash'],
        strictMcpConfig: true,
      }),
    );

    expect(restricted.permissionMode).toBe(buildSessionQueryOptions(session()).permissionMode);
  });

  it('composes with resume and fork rather than displacing them', () => {
    const options = buildSessionQueryOptions(
      session({ resume: 'runtime-uuid', fork: true, systemPromptAppend: instructions }),
    );

    expect(options).toMatchObject({
      resume: 'runtime-uuid',
      forkSession: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
    });
  });
});
