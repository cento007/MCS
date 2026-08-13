import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { type ApiError, apiGet, endpoints, queryKeys, type Spend } from '../../../lib/api/index.js';
import { formatMoneyUsd } from '../../../lib/format/index.js';
import {
  NumberControl,
  SelectControl,
  SettingsField,
  TextControl,
  ToggleControl,
} from '../components/Field.js';
import { SettingsPanel } from '../components/Panel.js';
import { TestConnection } from '../components/TestConnection.js';
import type { Draft } from '../dirty.js';
import type { ClaudeCodeSettings } from '../types.js';
import { nullableNumber, numberOr, useIntegrationForm } from './integration-form.js';
import { ALERT_THRESHOLD_OPTIONS } from './options.js';

/**
 * Integrations → Claude Code (PRD §4.4.2, TDS 04 §7.2/§7.8, TDS 06 §5.7.4).
 *
 * **Current spend is shown beside the budget that governs it** (UX finding WC1). A budget field
 * with no visible current value asks the operator to set a limit against a number the product
 * already knows and is not showing. The number comes from `GET /spend` — the same computed read
 * model the Dashboard widget and the top-bar chip use — so the four surfaces that state this
 * figure cannot disagree.
 *
 * There is no secret field here: CLI authentication belongs to Claude Code itself.
 */

function toDraft(document: ClaudeCodeSettings): Draft {
  return {
    cliPath: document.cliPath,
    defaultModel: document.defaultModel,
    maxConcurrentSessions: document.maxConcurrentSessions,
    'costBudget.enabled': document.costBudget.dailyUsd !== null,
    'costBudget.dailyUsd': document.costBudget.dailyUsd ?? '',
    'costBudget.perSessionUsd': document.costBudget.perSessionUsd ?? '',
    'costBudget.alertThresholdPercent': document.costBudget.alertThresholdPercent,
  };
}

function toBody({ draft }: { draft: Draft }): unknown {
  const budgetEnabled = draft['costBudget.enabled'] === true;
  return {
    cliPath: String(draft['cliPath'] ?? ''),
    defaultModel: String(draft['defaultModel'] ?? ''),
    maxConcurrentSessions: numberOr(draft['maxConcurrentSessions'], 3),
    costBudget: {
      // `null` means *no budget*, which §7.2 keeps distinct from "alerts off" (that lives in
      // `notifications.events.costBudgetAlert`). Unticking the box states the former.
      dailyUsd: budgetEnabled ? nullableNumber(draft['costBudget.dailyUsd']) : null,
      perSessionUsd: budgetEnabled ? nullableNumber(draft['costBudget.perSessionUsd']) : null,
      alertThresholdPercent: numberOr(draft['costBudget.alertThresholdPercent'], 80),
    },
  };
}

/** §7.8 — read-only here; the Settings panel never computes spend itself. */
function useSpend() {
  return useQuery<Spend, ApiError>({
    queryKey: queryKeys.spend(),
    queryFn: ({ signal }) => apiGet<Spend>(endpoints.spend, { signal }),
    retry: false,
    staleTime: 30_000,
  });
}

export function ClaudeCodeCard() {
  const form = useIntegrationForm<ClaudeCodeSettings>({
    slug: 'claude-code',
    label: 'Claude Code',
    toDraft,
    toBody,
  });
  const spend = useSpend();

  const budgetEnabled = form.value('costBudget.enabled') === true;
  const dailyBudget = spend.data?.budget.dailyUsd ?? null;
  const spentToday = spend.data?.day.totalCostUsd ?? null;

  return (
    <SettingsPanel
      title="Claude Code"
      headingLevel={3}
      compactUnavailable
      form={form}
      endpoint={endpoints.settings.integration('claude-code')}
      actions={
        <TestConnection
          form={form}
          integration="claude-code"
          note="validates the executable path and reports the CLI version"
        />
      }
    >
      <SettingsField
        label="CLI executable path"
        changed={form.isChanged('cliPath')}
        description="Absolute native path to claude / claude.exe."
      >
        {({ id }) => (
          <TextControl
            id={id}
            mono
            value={String(form.value('cliPath') ?? '')}
            disabled={form.disabled}
            placeholder="C:\Users\…\claude.exe"
            onChange={(next) => form.set('cliPath', next)}
          />
        )}
      </SettingsField>

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Default model" changed={form.isChanged('defaultModel')}>
          {({ id }) => (
            <TextControl
              id={id}
              mono
              value={String(form.value('defaultModel') ?? '')}
              disabled={form.disabled}
              placeholder="claude-sonnet-4-5"
              onChange={(next) => form.set('defaultModel', next)}
            />
          )}
        </SettingsField>

        <SettingsField
          label="Max concurrent sessions"
          changed={form.isChanged('maxConcurrentSessions')}
          description="Launches above this are queued, never rejected."
        >
          {({ id }) => (
            <NumberControl
              id={id}
              min={1}
              max={64}
              value={numberValue(form.value('maxConcurrentSessions'))}
              disabled={form.disabled}
              onChange={(next) => form.set('maxConcurrentSessions', next === '' ? '' : next)}
            />
          )}
        </SettingsField>
      </div>

      <SettingsField label="Cost budget alerts" changed={form.isChanged('costBudget.enabled')}>
        {({ id }) => (
          <ToggleControl
            id={id}
            label="Enabled"
            checked={budgetEnabled}
            disabled={form.disabled}
            onChange={(next) => form.set('costBudget.enabled', next)}
          />
        )}
      </SettingsField>

      {budgetEnabled ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <SettingsField label="Daily budget" changed={form.isChanged('costBudget.dailyUsd')}>
            {({ id }) => (
              <NumberControl
                id={id}
                prefix="$"
                min={0}
                step={0.01}
                value={numberValue(form.value('costBudget.dailyUsd'))}
                disabled={form.disabled}
                onChange={(next) => form.set('costBudget.dailyUsd', next)}
              />
            )}
          </SettingsField>

          <SettingsField
            label="Per-session budget"
            changed={form.isChanged('costBudget.perSessionUsd')}
          >
            {({ id }) => (
              <NumberControl
                id={id}
                prefix="$"
                min={0}
                step={0.01}
                value={numberValue(form.value('costBudget.perSessionUsd'))}
                disabled={form.disabled}
                onChange={(next) => form.set('costBudget.perSessionUsd', next)}
              />
            )}
          </SettingsField>

          <SettingsField
            label="Alert at"
            changed={form.isChanged('costBudget.alertThresholdPercent')}
          >
            {({ id }) => (
              <SelectControl
                id={id}
                value={String(form.value('costBudget.alertThresholdPercent') ?? '')}
                disabled={form.disabled}
                onChange={(next) => form.set('costBudget.alertThresholdPercent', Number(next))}
                options={ALERT_THRESHOLD_OPTIONS.map((option) => ({
                  value: option.value,
                  label: `${option.label} %`,
                }))}
              />
            )}
          </SettingsField>
        </div>
      ) : null}

      <p className="text-2xs text-text-muted">
        {spend.isError ? (
          'Current spend is unavailable right now.'
        ) : spentToday === null ? (
          'Current spend loading…'
        ) : (
          <>
            Today <span className="font-mono">{formatMoneyUsd(spentToday)}</span>
            {dailyBudget === null ? (
              ' · no daily budget configured'
            ) : (
              <>
                {' of '}
                <span className="font-mono">{formatMoneyUsd(dailyBudget)}</span>
                {` · ${Math.round((spentToday / Math.max(dailyBudget, 0.0001)) * 100)}%`}
              </>
            )}{' '}
            <Link to="/" className="underline decoration-dotted underline-offset-2">
              View on Dashboard →
            </Link>
          </>
        )}
      </p>
    </SettingsPanel>
  );
}

/** `NumberControl` models a half-cleared input as `''`; anything unusable degrades to that. */
function numberValue(value: unknown): number | '' {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return '';
}
