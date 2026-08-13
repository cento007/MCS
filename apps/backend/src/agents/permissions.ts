import type { AgentPermissions } from '@mc/shared';

/**
 * **The only place agent permissions become something a runtime enforces** — PRD §5.5 mapped onto
 * the F1.5 control surfaces (`--disallowedTools`, and `--strict-mcp-config` for the hole it
 * would otherwise leave).
 *
 * F1.5 named this mapping as Phase 4 work and reserved the interface: "the runtime's control
 * surfaces … are the designated enforcement mechanism onto which the Agent permissions entity
 * (PRD §5.5) will map. Phase 1 uses static defaults; the interface is reserved, not designed."
 * This is that design.
 *
 * ## The rule: agent permissions are subtractive
 *
 * A permission that is **granted** changes nothing relative to a Session launched with no agent —
 * the tool is simply not in the deny list, and whether the model may actually use it is still
 * decided by `permissionMode` and the operator's own Claude Code settings. A permission that is
 * **denied** removes the tools that could achieve it from the model's context.
 *
 * That inversion is deliberate. Mission Control can therefore never *widen* what an operator's
 * machine already allows: there is no `allowedTools` here and no `canUseTool` handler, because
 * both of those auto-approve, and auto-approval dressed up as a permission model is how a console
 * ends up running arbitrary commands unattended because someone ticked a box labelled "Commit".
 *
 * ## Why `Bash` appears under all three capabilities
 *
 * A shell can read a file (`cat`), write one (`>`) and commit one (`git commit`). So a denial of
 * `read` or `write` that left `Bash` available would not hold, and the operator would be told
 * "read-only" while the agent edits the tree. `AgentPermissions` therefore forbids
 * `shell: true` without `read` and `write` (`isEnforceableAgentPermissions`), and this function
 * denies `Bash` whenever any of the three is denied. The consequence, stated plainly rather than
 * hidden: **`repository.shell` grants PRD §5.5's Commit, Create PR, Merge and Delete together.**
 * Splitting them would mean deciding permissions by parsing shell command strings, and
 * `sh -c 'git merge'` defeats that in one move.
 *
 * ## Two limits worth naming rather than papering over
 *
 *  1. **Subagents.** `Task` spawns a subagent whose tool set is the harness's business, not ours,
 *     and we have not proven that a session-level deny list reaches it. So `Task` is denied
 *     whenever anything else is — the conservative reading of an unproven propagation.
 *  2. **MCP tools.** An operator's own `.mcp.json` / settings can contribute tools with arbitrary
 *     names (`mcp__server__write_file`) that no built-in deny list mentions. `strictMcpConfig`
 *     closes that: with it set and no `mcpServers` passed, on-disk MCP configuration is ignored
 *     entirely. It is switched on for exactly the sessions that deny something, so an
 *     unrestricted agent keeps the operator's MCP servers and a restricted one cannot be
 *     circumvented through them.
 *
 * Tool names are Claude Code's and are runtime-version-dependent, which is why they live in this
 * adapter-shaped module and not in `@mc/shared` — the same reasoning as `FILE_NAMING_TOOLS` in
 * `sessions/managed/content.ts`.
 */

/** File reads. `NotebookRead` is a legacy name kept because denying a tool that no longer exists is free. */
const READ_TOOLS = ['Glob', 'Grep', 'NotebookRead', 'Read'] as const;

/** File writes. `MultiEdit` is likewise a legacy name. */
const WRITE_TOOLS = ['Edit', 'MultiEdit', 'NotebookEdit', 'Write'] as const;

/** Command execution and its session-management siblings — the universal escape hatch. */
const SHELL_TOOLS = ['Bash', 'BashOutput', 'KillBash', 'KillShell'] as const;

/**
 * Delegation. Denied whenever anything is denied, because a subagent's tool set is not something
 * this deny list has been shown to reach (see the header).
 */
const DELEGATION_TOOLS = ['Agent', 'Task'] as const;

/**
 * The tools a Session running as this Agent must not have.
 *
 * Sorted and de-duplicated so the value is stable — it is serialised into the `Agent` resource,
 * which makes the enforcement auditable from the API rather than a claim the operator has to
 * take on trust.
 */
export function disallowedToolsFor(permissions: AgentPermissions): readonly string[] {
  const { read, write, shell } = permissions.repository;
  const denied = new Set<string>();

  if (!read) for (const tool of READ_TOOLS) denied.add(tool);
  if (!write) for (const tool of WRITE_TOOLS) denied.add(tool);
  // `read`/`write` imply this too — `isEnforceableAgentPermissions` guarantees `shell` cannot
  // outlive them — but stating all three keeps the mapping readable one capability at a time.
  if (!shell || !read || !write) for (const tool of SHELL_TOOLS) denied.add(tool);
  if (!read || !write || !shell) for (const tool of DELEGATION_TOOLS) denied.add(tool);

  return [...denied].sort();
}

/**
 * Whether this Agent restricts anything at all.
 *
 * Drives `strictMcpConfig`: an agent that denies nothing is indistinguishable from no agent as
 * far as tools go, so it keeps the operator's MCP servers. One that denies something must not be
 * routed around by them.
 */
export function restrictsAnything(permissions: AgentPermissions): boolean {
  const { read, write, shell } = permissions.repository;
  return !read || !write || !shell;
}
