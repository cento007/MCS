import { agentPermissionsFromTemplate, normalizeAgentPermissions } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { disallowedToolsFor, restrictsAnything } from './permissions.js';

/**
 * The permission → tool mapping is the whole of PRD §5.5 as this build can enforce it, so these
 * assertions are the specification of what an operator is actually promised.
 *
 * Two properties matter more than any individual row:
 *
 *   1. **`Bash` is denied unless everything is granted.** A shell defeats a file-read denial and
 *      a file-write denial alike, so any restriction at all has to take it away.
 *   2. **A `full` agent denies nothing.** Otherwise binding an agent would quietly be a downgrade,
 *      and "this session behaves exactly as one with no agent, plus a persona" would be false.
 */

const READ_ONLY = agentPermissionsFromTemplate('read_only');
const READ_WRITE = agentPermissionsFromTemplate('read_write');
const FULL = agentPermissionsFromTemplate('full');
const NOTHING = normalizeAgentPermissions({});

describe('disallowedToolsFor', () => {
  it('denies nothing for an agent that grants everything', () => {
    expect(disallowedToolsFor(FULL)).toEqual([]);
    expect(restrictsAnything(FULL)).toBe(false);
  });

  it('takes the shell away from read_write, and with it commit/PR/merge/delete', () => {
    // PRD §5.5's four git capabilities have no tool of their own — they are `git`/`gh` through
    // Bash. Denying Bash is the only sound way to deny them, and it is what `shell: false` means.
    expect(disallowedToolsFor(READ_WRITE)).toEqual([
      'Agent',
      'Bash',
      'BashOutput',
      'KillBash',
      'KillShell',
      'Task',
    ]);
  });

  it('takes the write tools as well as the shell away from read_only', () => {
    expect(disallowedToolsFor(READ_ONLY)).toEqual([
      'Agent',
      'Bash',
      'BashOutput',
      'Edit',
      'KillBash',
      'KillShell',
      'MultiEdit',
      'NotebookEdit',
      'Task',
      'Write',
      // No `Read`/`Grep`/`Glob`: read_only grants reads.
    ]);
  });

  it('leaves an agent that grants nothing with no file or shell tool at all', () => {
    const denied = disallowedToolsFor(NOTHING);

    for (const tool of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash']) {
      expect(denied).toContain(tool);
    }
  });

  it('denies Bash for every set that is not fully granted', () => {
    // The load-bearing property, asserted across the whole lattice rather than per template:
    // there is no combination in which a restriction survives while a shell is available.
    for (const read of [true, false]) {
      for (const write of [true, false]) {
        for (const shell of [true, false]) {
          const permissions = normalizeAgentPermissions({ repository: { read, write, shell } });
          const denied = disallowedToolsFor(permissions);
          const unrestricted = read && write && shell;

          expect({ read, write, shell, bashDenied: denied.includes('Bash') }).toEqual({
            read,
            write,
            shell,
            bashDenied: !unrestricted,
          });
        }
      }
    }
  });

  it('denies delegation whenever anything else is denied', () => {
    // A subagent's tool set is the harness's business, and we have not shown that a session-level
    // deny list reaches it. Unproven propagation is treated as no propagation.
    expect(disallowedToolsFor(READ_ONLY)).toContain('Task');
    expect(disallowedToolsFor(READ_WRITE)).toContain('Task');
    expect(disallowedToolsFor(FULL)).not.toContain('Task');
  });

  it('returns a sorted, duplicate-free list', () => {
    for (const permissions of [NOTHING, READ_ONLY, READ_WRITE, FULL]) {
      const denied = disallowedToolsFor(permissions);
      expect(denied).toEqual([...denied].sort());
      expect(new Set(denied).size).toBe(denied.length);
    }
  });
});

describe('restrictsAnything', () => {
  it('is exactly "the deny list is non-empty"', () => {
    // The two drive different SDK options (`disallowedTools`, `strictMcpConfig`) and must agree:
    // an agent whose built-in tools are restricted must not be reachable through an MCP tool.
    for (const permissions of [NOTHING, READ_ONLY, READ_WRITE, FULL]) {
      expect(restrictsAnything(permissions)).toBe(disallowedToolsFor(permissions).length > 0);
    }
  });
});
