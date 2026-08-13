import { useId } from 'react';
import type { Draft } from '../../lib/forms/dirty.js';
import { BuilderSection, ToggleControl } from './fields.js';
import {
  type PermissionRow,
  type PermissionsShape,
  permissionDraftKey,
  UNMODELLED_PERMISSIONS,
} from './permissions.js';
import type { AgentFormIssue } from './shape.js';

/**
 * PRD §5.8's **Permissions** section — the part of this screen worth being careful about.
 *
 * PRD §5.5 names twelve permissions across three groups, and drawing twelve switches from that
 * list is both the obvious implementation and the wrong one: a switch reading `Merge: off` that
 * gates nothing is a safety claim, and an operator who believes it stops watching the thing it
 * claimed to stop.
 *
 * So this section renders the three the Backend actually models, says out loud which nine it does
 * not, and grounds the word "enforced" in something the API produced rather than something the
 * PRD said:
 *
 *  - **`disallowedTools`** is served on the Agent resource, derived by the same function the
 *    launch path calls and refused on write. It is the exact `--disallowedTools` list a Session
 *    running as this agent receives. Rendering it verbatim is what makes the switches auditable
 *    instead of trusted.
 *  - When that field is absent, enforcement is **not stated** — never upgraded to enforced.
 *
 * The other thing this section has to get across is the direction of the model: permissions here
 * are **subtractive**. Granting one changes nothing relative to a Session launched with no agent
 * at all; denying one removes tools. "Grant" read as "authorise" is the most likely misreading of
 * the screen, and it is the misreading that would make an operator more relaxed rather than less.
 */

export interface PermissionsSectionProps {
  readonly shape: PermissionsShape;
  readonly draft: Draft;
  readonly disabled: boolean;
  readonly mode: 'create' | 'edit';
  readonly isChanged: (name: string) => boolean;
  readonly onChange: (path: string, granted: boolean) => void;
  /** The `shell`-subsumes-read/write issue, rendered against the switch that raised it. */
  readonly issue?: AgentFormIssue | undefined;
  /** True while the permissions differ from what the served `disallowedTools` was computed from. */
  readonly toolsStale: boolean;
}

export function PermissionsSection({
  shape,
  draft,
  disabled,
  mode,
  isChanged,
  onChange,
  issue,
  toolsStale,
}: PermissionsSectionProps) {
  return (
    <BuilderSection
      title="Permissions"
      description="What this agent may do, expressed as what is taken away from the runtime (PRD §5.5). Every switch here is one the Backend stores and maps onto a real control surface; none is drawn from the PRD’s list."
    >
      <Subtractive />

      {shape.rows.map((row) => (
        <PermissionToggle
          key={row.path}
          row={row}
          draft={draft}
          disabled={disabled}
          changed={isChanged(permissionDraftKey(row.path))}
          // Create mode has no served document, so `enforced` is `null` for a reason that is not
          // "this Backend does not gate it" — the block below already says the tool list arrives
          // with the agent. Repeating a warning badge on three rows would be noise that means
          // something different from what it says.
          showEnforcement={mode === 'edit'}
          onChange={onChange}
        />
      ))}

      {issue === undefined ? null : (
        <p
          role="alert"
          data-testid={`issue-${issue.field}`}
          className="text-2xs leading-150"
          style={{ color: 'var(--color-danger)' }}
        >
          <span aria-hidden="true">✕</span> <strong>{issue.message}</strong>{' '}
          <span className="text-text-muted">{issue.why}</span>
        </p>
      )}

      <DisallowedTools shape={shape} mode={mode} stale={toolsStale} />
      <NotModelled />

      {shape.unrecognised.length > 0 ? (
        <p
          role="note"
          data-testid="permissions-unrecognised"
          className="text-2xs text-text-muted leading-150"
        >
          <span aria-hidden="true">ⓘ</span> This Backend also stores{' '}
          <code className="font-mono">{shape.unrecognised.join(', ')}</code> under{' '}
          <code className="font-mono">permissions</code>, and this build has no switch for{' '}
          {shape.unrecognised.length === 1 ? 'it' : 'them'}. Saving permissions here sends the three
          above, so {shape.unrecognised.length === 1 ? 'it' : 'they'} would be dropped — edit{' '}
          {shape.unrecognised.length === 1 ? 'it' : 'them'} through the API until this screen
          catches up.
        </p>
      ) : null}
    </BuilderSection>
  );
}

/**
 * The direction of the model, stated before the switches rather than after them.
 *
 * Without this line an operator reads three checkboxes as authorisations Mission Control is
 * handing out. It is the opposite: the boxes decide what is removed, and a fully-granted agent is
 * exactly as capable as no agent at all — no more.
 */
function Subtractive() {
  return (
    <p className="text-2xs text-text-muted leading-150">
      <span aria-hidden="true">ⓘ</span> These are <strong>subtractive</strong>. Granting one changes
      nothing relative to a session launched with no agent — the tool simply is not removed, and
      whether the model may use it is still decided by the operator’s own Claude Code settings.
      Denying one takes the tools away. Mission Control cannot widen what this machine already
      allows, so a grant here can never be a surprise.
    </p>
  );
}

function PermissionToggle({
  row,
  draft,
  disabled,
  changed,
  showEnforcement,
  onChange,
}: {
  row: PermissionRow;
  draft: Draft;
  disabled: boolean;
  changed: boolean;
  showEnforcement: boolean;
  onChange: (path: string, granted: boolean) => void;
}) {
  const id = useId();
  const name = permissionDraftKey(row.path);
  const checked = draft[name] === true;

  return (
    <div
      data-testid={`permission-${row.path}`}
      data-changed={changed ? 'true' : 'false'}
      className="pl-3"
      style={{ borderLeft: `2px solid ${changed ? 'var(--color-accent)' : 'transparent'}` }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ToggleControl
          id={id}
          label={row.label}
          checked={checked}
          disabled={disabled}
          describedBy={`${id}-note`}
          onChange={(next) => onChange(row.path, next)}
        />

        {showEnforcement && row.enforced === null ? (
          <span
            data-testid={`enforcement-unknown-${row.path}`}
            className="rounded-xs border px-2 text-2xs"
            style={{
              borderColor: 'var(--color-warning)',
              color: 'var(--color-warning)',
              backgroundColor: 'var(--color-warning-subtle)',
            }}
            title="This Backend served no disallowedTools, so there is no evidence this switch gates anything."
          >
            enforcement not stated
          </span>
        ) : null}

        {changed ? (
          <span className="font-medium text-2xs" style={{ color: 'var(--color-accent)' }}>
            changed
          </span>
        ) : null}
      </div>

      <p id={`${id}-note`} className="mt-05 text-2xs text-text-muted leading-150">
        {row.description}
      </p>
    </div>
  );
}

/**
 * The evidence.
 *
 * `disallowedTools` is the Backend's own derivation of these switches into the runtime's
 * vocabulary — the literal `--disallowedTools` argument the launch path passes. It is rendered
 * because a permission model an operator has to take on trust is a permission model nobody can
 * audit: `read: true, write: false` says what was *asked for*, and this says what will actually
 * happen.
 *
 * It reflects the **saved** permissions and is labelled as such while the draft differs. It is
 * deliberately not recomputed client-side from the draft: the Backend's comment on that mapping is
 * that there is one function, and a second copy here would be free to drift on precisely the
 * question of which tools a denial removes.
 */
function DisallowedTools({
  shape,
  mode,
  stale,
}: {
  shape: PermissionsShape;
  mode: 'create' | 'edit';
  stale: boolean;
}) {
  if (mode === 'create') {
    return (
      <p
        role="note"
        data-testid="disallowed-tools-after-create"
        className="text-2xs text-text-muted leading-150"
      >
        <span aria-hidden="true">ⓘ</span> Once the agent exists, the exact list of runtime tools
        these switches remove is served on it and shown here — derived by the Backend, not computed
        by this screen, so the two cannot disagree.
      </p>
    );
  }

  if (shape.disallowedTools === null) {
    return (
      <div
        role="note"
        data-testid="disallowed-tools-missing"
        className="rounded-sm border p-3"
        style={{
          backgroundColor: 'var(--color-warning-subtle)',
          borderColor: 'var(--color-warning)',
        }}
      >
        <p className="text-sm text-text leading-150">
          <span aria-hidden="true">▲</span> This Backend does not say what these switches remove.
        </p>
        <p className="mt-1 text-2xs text-text-muted leading-150">
          The Agent resource carries no <code className="font-mono">disallowedTools</code>, which is
          the only evidence available that a permission here reaches the runtime at all. Treat all
          three as recorded intentions until it does — nothing on this screen is marked enforced on
          the strength of the PRD naming it.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="disallowed-tools" className="rounded-sm border border-border p-3">
      <p className="text-2xs text-text-secondary leading-150">
        {stale ? 'Removed from the runtime, as currently saved:' : 'Removed from the runtime:'}
      </p>
      {shape.disallowedTools.length === 0 ? (
        <p className="mt-1 text-2xs text-text-muted leading-150">
          Nothing. This agent denies no tools, so a session running as it is exactly as capable as
          one launched with no agent — and it keeps the operator’s own MCP servers, which a
          restricted agent does not.
        </p>
      ) : (
        <p className="mt-1 flex flex-wrap gap-1">
          {shape.disallowedTools.map((tool) => (
            <code
              key={tool}
              className="rounded-xs px-2 py-05 font-mono text-2xs text-text-secondary"
              style={{ backgroundColor: 'var(--color-surface-inset)' }}
            >
              {tool}
            </code>
          ))}
        </p>
      )}
      {stale ? (
        <p
          data-testid="disallowed-tools-stale"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-warning)' }}
        >
          <span aria-hidden="true">▲</span> The switches above have been changed. This list is the
          Backend’s and is recomputed on save — it is not re-derived here, so that the screen and
          the launch path cannot disagree about what a denial removes.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The nine PRD §5.5 permissions with no switch, named rather than left as a silence.
 *
 * An operator who has read the PRD and counts three checkboxes will assume the screen is
 * unfinished. It is not: each omission is a decision with a reason, and stating them is what keeps
 * "there is no Merge switch" from being read as "merging is unrestricted" — because for a
 * shell-granted agent it very much is.
 */
function NotModelled() {
  return (
    <details data-testid="permissions-not-modelled" className="text-2xs text-text-muted">
      <summary className="cursor-pointer" style={{ minHeight: 24 }}>
        PRD §5.5 lists nine more permissions. Why they are not here.
      </summary>
      <div className="mt-2 flex flex-col gap-2 leading-150">
        <p>
          <strong>Repository: Commit, Create PR, Merge, Delete.</strong> All four are{' '}
          <code className="font-mono">git</code>/<code className="font-mono">gh</code> invocations
          through one tool — the shell. There is no separate runtime tool for any of them, so
          splitting them would mean deciding permissions by parsing command strings, which{' '}
          <code className="font-mono">sh -c &apos;git merge&apos;</code> defeats in one move. They
          are granted together, by <strong>Shell</strong>, and that is the smallest true statement
          available.
        </p>
        <p>
          <strong>
            Memory: Read, Write, Delete. Documentation: Create ADR, Create Notes, Edit Notes.
          </strong>{' '}
          These are Mission Control API routes that the operator calls. A Claude Code session has no
          path to them — there is no MCP server exposing them — so a switch would gate nothing. They
          appear the day an agent can reach them.
        </p>
        <p className="text-text-muted">Not modelled: {UNMODELLED_PERMISSIONS.join(' · ')}.</p>
      </div>
    </details>
  );
}
