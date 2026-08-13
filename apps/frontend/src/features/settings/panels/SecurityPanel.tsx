import { useState } from 'react';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { endpoints, queryKeys } from '../../../lib/api/index.js';
import { SelectControl, SettingsField } from '../components/Field.js';
import { SettingsPanel } from '../components/Panel.js';
import type { Draft } from '../dirty.js';
import { usePanelForm } from '../form.js';
import { useChangePassword } from '../mutations.js';
import { useSecuritySettings } from '../queries.js';
import type { SecuritySettings } from '../types.js';
import { ApiTokensSection } from './ApiTokens.js';
import { AUDIT_RETENTION_OPTIONS, SESSION_TIMEOUT_OPTIONS } from './options.js';

/**
 * Settings → Security (PRD §4.4.6, TDS 04 §3, §7.2; TDS 06 §5.7.11).
 *
 * Three surfaces with three different commit models, and mixing them would be a bug:
 *
 *  - **Change password** is its own action against `POST /auth/password` (204). It is not part
 *    of any dirty set: a password change batched behind `[Save changes]` alongside a retention
 *    dropdown would be a credential rotation the operator could trigger by accident.
 *  - **API tokens** are their own resource (`/auth/tokens`), created and revoked individually.
 *  - **Session timeout and audit retention** are settings, and they use the panel's Save bar.
 *
 * The first two are served today; the third is not, so it renders disabled behind the honest
 * note rather than showing dropdown defaults that would look like configuration.
 */

const PATH = endpoints.settings.category('security');

function toDraft(document: SecuritySettings): Draft {
  return {
    sessionTimeoutMinutes: document.sessionTimeoutMinutes,
    auditLogRetentionDays: document.auditLogRetentionDays,
    allowedOrigins: [...document.allowedOrigins],
  };
}

function toBody({ draft }: { draft: Draft }): unknown {
  return {
    sessionTimeoutMinutes: Number(draft['sessionTimeoutMinutes'] ?? 10_080),
    auditLogRetentionDays: Number(draft['auditLogRetentionDays'] ?? 180),
    allowedOrigins: Array.isArray(draft['allowedOrigins']) ? [...draft['allowedOrigins']] : [],
  };
}

export function SecurityPanel() {
  const query = useSecuritySettings();
  const form = usePanelForm<SecuritySettings>({
    panelId: 'security',
    label: 'Security',
    path: PATH,
    queryKey: queryKeys.settings.category('security'),
    query,
    toDraft,
    toBody,
  });

  return (
    <div className="flex flex-col gap-4">
      <div
        className="rounded-md border border-border"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-2xs text-text-secondary uppercase">Change password</h2>
        </div>
        <div className="px-4 py-4">
          <ChangePasswordForm />
        </div>
      </div>

      <SettingsPanel title="Session &amp; audit" form={form} endpoint={PATH}>
        <SettingsField
          label="Sign out after"
          changed={form.isChanged('sessionTimeoutMinutes')}
          description="Idle time before the browser session expires."
        >
          {({ id }) => (
            <SelectControl
              id={id}
              value={String(form.value('sessionTimeoutMinutes') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('sessionTimeoutMinutes', Number(next))}
              options={SESSION_TIMEOUT_OPTIONS}
            />
          )}
        </SettingsField>

        <SettingsField
          label="Audit log retention"
          changed={form.isChanged('auditLogRetentionDays')}
        >
          {({ id }) => (
            <SelectControl
              id={id}
              value={String(form.value('auditLogRetentionDays') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('auditLogRetentionDays', Number(next))}
              options={AUDIT_RETENTION_OPTIONS}
            />
          )}
        </SettingsField>

        <p className="text-2xs text-text-muted leading-150">
          Every change made anywhere in Settings is recorded in the audit log.{' '}
          <button
            type="button"
            disabled
            title="GET /api/v1/audit-log-entries is not served yet"
            className="rounded-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
          >
            View audit log →
          </button>{' '}
          is disabled until <code className="font-mono">/api/v1/audit-log-entries</code> ships.
        </p>
      </SettingsPanel>

      <div
        className="rounded-md border border-border"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-2xs text-text-secondary uppercase">API tokens</h2>
        </div>
        <div className="px-4 py-4">
          <ApiTokensSection />
        </div>
      </div>
    </div>
  );
}

/**
 * `POST /auth/password` — served today.
 *
 * The confirm field is checked client-side before the request, because the server takes only
 * `currentPassword` + `newPassword` (§3.1) and a typo would otherwise be committed silently
 * and only discovered at the next sign-in, when the operator no longer knows what they typed.
 */
export function ChangePasswordForm() {
  const mutation = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (): void => {
    if (next !== confirm) {
      setLocalError('The new password and its confirmation do not match.');
      return;
    }
    if (next.length === 0) {
      setLocalError('Enter a new password.');
      return;
    }
    setLocalError(null);
    mutation.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
        },
      },
    );
  };

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    autoComplete: string,
  ) => (
    <div>
      <label htmlFor={id} className="mb-1 block text-text-secondary text-xs">
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-sm border bg-transparent px-2 font-mono text-sm text-text"
        style={{
          height: 'var(--mc-control-md)',
          borderColor: 'var(--color-border-control)',
          backgroundColor: 'var(--color-surface-inset)',
        }}
      />
    </div>
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {field('current-password', 'Current password', current, setCurrent, 'current-password')}
        {field('new-password', 'New password', next, setNext, 'new-password')}
        {field('confirm-password', 'Confirm', confirm, setConfirm, 'new-password')}
      </div>

      {localError === null ? null : (
        <p role="alert" className="text-sm" style={{ color: 'var(--color-danger)' }}>
          {localError}
        </p>
      )}
      {mutation.isError ? <ErrorPanel error={mutation.error} /> : null}

      <div>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-sm border border-border-control px-3 font-medium text-sm text-text disabled:opacity-50"
          style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
        >
          {mutation.isPending ? 'Updating…' : 'Update password'}
        </button>
      </div>
    </form>
  );
}
