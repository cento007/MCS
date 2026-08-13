import { Link } from 'react-router';
import { endpoints } from '../../../lib/api/index.js';
import {
  RadioGroupControl,
  SelectControl,
  SettingsField,
  StringListControl,
} from '../components/Field.js';
import { PanelStatus, SettingsPanel } from '../components/Panel.js';
import { SecretField } from '../components/SecretField.js';
import { TestConnection } from '../components/TestConnection.js';
import type { Draft } from '../dirty.js';
import type { GithubSettings } from '../types.js';
import { WORKFLOW_MODES } from '../types.js';
import { cleanList, nullableText, numberOr, useIntegrationForm } from './integration-form.js';
import { SYNC_INTERVAL_OPTIONS } from './options.js';

/**
 * Integrations → GitHub (PRD §4.4.2/§4.3, TDS 04 §7.2, TDS 06 §5.7.3).
 *
 * **Workflow mode lives here, and that placement is load-bearing.** PRD §4.3 specifies Manual
 * and Assisted as Phase 1 functionality, and until WS5 §5.7.3 placed the control they had no
 * surface anywhere in the UI — a stated requirement that could not be implemented from the
 * design. It sits under GitHub because both modes are entirely about git/PR behaviour, and the
 * per-Project override lives on the Project detail header (§5.3.2); the effective mode for a
 * Session is the Project's, falling back to this default.
 */

function toDraft(document: GithubSettings): Draft {
  return {
    account: document.account ?? '',
    organizations: [...document.organizations],
    discoveryRoots: [...document.discoveryRoots],
    syncIntervalMinutes: document.syncIntervalMinutes,
    workflowMode: document.workflowMode,
  };
}

function toBody({
  draft,
  secrets,
}: {
  draft: Draft;
  secrets: Readonly<Record<string, string | null>>;
}): unknown {
  return {
    account: nullableText(draft['account']),
    organizations: cleanList(draft['organizations']),
    discoveryRoots: cleanList(draft['discoveryRoots']),
    syncIntervalMinutes: numberOr(draft['syncIntervalMinutes'], 0),
    workflowMode: String(draft['workflowMode'] ?? 'manual'),
    // §7.1: present only when written. An omitted secret keeps the stored value; there is no
    // "send the mask back" path, because the client never had the value to send.
    ...('token' in secrets ? { token: secrets['token'] ?? null } : {}),
  };
}

export function GithubCard() {
  const form = useIntegrationForm<GithubSettings>({
    slug: 'github',
    label: 'GitHub',
    toDraft,
    toBody,
  });

  const tokenSet = form.document?.token.isSet === true;
  const organizations = (form.value('organizations') as readonly string[] | undefined) ?? [];
  const discoveryRoots = (form.value('discoveryRoots') as readonly string[] | undefined) ?? [];

  return (
    <SettingsPanel
      title="GitHub"
      headingLevel={3}
      compactUnavailable
      form={form}
      endpoint={endpoints.settings.integration('github')}
      status={
        tokenSet ? (
          <PanelStatus glyph="●" label="Token set" colorVar="--color-success" />
        ) : (
          <PanelStatus glyph="○" label="Not configured" />
        )
      }
      actions={
        <TestConnection
          form={form}
          integration="github"
          describeSuccess={(result) => {
            const account = result.detail?.['account'];
            return typeof account === 'string' && account.length > 0
              ? `Connected as ${account}`
              : result.message;
          }}
        />
      }
    >
      <SecretField
        form={form}
        name="token"
        label="Personal access token"
        current={form.document?.token ?? null}
        clearConsequence="Clear GitHub personal access token? Repository discovery, commit and pull-request sync will stop working until a new token is saved."
      />

      <SettingsField label="Account" changed={form.isChanged('account')}>
        {({ id }) => (
          <input
            id={id}
            value={String(form.value('account') ?? '')}
            disabled={form.disabled}
            placeholder="cento007"
            onChange={(event) => form.set('account', event.target.value)}
            className="w-full rounded-sm border bg-transparent px-2 font-mono text-sm text-text disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              borderColor: 'var(--color-border-control)',
              backgroundColor: 'var(--color-surface-inset)',
            }}
          />
        )}
      </SettingsField>

      <SettingsField label="Organizations" changed={form.isChanged('organizations')}>
        {({ id }) => (
          <StringListControl
            id={id}
            label="Organization"
            values={organizations}
            disabled={form.disabled}
            mono
            placeholder="my-org"
            addLabel="add"
            onChange={(next) => form.set('organizations', next)}
          />
        )}
      </SettingsField>

      <SettingsField
        label="Discovery root paths"
        changed={form.isChanged('discoveryRoots')}
        description="Absolute native paths scanned for repositories, in order."
      >
        {({ id }) => (
          <StringListControl
            id={id}
            label="Discovery root"
            values={discoveryRoots}
            disabled={form.disabled}
            mono
            placeholder="D:\Repos"
            addLabel="Add path"
            onChange={(next) => form.set('discoveryRoots', next)}
            // WS5 §5.7.3 renders a per-row `✓ valid` / `✕ not found` hint. No endpoint in
            // TDS 04 validates a filesystem path, so the honest hint is that the check has
            // not run — a green tick this client cannot substantiate would be worse than none.
            rowHint={() => (
              <span
                className="text-text-muted"
                title="Mission Control has no path-validation endpoint yet, so this path has not been checked."
              >
                not verified
              </span>
            )}
          />
        )}
      </SettingsField>

      <SettingsField
        label="Sync / polling interval"
        changed={form.isChanged('syncIntervalMinutes')}
      >
        {({ id }) => (
          <SelectControl
            id={id}
            value={String(form.value('syncIntervalMinutes') ?? '')}
            disabled={form.disabled}
            onChange={(next) => form.set('syncIntervalMinutes', Number(next))}
            options={SYNC_INTERVAL_OPTIONS}
          />
        )}
      </SettingsField>

      <SettingsField label="Workflow mode" changed={form.isChanged('workflowMode')}>
        {() => (
          <>
            <RadioGroupControl
              name="github-workflow-mode"
              legend="Workflow mode"
              value={String(form.value('workflowMode') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('workflowMode', next)}
              options={WORKFLOW_MODES.map((mode) => ({
                value: mode,
                label: mode === 'manual' ? 'Manual' : 'Assisted',
              }))}
            />
            <p className="mt-2 text-2xs text-text-muted leading-150">
              <span aria-hidden="true">ⓘ</span> Assisted lets Mission Control propose commit
              messages, branch names, and PR descriptions for your approval. Manual records git
              activity but never proposes actions.{' '}
              <Link to="/projects" className="underline decoration-dotted underline-offset-2">
                Projects
              </Link>{' '}
              can override this individually.
            </p>
          </>
        )}
      </SettingsField>
    </SettingsPanel>
  );
}
