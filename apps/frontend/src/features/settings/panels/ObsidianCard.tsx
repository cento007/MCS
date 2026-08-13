import { endpoints } from '../../../lib/api/index.js';
import {
  RadioGroupControl,
  SelectControl,
  SettingsField,
  TextControl,
} from '../components/Field.js';
import { PanelStatus, SettingsPanel } from '../components/Panel.js';
import { TestConnection } from '../components/TestConnection.js';
import type { Draft } from '../dirty.js';
import {
  OBSIDIAN_CONFLICT_POLICIES,
  OBSIDIAN_CONFLICT_POLICY_LABELS,
  OBSIDIAN_SYNC_MODES,
  type ObsidianSettings,
} from '../types.js';
import { nullableText, numberOr, useIntegrationForm } from './integration-form.js';
import { SYNC_INTERVAL_OPTIONS } from './options.js';

/**
 * Integrations → Obsidian (PRD §4.4.2, TDS 04 §7.2, TDS 06 §5.7.6).
 *
 * The "Last sync ✓ 14:32 · 42 notes · 0 conflicts" line of §5.7.6 is **not rendered**: it reads
 * the newest `SyncRun` and the `sync.conflict_detected` count, and `GET /sync-runs` is Phase 2
 * (TDS 04 §10) with no route today. Stating a sync result the client cannot obtain would be the
 * one thing worse than omitting it — §5.7.6 is explicit that a run can succeed *with* conflicts,
 * so a fabricated "0 conflicts" would be wrong in exactly the case that matters.
 */

const SYNC_MODE_LABELS: Readonly<Record<(typeof OBSIDIAN_SYNC_MODES)[number], string>> = {
  two_way: 'Two-way',
  one_way: 'One-way',
  paused: 'Paused',
};

function toDraft(document: ObsidianSettings): Draft {
  return {
    vaultPath: document.vaultPath ?? '',
    syncMode: document.syncMode,
    syncIntervalMinutes: document.syncIntervalMinutes,
    conflictPolicy: document.conflictPolicy,
  };
}

function toBody({ draft }: { draft: Draft }): unknown {
  return {
    vaultPath: nullableText(draft['vaultPath']),
    syncMode: String(draft['syncMode'] ?? 'paused'),
    syncIntervalMinutes: numberOr(draft['syncIntervalMinutes'], 0),
    conflictPolicy: String(draft['conflictPolicy'] ?? 'newer_wins'),
  };
}

export function ObsidianCard() {
  const form = useIntegrationForm<ObsidianSettings>({
    slug: 'obsidian',
    label: 'Obsidian',
    toDraft,
    toBody,
  });

  const mode = form.document?.syncMode ?? 'paused';

  return (
    <SettingsPanel
      title="Obsidian"
      headingLevel={3}
      compactUnavailable
      form={form}
      endpoint={endpoints.settings.integration('obsidian')}
      status={
        mode === 'paused' ? (
          <PanelStatus glyph="‖" label="Paused" colorVar="--color-warning" />
        ) : (
          <PanelStatus glyph="●" label="Configured" colorVar="--color-success" />
        )
      }
      actions={<TestConnection form={form} integration="obsidian" />}
    >
      <SettingsField
        label="Vault path"
        changed={form.isChanged('vaultPath')}
        description="Absolute native path to the vault directory."
      >
        {({ id }) => (
          <TextControl
            id={id}
            mono
            value={String(form.value('vaultPath') ?? '')}
            disabled={form.disabled}
            placeholder="D:\Vaults\Engineering"
            onChange={(next) => form.set('vaultPath', next)}
          />
        )}
      </SettingsField>

      <SettingsField label="Sync mode" changed={form.isChanged('syncMode')}>
        {() => (
          <RadioGroupControl
            name="obsidian-sync-mode"
            legend="Sync mode"
            value={String(form.value('syncMode') ?? '')}
            disabled={form.disabled}
            onChange={(next) => form.set('syncMode', next)}
            options={OBSIDIAN_SYNC_MODES.map((value) => ({
              value,
              label: SYNC_MODE_LABELS[value],
            }))}
          />
        )}
      </SettingsField>

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Sync interval" changed={form.isChanged('syncIntervalMinutes')}>
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

        <SettingsField label="Conflict policy" changed={form.isChanged('conflictPolicy')}>
          {({ id }) => (
            <SelectControl
              id={id}
              value={String(form.value('conflictPolicy') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('conflictPolicy', next)}
              options={OBSIDIAN_CONFLICT_POLICIES.map((value) => ({
                value,
                label: OBSIDIAN_CONFLICT_POLICY_LABELS[value],
              }))}
            />
          )}
        </SettingsField>
      </div>

      <p className="text-2xs text-text-muted leading-150">
        Sync history and conflict counts appear here when the Sync Worker and{' '}
        <code className="font-mono">/api/v1/sync-runs</code> ship in Phase 2.
      </p>
    </SettingsPanel>
  );
}
