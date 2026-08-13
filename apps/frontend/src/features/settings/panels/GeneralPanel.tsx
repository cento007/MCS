import { endpoints, queryKeys } from '../../../lib/api/index.js';
import { SelectControl, SettingsField, TextControl } from '../components/Field.js';
import { SettingsPanel } from '../components/Panel.js';
import type { Draft } from '../dirty.js';
import { usePanelForm } from '../form.js';
import { useGeneralSettings } from '../queries.js';
import {
  DATE_FORMATS,
  type GeneralSettings,
  LANDING_PAGES,
  THEMES,
  TIME_FORMATS,
} from '../types.js';

/**
 * Settings → General (PRD §4.4.1, TDS 04 §7.2, TDS 06 §5.7.1).
 *
 * `general.timezone` is the most consequential field on this screen and the panel says so: it
 * is the calendar boundary the Backend uses for the spend read model (§7.8) and the daily
 * report (§7.7). It is explicitly *not* the browser's zone, so a wrong value here rolls
 * "today" at the wrong hour on every surface that shows a daily total.
 */

const PATH = endpoints.settings.category('general');

function toDraft(document: GeneralSettings): Draft {
  return {
    instanceName: document.instanceName,
    timezone: document.timezone,
    dateFormat: document.dateFormat,
    timeFormat: document.timeFormat,
    theme: document.theme,
    defaultLandingPage: document.defaultLandingPage,
  };
}

function toBody({ draft }: { draft: Draft }): unknown {
  return {
    instanceName: String(draft['instanceName'] ?? ''),
    timezone: String(draft['timezone'] ?? ''),
    dateFormat: String(draft['dateFormat'] ?? ''),
    timeFormat: String(draft['timeFormat'] ?? '24h'),
    theme: String(draft['theme'] ?? 'dark'),
    defaultLandingPage: String(draft['defaultLandingPage'] ?? 'dashboard'),
  };
}

/**
 * IANA zones from the platform, so the list cannot go stale in this repository.
 *
 * `Intl.supportedValuesOf` is ES2022 and present in every browser this product targets, but it
 * is probed rather than assumed: a runtime without it must still render a usable control, and
 * the stored zone is always included so an existing value can never silently disappear from
 * its own dropdown.
 */
export function timezoneOptions(current: string): readonly string[] {
  let zones: readonly string[] = [];
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    if (Array.isArray(supported)) zones = supported;
  } catch {
    zones = [];
  }
  if (zones.length === 0) {
    zones = ['UTC', 'Europe/Amsterdam', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
  }
  return current.length > 0 && !zones.includes(current) ? [current, ...zones] : zones;
}

export function GeneralPanel() {
  const query = useGeneralSettings();
  const form = usePanelForm<GeneralSettings>({
    panelId: 'general',
    label: 'General',
    path: PATH,
    queryKey: queryKeys.settings.category('general'),
    query,
    toDraft,
    toBody,
  });

  const timezone = String(form.value('timezone') ?? '');

  return (
    <SettingsPanel title="General" form={form} endpoint={PATH}>
      <SettingsField label="Instance name" changed={form.isChanged('instanceName')}>
        {({ id }) => (
          <TextControl
            id={id}
            value={String(form.value('instanceName') ?? '')}
            disabled={form.disabled}
            placeholder="Mission Control — Home"
            onChange={(next) => form.set('instanceName', next)}
          />
        )}
      </SettingsField>

      <SettingsField
        label="Timezone"
        changed={form.isChanged('timezone')}
        description="The calendar boundary the server uses for daily spend totals and the daily report — not your browser's zone."
      >
        {({ id }) => (
          <SelectControl
            id={id}
            value={timezone}
            disabled={form.disabled}
            onChange={(next) => form.set('timezone', next)}
            options={timezoneOptions(timezone).map((zone) => ({ value: zone, label: zone }))}
          />
        )}
      </SettingsField>

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Date format" changed={form.isChanged('dateFormat')}>
          {({ id }) => (
            <SelectControl
              id={id}
              value={String(form.value('dateFormat') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('dateFormat', next)}
              options={DATE_FORMATS.map((format) => ({ value: format, label: format }))}
            />
          )}
        </SettingsField>

        <SettingsField label="Time format" changed={form.isChanged('timeFormat')}>
          {({ id }) => (
            <SelectControl
              id={id}
              value={String(form.value('timeFormat') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('timeFormat', next)}
              options={TIME_FORMATS.map((format) => ({ value: format, label: format }))}
            />
          )}
        </SettingsField>
      </div>

      <SettingsField
        label="Theme"
        changed={form.isChanged('theme')}
        // Stated rather than hidden: §7.2's enum admits `light`, and TDS 06 §2.6.2 records
        // that no light palette was designed for V1. Offering the option silently would let
        // an operator select a theme that does not render.
        description="Dark is the default and the only palette designed for V1 — selecting Light stores the preference but changes nothing on screen yet."
      >
        {({ id }) => (
          <SelectControl
            id={id}
            value={String(form.value('theme') ?? '')}
            disabled={form.disabled}
            onChange={(next) => form.set('theme', next)}
            options={THEMES.map((theme) => ({
              value: theme,
              label: theme === 'dark' ? 'Dark (default)' : 'Light (not implemented in V1)',
            }))}
          />
        )}
      </SettingsField>

      <SettingsField label="Default landing page" changed={form.isChanged('defaultLandingPage')}>
        {({ id }) => (
          <SelectControl
            id={id}
            value={String(form.value('defaultLandingPage') ?? '')}
            disabled={form.disabled}
            onChange={(next) => form.set('defaultLandingPage', next)}
            options={LANDING_PAGES.map((page) => ({
              value: page,
              label: page.charAt(0).toUpperCase() + page.slice(1),
            }))}
          />
        )}
      </SettingsField>
    </SettingsPanel>
  );
}
