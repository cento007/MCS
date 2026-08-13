import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import {
  DirtyFormProvider,
  UnsavedChangesGuard,
  useDirtyForms,
} from '../../components/UnsavedChangesGuard.js';
import { endpoints } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format/index.js';
import { changeCountLabel } from '../../lib/forms/dirty.js';
import { useChannel } from '../../lib/ws/context.js';
import {
  AgentField,
  BuilderSection,
  SelectControl,
  type SelectOption,
  TextAreaControl,
  TextControl,
  ToggleControl,
} from './fields.js';
import { type AgentForm, useAgentForm } from './form.js';
import { PermissionsSection } from './PermissionsSection.js';
import { permissionDraftKey, readAgentPermissions } from './permissions.js';
import { projectName, useAgent, useAgentProjects, useDefaultAgentPermissions } from './queries.js';
import {
  AGENT_FIELDS,
  AGENT_LIMITS,
  type AgentFormIssue,
  type AgentView,
  issueFor,
  readKnowledgeSources,
} from './shape.js';
import {
  agentRuntimeLabel,
  agentScopeDescription,
  agentScopeLabel,
  OFFERED_AGENT_SCOPES,
} from './types.js';

/**
 * `/agents/new` and `/agents/:agentId` — the Agent Builder (PRD §5.8).
 *
 * §5.8 asks for "UI-based configuration with sections: Name, Description, Prompt, Scope,
 * Permissions, Runtime, Knowledge Sources", and the sections below are in that order. Four of them
 * are decisions rather than layout:
 *
 *  - **Prompt is a page, not a field.** It is the agent — PRD §5.1: agents are personas operating
 *    through runtimes, not models — and the Backend allows 20 000 characters of it. A two-row
 *    textarea would make the most consequential input on the screen the hardest to read.
 *  - **Scope makes the invalid unsubmittable, and says why.** A project-scoped agent without a
 *    project is a row `ck_agents_scope_target` will not hold. `[Create agent]` is disabled and the
 *    sentence beside it turns the refusal into a decision: an agent that should be available
 *    everywhere is *Global*, not Project-with-no-project.
 *  - **Scope is shown, not edited, once the agent exists.** `PATCH /agents/{id}` has no `scope`,
 *    `projectId` or `sessionId` and is `additionalProperties: false`, so a select here would be a
 *    control whose every use is a `400`. It renders as a stated fact with the reason attached.
 *  - **Permissions render what the API returns, with the API's own evidence.** See
 *    `PermissionsSection`.
 *
 * It is a **route**, not a modal: seven sections and a full-height prompt do not fit a dialog, and
 * the unsaved-changes guard is a route blocker — which is why the route table builds a data router
 * and why the tests do too.
 */
export function AgentBuilderPage() {
  const { agentId } = useParams();
  const mode = agentId === undefined ? 'create' : 'edit';

  return (
    <DirtyFormProvider>
      <AgentBuilder key={agentId ?? 'new'} mode={mode} agentId={agentId ?? null} />
      <UnsavedChangesGuard />
    </DirtyFormProvider>
  );
}

function AgentBuilder({ mode, agentId }: { mode: 'create' | 'edit'; agentId: string | null }) {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useChannel('agents');

  const detail = useAgent(agentId);
  const projects = useAgentProjects();
  const defaults = useDefaultAgentPermissions();

  const form = useAgentForm({
    mode,
    agent: detail.agent,
    defaultPermissions: defaults.permissions,
    projectsAvailable: !projects.isError,
    readOnly: detail.unavailable || detail.isError || detail.unreadable,
  });

  // TDS 06 §7.2: focus is managed at route change, so a keyboard operator arriving from the list
  // starts at the top of the form rather than wherever the previous screen left them.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  /**
   * Leave for the created agent only once the form has gone clean **and the guard has noticed**.
   *
   * `save()` seeds the submitted draft as the new baseline before setting `createdId`, so the form
   * is clean immediately. That is not enough on its own: `useBlocker` evaluates a closure captured
   * at the guard's last render, and the guard lives one component up — so a navigation fired in the
   * same commit as the withdraw is judged against the *previous* answer and blocked. Waiting for
   * the registry to report clean is what makes the hand-off deterministic rather than a race that
   * happens to pass on a fast machine.
   *
   * Without this, the create would trip the blocker on the navigation the save itself caused, and
   * offer to save the changes it had just saved.
   */
  const { createdId, summary } = form;
  const { isDirty: guardDirty } = useDirtyForms();
  useEffect(() => {
    if (createdId === null || summary.isDirty || guardDirty) return;
    void navigate(`/agents/${createdId}`, { replace: true });
  }, [createdId, summary.isDirty, guardDirty, navigate]);

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
    if (!isSave) return;
    event.preventDefault();
    if (!form.canSubmit) return;
    void form.save();
  };

  const projectOptions = useMemo<readonly SelectOption[]>(
    () => (projects.data ?? []).map((project) => ({ value: project.id, label: project.name })),
    [projects.data],
  );

  const agent = detail.agent;
  const knowledge = readKnowledgeSources(agent?.raw ?? null);
  const permissionsDirty = (['repository.read', 'repository.write', 'repository.shell'] as const)
    .map(permissionDraftKey)
    .some((key) => form.isChanged(key));

  const title = mode === 'create' ? 'New agent' : (agent?.name ?? 'Agent');

  return (
    <form
      data-testid="agent-builder"
      onSubmit={(event) => {
        event.preventDefault();
        if (form.canSubmit) void form.save();
      }}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4 px-4 py-4 md:px-6"
    >
      <div>
        <Link
          to="/agents"
          className="rounded-xs text-2xs text-text-muted underline decoration-dotted underline-offset-2"
          style={{ minHeight: 24 }}
        >
          ← Agents
        </Link>
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="font-medium text-text text-xl outline-none">
          {title}
        </h1>
        {agent === null ? null : <AgentMeta agent={agent} />}
      </div>

      {detail.unavailable ? <RouteMissing /> : null}
      {detail.isError ? (
        <ErrorPanel
          error={detail.error}
          title="This agent could not be read"
          onRetry={detail.refetch}
        />
      ) : null}
      {detail.unreadable ? <Unreadable /> : null}

      {mode === 'edit' && detail.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading agent</span>
          <Skeleton height={120} />
          <Skeleton height={200} />
          <Skeleton height={120} />
        </div>
      ) : (
        <>
          {/* 1–2. Name and Description (PRD §5.8). One card: they are the same act. */}
          <BuilderSection title="Identity">
            <AgentField
              label="Name"
              required
              changed={form.isChanged(AGENT_FIELDS.name)}
              issue={issueFor(form.issues, AGENT_FIELDS.name)}
              description="How this agent is picked everywhere else. The PRD’s own examples are role names: Architect, Security, QA, Documentation. It must be unique among live agents in the same scope."
            >
              {({ id, describedBy }) => (
                <TextControl
                  id={id}
                  describedBy={describedBy}
                  value={form.text(AGENT_FIELDS.name)}
                  disabled={form.disabled}
                  placeholder="Architect"
                  maxLength={AGENT_LIMITS.name}
                  invalid={issueFor(form.issues, AGENT_FIELDS.name)?.severity === 'blocking'}
                  onChange={(value) => form.set(AGENT_FIELDS.name, value)}
                />
              )}
            </AgentField>

            <AgentField
              label="Description"
              changed={form.isChanged(AGENT_FIELDS.description)}
              issue={issueFor(form.issues, AGENT_FIELDS.description)}
              description="One line, for the list. Optional — and it is not the prompt: nothing here reaches the runtime."
            >
              {({ id }) => (
                <TextAreaControl
                  id={id}
                  rows={2}
                  value={form.text(AGENT_FIELDS.description)}
                  disabled={form.disabled}
                  placeholder="Reviews designs against the Foundation Contract."
                  onChange={(value) => form.set(AGENT_FIELDS.description, value)}
                />
              )}
            </AgentField>

            {mode === 'edit' ? (
              <AgentField
                label="Archived"
                changed={form.isChanged(AGENT_FIELDS.archived)}
                description="Retirement, and the only one there is: the API has no delete, because sessions, audit entries and memory items all point at this row. An archived agent keeps its history and stops being offered to new sessions."
              >
                {({ id }) => (
                  <ToggleControl
                    id={id}
                    label={form.value(AGENT_FIELDS.archived) === true ? 'Archived' : 'Active'}
                    checked={form.value(AGENT_FIELDS.archived) === true}
                    disabled={form.disabled}
                    onChange={(value) => form.set(AGENT_FIELDS.archived, value)}
                  />
                )}
              </AgentField>
            ) : null}
          </BuilderSection>

          {/* 3. Prompt — the agent itself. */}
          <BuilderSection
            title="Prompt"
            description="The system prompt this agent runs under. It is the persona: everything that makes an Architect different from a QA reviewer is here, not in the model."
            action={<PromptLength value={form.text(AGENT_FIELDS.instructions)} />}
          >
            <AgentField
              label="Instructions"
              changed={form.isChanged(AGENT_FIELDS.instructions)}
              issue={issueFor(form.issues, AGENT_FIELDS.instructions)}
            >
              {({ id, describedBy }) => (
                <TextAreaControl
                  id={id}
                  describedBy={describedBy}
                  tall
                  rows={12}
                  mono
                  value={form.text(AGENT_FIELDS.instructions)}
                  disabled={form.disabled}
                  placeholder={
                    'You are the Architect for this repository.\n\nBefore proposing a change, read the Foundation Contract…'
                  }
                  onChange={(value) => form.set(AGENT_FIELDS.instructions, value)}
                />
              )}
            </AgentField>
          </BuilderSection>

          {/* 4. Scope — the invariant, and immutable after create. */}
          <BuilderSection
            title="Scope"
            description="Where this agent is offered (PRD §5.2). There is no neutral setting: an agent is available to every project, or to exactly one."
          >
            {mode === 'create' ? (
              <>
                <AgentField
                  label="Scope"
                  required
                  changed={form.isChanged(AGENT_FIELDS.scope)}
                  issue={issueFor(form.issues, AGENT_FIELDS.scope)}
                  description={
                    <>
                      {agentScopeDescription(form.text(AGENT_FIELDS.scope))}{' '}
                      <strong>Scope cannot be changed after the agent is created</strong> — moving
                      one between scopes would silently re-point every session that ran as it.
                    </>
                  }
                >
                  {({ id, describedBy }) => (
                    <SelectControl
                      id={id}
                      describedBy={describedBy}
                      value={form.text(AGENT_FIELDS.scope)}
                      disabled={form.disabled}
                      options={scopeOptionsFor(form.text(AGENT_FIELDS.scope))}
                      onChange={(value) => form.setScope(value)}
                    />
                  )}
                </AgentField>

                {form.text(AGENT_FIELDS.scope) === 'project' ? (
                  <AgentField
                    label="Project"
                    required
                    changed={form.isChanged(AGENT_FIELDS.projectId)}
                    issue={issueFor(form.issues, AGENT_FIELDS.projectId)}
                  >
                    {({ id, describedBy }) => (
                      <SelectControl
                        id={id}
                        describedBy={describedBy}
                        value={form.text(AGENT_FIELDS.projectId)}
                        disabled={form.disabled || projects.isError}
                        options={projectOptions}
                        unsetLabel={
                          projects.isError ? '— projects unavailable' : '— choose a project'
                        }
                        invalid={
                          issueFor(form.issues, AGENT_FIELDS.projectId)?.severity === 'blocking'
                        }
                        onChange={(value) => form.set(AGENT_FIELDS.projectId, value)}
                      />
                    )}
                  </AgentField>
                ) : null}

                {projects.isError ? (
                  <ErrorPanel
                    error={projects.error}
                    title="The projects list could not be read"
                    onRetry={() => void projects.refetch()}
                  />
                ) : null}
              </>
            ) : (
              <ScopeFact
                agent={agent}
                projectLabel={projectName(projects.data ?? [], agent?.projectId ?? null)}
              />
            )}
          </BuilderSection>

          {/* 5. Permissions. */}
          <PermissionsSection
            shape={
              agent?.permissions ??
              // Create mode. The rows come from `@mc/shared/types` — the same vocabulary the
              // Backend's route schema and CHECK constraints are built from — so drawing them
              // before a document exists is reading the contract, not guessing at it. The values
              // come from `settings.agents.defaultPermissionTemplate`, which is exactly what
              // `POST /agents` would apply if the body named no permissions.
              readAgentPermissions({ permissions: defaults.permissions })
            }
            draft={form.draft}
            disabled={form.disabled}
            mode={mode}
            isChanged={form.isChanged}
            onChange={form.setPermission}
            issue={issueFor(form.issues, permissionDraftKey('repository.shell'))}
            toolsStale={permissionsDirty}
          />

          {/* 6. Runtime. */}
          <BuilderSection
            title="Runtime"
            description="What actually executes this agent (PRD §5.4). The agent is the persona; the runtime is what it runs on."
          >
            <RuntimeFact runtime={form.text(AGENT_FIELDS.runtime)} />
          </BuilderSection>

          {/* 7. Knowledge Sources. */}
          <BuilderSection title="Knowledge sources">
            {knowledge.served ? (
              <div role="note" data-testid="knowledge-served">
                <p className="text-sm text-text leading-150">
                  This Backend stores <code className="font-mono text-xs">{knowledge.field}</code>{' '}
                  on an agent, and this screen has no editor for it.
                </p>
                <p className="mt-1 text-2xs text-text-muted leading-150">
                  Shown verbatim so it is not invisible, and untouched by every save on this page —
                  a <code className="font-mono">PATCH</code> only sends the fields that changed.
                </p>
                <pre
                  className="mt-2 overflow-x-auto rounded-sm p-2 font-mono text-2xs text-text-secondary"
                  style={{ backgroundColor: 'var(--color-surface-inset)' }}
                >
                  {knowledge.preview}
                </pre>
              </div>
            ) : (
              <p
                role="note"
                data-testid="knowledge-not-served"
                className="text-sm text-text-secondary leading-150"
              >
                <span aria-hidden="true">ⓘ</span> This Backend stores no knowledge sources on an
                agent, and says why: nothing reads them. PRD §5.3 lists{' '}
                <code className="font-mono text-xs">knowledge</code> and{' '}
                <code className="font-mono text-xs">memory</code> fields and §5.8 lists this
                section, but the <code className="font-mono text-xs">agent</code> memory tier has no
                producer and there is no knowledge-source consumer — so a picker here would write to
                a column nothing looks at. What an agent can retrieve is governed by the four-tier
                memory system and its indexed sources, on{' '}
                <Link
                  to="/settings/memory"
                  className="rounded-xs underline decoration-dotted underline-offset-2"
                >
                  Settings → Memory
                </Link>
                .
              </p>
            )}
          </BuilderSection>

          {agent !== null && agent.unrecognised.length > 0 ? (
            <p
              role="note"
              data-testid="agent-unrecognised"
              className="text-2xs text-text-muted leading-150"
            >
              <span aria-hidden="true">ⓘ</span> Served on this agent and not shown here:{' '}
              <code className="font-mono">{agent.unrecognised.join(', ')}</code>. A save sends only
              the fields that changed, so {agent.unrecognised.length === 1 ? 'it is' : 'they are'}{' '}
              left alone.
            </p>
          ) : null}

          <SaveBar form={form} mode={mode} />
        </>
      )}
    </form>
  );
}

/**
 * Scope, in edit mode: a fact with its reason, not a disabled control.
 *
 * A greyed-out select invites the operator to look for the thing that would ungrey it. There is
 * nothing — `PATCH /agents/{id}` does not accept `scope`, `projectId` or `sessionId` at all, and
 * its schema is `additionalProperties: false`, so sending one is a `400` naming the field rather
 * than a silent no-op.
 */
function ScopeFact({
  agent,
  projectLabel,
}: {
  agent: AgentView | null;
  projectLabel: string | null;
}) {
  const scope = agent?.scope ?? '';

  return (
    <div data-testid="scope-fact">
      <p className="text-sm text-text">
        {scope.length === 0 ? (
          <span className="text-text-muted">This Backend served no scope for this agent.</span>
        ) : (
          <>
            <strong>{agentScopeLabel(scope)}</strong>
            {projectLabel === null ? null : (
              <span className="text-text-secondary"> · {projectLabel}</span>
            )}
            {agent?.sessionId === null || agent?.sessionId === undefined ? null : (
              <span className="font-mono text-text-secondary text-xs"> · {agent.sessionId}</span>
            )}
          </>
        )}
      </p>
      <p className="mt-1 max-w-2xl text-2xs text-text-muted leading-150">
        {agentScopeDescription(scope)} <strong>Scope is fixed once an agent exists.</strong> The API
        does not accept a change to it, because moving an agent between scopes would silently
        re-point every session that has already run as it. Create a new agent in the scope you want
        and archive this one.
      </p>
    </div>
  );
}

/**
 * Runtime, likewise a fact rather than a select.
 *
 * `AGENT_RUNTIMES` has exactly one member. PRD §5.4 also lists Ollama as optional for V1, and the
 * Backend deliberately does not: `ManagedRuntime` drives the Claude Agent SDK for every managed
 * Session (F1.5), so an agent recorded as `ollama` would silently run on Claude Code. A dropdown
 * with one entry is a control that suggests a choice nobody has.
 */
function RuntimeFact({ runtime }: { runtime: string }) {
  return (
    <div data-testid="runtime-fact">
      <p className="text-sm text-text">
        <strong>{runtime.length === 0 ? 'Claude Code' : agentRuntimeLabel(runtime)}</strong>
      </p>
      <p className="mt-1 max-w-2xl text-2xs text-text-muted leading-150">
        The only runtime an agent can be launched on. PRD §5.4 also names Ollama as an optional V1
        runtime and this product does run Ollama — for embeddings — but nothing can execute an agent
        on it, so it is not offered here. A second entry appears the day a second runtime can
        actually be launched; a dropdown with one item would only imply a choice that does not
        exist.
      </p>
    </div>
  );
}

/**
 * The scopes the create select offers, plus the stored one when it is not among them.
 *
 * `session` is not offered (it needs a `sessionId` this screen cannot supply), and a scope
 * invented after this build must not vanish from its own dropdown: `SelectControl` would show the
 * unset placeholder and the next save would rewrite the scope to whatever was picked afterwards.
 * The same rule Settings → Memory applies to a retention window set outside its ladder.
 */
export function scopeOptionsFor(current: string): readonly SelectOption[] {
  const options = OFFERED_AGENT_SCOPES.map((scope) => ({
    value: scope,
    label: agentScopeLabel(scope),
  }));
  if (current.length === 0 || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: `${agentScopeLabel(current)} (stored)` }];
}

function PromptLength({ value }: { value: string }) {
  const lines = value.length === 0 ? 0 : value.split('\n').length;
  const over = value.length > AGENT_LIMITS.instructions;
  return (
    <span
      className="text-2xs"
      style={{ color: over ? 'var(--color-danger)' : 'var(--color-text-muted)' }}
    >
      {value.length.toLocaleString()} / {AGENT_LIMITS.instructions.toLocaleString()} characters ·{' '}
      {lines} {lines === 1 ? 'line' : 'lines'}
    </span>
  );
}

function AgentMeta({ agent }: { agent: AgentView }) {
  return (
    <span className="flex flex-wrap items-center gap-3 text-2xs text-text-muted">
      <code className="font-mono">{agent.id}</code>
      {agent.updatedAt === null ? null : <span>updated {formatDateTime(agent.updatedAt)}</span>}
    </span>
  );
}

/**
 * The sticky Save bar.
 *
 * Present while dirty, and — in create mode — always, because an empty create form is not dirty
 * against anything and hiding its only action would leave the screen with no way forward.
 *
 * The blocking issues are listed **beside the disabled button**, not only next to their fields. A
 * greyed-out `[Create agent]` with the explanation three sections up the page is a dead end for
 * anyone who scrolled past it, and this form's two real invariants live in the middle of seven
 * sections.
 */
export function SaveBar({ form, mode }: { form: AgentForm; mode: 'create' | 'edit' }) {
  const { summary, isSaving, blocking, savedAt } = form;

  if (mode === 'edit' && !summary.isDirty) {
    return savedAt === null ? null : (
      <p data-testid="saved-confirmation" className="text-2xs text-text-muted">
        Saved.
      </p>
    );
  }

  return (
    <div
      data-testid="save-bar"
      className="sticky bottom-0 flex flex-col gap-2 rounded-md border border-border px-4 py-3"
      style={{ backgroundColor: 'var(--color-surface-raised)' }}
    >
      {blocking.length > 0 ? (
        <ul data-testid="blocking-issues" className="flex flex-col gap-1">
          {blocking.map((issue) => (
            <BlockingLine key={issue.field} issue={issue} />
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p aria-live="polite" className="mr-auto font-medium text-sm text-text">
          {summary.isDirty ? changeCountLabel(summary) : 'Nothing entered yet'}
        </p>
        <button
          type="button"
          onClick={form.discard}
          disabled={isSaving || !summary.isDirty}
          className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
          style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
        >
          Discard
        </button>
        <button
          type="submit"
          disabled={!form.canSubmit}
          className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
          style={{
            height: 'var(--mc-control-md)',
            minHeight: 24,
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          {isSaving ? 'Saving…' : mode === 'create' ? 'Create agent' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function BlockingLine({ issue }: { issue: AgentFormIssue }) {
  return (
    <li className="text-2xs leading-150" style={{ color: 'var(--color-danger)' }}>
      <span aria-hidden="true">✕</span> <strong>{issue.message}</strong>{' '}
      <span className="text-text-muted">{issue.why}</span>
    </li>
  );
}

function RouteMissing() {
  return (
    <div
      role="note"
      data-testid="agents-route-missing"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> This Backend does not serve{' '}
        <code className="font-mono text-xs">/api/v1{endpoints.agents.list}</code> yet.
      </p>
      <p className="mt-1 max-w-3xl text-2xs text-text-muted leading-150">
        The fields below are built to TDS 04 §13.2 and are disabled until that route exists. Nothing
        is shown from a local default: a value here that had never been saved would be
        indistinguishable from a stored one.
      </p>
    </div>
  );
}

function Unreadable() {
  return (
    <div
      role="alert"
      data-testid="agent-unreadable"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
      }}
    >
      <p className="text-sm text-text leading-150">
        The Backend answered, and the document was not an agent this screen can read.
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        It carried no <code className="font-mono">id</code> or no{' '}
        <code className="font-mono">name</code>. Editing is disabled rather than started from a
        guess — a form seeded with blanks would save those blanks over whatever is actually stored.
      </p>
    </div>
  );
}
