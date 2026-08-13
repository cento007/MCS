import {
  AGENT_PERMISSION_TEMPLATES,
  type AgentPermissionTemplate,
  agentPermissionsFromTemplate,
  DEFAULT_AGENT_PERMISSION_TEMPLATE,
  isAgentPermissionTemplate,
} from '@mc/shared/types';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { type ApiError, apiGet, endpoints, queryKeys } from '../../../lib/api/index.js';
import type { Draft } from '../../../lib/forms/dirty.js';
import { SelectControl, type SelectOption, SettingsField } from '../components/Field.js';
import { SettingsPanel } from '../components/Panel.js';
import { usePanelForm } from '../form.js';

/**
 * Settings → Agents (PRD §4.4, TDS 04 §7.2).
 *
 * **One control, and it is here because it has a consumer.** §7.2 reserves two `agents` keys and
 * the shared registry declares only one:
 *
 *  - `defaultPermissionTemplate` is read by `POST /api/v1/agents` whenever the request body names
 *    no permissions, and the value it supplies goes on to decide which tools are removed from that
 *    agent's sessions. A real reader, with a visible effect.
 *  - `defaultRuntime` is **not** declared, and this panel does not draw it. `AGENT_RUNTIMES` has
 *    exactly one member because exactly one runtime can be launched (F1.5), so a control choosing
 *    among them chooses nothing — which is the `integrations.ollama.enabled` mistake, and this
 *    codebase is still paying for that one.
 *
 * This panel replaced a `PhasePlaceholder` that promised "default runtime and default permission
 * template". Half of that promise is now real and the other half was withdrawn on purpose, so
 * leaving the placeholder would have advertised a control nobody intends to build.
 */

const PATH = endpoints.settings.category('agents');

/** Each template, with what it actually grants — the three capabilities, named. */
const TEMPLATE_OPTIONS: readonly SelectOption[] = AGENT_PERMISSION_TEMPLATES.map((template) => ({
  value: template,
  label: describeTemplate(template),
}));

export function describeTemplate(template: AgentPermissionTemplate): string {
  const { repository } = agentPermissionsFromTemplate(template);
  const granted = [
    repository.read ? 'read' : null,
    repository.write ? 'write' : null,
    repository.shell ? 'shell' : null,
  ].filter((entry): entry is string => entry !== null);
  const label = template.replace(/_/g, ' ');
  return `${label} — ${granted.length === 0 ? 'nothing' : granted.join(', ')}`;
}

/** Read as an open document: the `agents` category served `{}` until this key landed. */
function useAgentsSettings(): UseQueryResult<unknown, ApiError> {
  return useQuery<unknown, ApiError>({
    queryKey: queryKeys.settings.category('agents'),
    queryFn: ({ signal }) => apiGet<unknown>(PATH, { signal }),
    retry: false,
  });
}

function readTemplate(document: unknown): AgentPermissionTemplate {
  if (typeof document !== 'object' || document === null) return DEFAULT_AGENT_PERMISSION_TEMPLATE;
  const value = (document as Record<string, unknown>)['defaultPermissionTemplate'];
  return isAgentPermissionTemplate(value) ? value : DEFAULT_AGENT_PERMISSION_TEMPLATE;
}

function toDraft(document: unknown): Draft {
  return { defaultPermissionTemplate: readTemplate(document) };
}

function toBody({ draft, document }: { draft: Draft; document: unknown }): unknown {
  // Copy-then-overwrite, like every other category: a save is a full-category replace (A14), so a
  // key this build has never heard of would be reset to its default by an omission.
  const root = typeof document === 'object' && document !== null ? document : {};
  return {
    ...(root as Record<string, unknown>),
    defaultPermissionTemplate: String(draft['defaultPermissionTemplate'] ?? ''),
  };
}

export function AgentsSettingsPanel() {
  const query = useAgentsSettings();
  const form = usePanelForm<unknown>({
    panelId: 'agents',
    label: 'Agents',
    path: PATH,
    queryKey: queryKeys.settings.category('agents'),
    query,
    toDraft,
    toBody,
  });

  const current = String(form.value('defaultPermissionTemplate') ?? '');

  return (
    <SettingsPanel
      title="Agents"
      form={form}
      endpoint={PATH}
      description="Defaults applied when an agent is created without naming its own permissions."
    >
      <SettingsField
        label="Default permission template"
        changed={form.isChanged('defaultPermissionTemplate')}
        description="Applied by POST /agents when the request names no permissions — which is what the Agent Builder’s switches start from. It is deny-biased on purpose: an agent created without a thought about permissions must not be able to edit a working tree."
      >
        {({ id }) => (
          <SelectControl
            id={id}
            value={current}
            disabled={form.disabled}
            onChange={(next) => form.set('defaultPermissionTemplate', next)}
            options={TEMPLATE_OPTIONS}
          />
        )}
      </SettingsField>

      <p className="text-2xs text-text-muted leading-150">
        <span aria-hidden="true">ⓘ</span> <strong>full</strong> is not “everything”: it is read +
        write + shell, which is what a session launched with no agent at all already has. There is
        no template that grants more, because agent permissions are subtractive — Mission Control
        can remove tools from a runtime and can never add any. What each template removes is shown
        against the agent itself, on{' '}
        <Link to="/agents" className="rounded-xs underline decoration-dotted underline-offset-2">
          Agents
        </Link>
        .
      </p>

      <p className="text-2xs text-text-muted leading-150">
        <span aria-hidden="true">▲</span> TDS 04 §7.2 also reserves{' '}
        <code className="font-mono">agents.defaultRuntime</code>. There is no control for it and
        that is deliberate: exactly one runtime can be launched, so a picker over the list would
        choose nothing. It appears when a second runtime does.
      </p>
    </SettingsPanel>
  );
}
