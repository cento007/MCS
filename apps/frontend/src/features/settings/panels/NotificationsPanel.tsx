import { endpoints, queryKeys } from '../../../lib/api/index.js';
import { SettingsField, SettingsGroup, TextControl, ToggleControl } from '../components/Field.js';
import { SettingsPanel } from '../components/Panel.js';
import type { Draft } from '../dirty.js';
import { usePanelForm } from '../form.js';
import { useNotificationsSettings } from '../queries.js';
import type { NotificationsSettings } from '../types.js';

/**
 * Settings → Notifications (PRD §4.4.3, TDS 04 §7.2, TDS 06 §5.7.8).
 *
 * **The wireframe's three toggles are rendered as five, deliberately.** §5.7.8 shows "Session
 * complete / Daily report / Alerts", collapsing four distinct API booleans into one "Alerts"
 * row — but §7.2 stores `sessionFailed`, `syncFailed`, `repositoryProblem` and
 * `costBudgetAlert` separately, and §7.2's own note makes `costBudgetAlert` the *only* switch
 * for budget alerting ("`dailyUsd: null` means 'no budget', which is a different statement from
 * 'alerts off'"). A composite toggle would therefore either write four fields from one control
 * — silently turning budget alerts off when the operator meant "stop telling me about failed
 * syncs" — or leave `costBudgetAlert` unreachable from the UI entirely. The grouping heading
 * keeps WS5's information architecture; the controls keep WS2's granularity.
 */

const PATH = endpoints.settings.category('notifications');

function toDraft(document: NotificationsSettings): Draft {
  return {
    'events.sessionComplete': document.events.sessionComplete,
    'events.sessionFailed': document.events.sessionFailed,
    'events.syncFailed': document.events.syncFailed,
    'events.repositoryProblem': document.events.repositoryProblem,
    'events.costBudgetAlert': document.events.costBudgetAlert,
    'dailyReport.enabled': document.dailyReport.enabled,
    'dailyReport.time': document.dailyReport.time,
    'quietHours.enabled': document.quietHours.enabled,
    'quietHours.start': document.quietHours.start,
    'quietHours.end': document.quietHours.end,
  };
}

function toBody({ draft }: { draft: Draft }): unknown {
  return {
    events: {
      sessionComplete: draft['events.sessionComplete'] === true,
      sessionFailed: draft['events.sessionFailed'] === true,
      syncFailed: draft['events.syncFailed'] === true,
      repositoryProblem: draft['events.repositoryProblem'] === true,
      costBudgetAlert: draft['events.costBudgetAlert'] === true,
    },
    dailyReport: {
      enabled: draft['dailyReport.enabled'] === true,
      time: String(draft['dailyReport.time'] ?? '18:00'),
    },
    quietHours: {
      enabled: draft['quietHours.enabled'] === true,
      start: String(draft['quietHours.start'] ?? '23:00'),
      end: String(draft['quietHours.end'] ?? '07:30'),
    },
  };
}

const EVENT_ROWS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'events.sessionComplete', label: 'Session complete (summary, commits, duration)' },
  { name: 'events.sessionFailed', label: 'Session failed' },
  { name: 'events.syncFailed', label: 'Sync failed' },
  { name: 'events.repositoryProblem', label: 'Repository problem' },
  { name: 'events.costBudgetAlert', label: 'Cost budget alert' },
];

export function NotificationsPanel() {
  const query = useNotificationsSettings();
  const form = usePanelForm<NotificationsSettings>({
    panelId: 'notifications',
    label: 'Notifications',
    path: PATH,
    queryKey: queryKeys.settings.category('notifications'),
    query,
    toDraft,
    toBody,
  });

  return (
    <SettingsPanel title="Notifications" form={form} endpoint={PATH}>
      <SettingsGroup title="Events">
        {EVENT_ROWS.map((row) => (
          <SettingsField key={row.name} label={row.label} changed={form.isChanged(row.name)}>
            {({ id }) => (
              <ToggleControl
                id={id}
                label={row.label}
                checked={form.value(row.name) === true}
                disabled={form.disabled}
                onChange={(next) => form.set(row.name, next)}
              />
            )}
          </SettingsField>
        ))}
      </SettingsGroup>

      <SettingsGroup title="Daily report">
        <SettingsField label="Enabled" changed={form.isChanged('dailyReport.enabled')}>
          {({ id }) => (
            <ToggleControl
              id={id}
              label="Send a daily report"
              checked={form.value('dailyReport.enabled') === true}
              disabled={form.disabled}
              onChange={(next) => form.set('dailyReport.enabled', next)}
            />
          )}
        </SettingsField>

        <SettingsField
          label="Deliver at"
          changed={form.isChanged('dailyReport.time')}
          description="Local to the instance timezone set in General — not your browser's."
        >
          {({ id }) => (
            <TextControl
              id={id}
              type="time"
              value={String(form.value('dailyReport.time') ?? '')}
              disabled={form.disabled}
              onChange={(next) => form.set('dailyReport.time', next)}
            />
          )}
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Quiet hours">
        <SettingsField label="Enabled" changed={form.isChanged('quietHours.enabled')}>
          {({ id }) => (
            <ToggleControl
              id={id}
              label="Hold Telegram delivery during quiet hours"
              checked={form.value('quietHours.enabled') === true}
              disabled={form.disabled}
              onChange={(next) => form.set('quietHours.enabled', next)}
            />
          )}
        </SettingsField>

        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField label="From" changed={form.isChanged('quietHours.start')}>
            {({ id }) => (
              <TextControl
                id={id}
                type="time"
                value={String(form.value('quietHours.start') ?? '')}
                disabled={form.disabled}
                onChange={(next) => form.set('quietHours.start', next)}
              />
            )}
          </SettingsField>

          <SettingsField label="To" changed={form.isChanged('quietHours.end')}>
            {({ id }) => (
              <TextControl
                id={id}
                type="time"
                value={String(form.value('quietHours.end') ?? '')}
                disabled={form.disabled}
                onChange={(next) => form.set('quietHours.end', next)}
              />
            )}
          </SettingsField>
        </div>

        <p className="text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> During quiet hours, alerts go to the inbox only;
          Telegram delivery resumes afterwards.
        </p>
      </SettingsGroup>
    </SettingsPanel>
  );
}
