import { endpoints } from '../../../lib/api/index.js';
import type { Draft } from '../../../lib/forms/dirty.js';
import { SettingsField, TextControl, ToggleControl } from '../components/Field.js';
import { PanelStatus, SettingsPanel } from '../components/Panel.js';
import { SecretField } from '../components/SecretField.js';
import { TestConnection } from '../components/TestConnection.js';
import type { TelegramSettings } from '../types.js';
import { nullableText, useIntegrationForm } from './integration-form.js';

/**
 * Integrations → Telegram (PRD §4.4.2, TDS 04 §7.2, TDS 06 §5.7.5).
 *
 * Test Connection here **sends a real message** to the configured chat, so the button says so
 * before it is pressed: a "test" with an externally-visible side effect that is not announced
 * is a surprise the operator cannot take back.
 */

function toDraft(document: TelegramSettings): Draft {
  return {
    enabled: document.enabled,
    chatId: document.chatId ?? '',
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
    enabled: draft['enabled'] === true,
    chatId: nullableText(draft['chatId']),
    ...('botToken' in secrets ? { botToken: secrets['botToken'] ?? null } : {}),
  };
}

export function TelegramCard() {
  const form = useIntegrationForm<TelegramSettings>({
    slug: 'telegram',
    label: 'Telegram',
    toDraft,
    toBody,
  });

  const enabled = form.document?.enabled === true;

  return (
    <SettingsPanel
      title="Telegram"
      headingLevel={3}
      compactUnavailable
      form={form}
      endpoint={endpoints.settings.integration('telegram')}
      status={
        enabled ? (
          <PanelStatus glyph="●" label="Enabled" colorVar="--color-success" />
        ) : (
          <PanelStatus glyph="○" label="Disabled" />
        )
      }
      actions={
        <TestConnection
          form={form}
          integration="telegram"
          // The executor calls `getMe` and sends nothing (WS2 §7.4 declined the test message
          // for V1: an unannounced external side effect, for a worker that ships in Phase 2).
          // The old copy promised a message that never arrives — an operator would have read
          // a silent chat as a broken integration when the token was in fact fine.
          note="→ checks the bot token (no message sent)"
          describeSuccess={(result) => result.message}
        />
      }
    >
      <SettingsField label="Enabled" changed={form.isChanged('enabled')}>
        {({ id }) => (
          <ToggleControl
            id={id}
            label="Deliver notifications to Telegram"
            checked={form.value('enabled') === true}
            disabled={form.disabled}
            onChange={(next) => form.set('enabled', next)}
          />
        )}
      </SettingsField>

      <SecretField
        form={form}
        name="botToken"
        label="Bot token"
        current={form.document?.botToken ?? null}
        clearConsequence="Clear Telegram bot token? Notification delivery to Telegram will stop until a new token is saved."
      />

      <SettingsField label="Chat ID" changed={form.isChanged('chatId')}>
        {({ id }) => (
          <TextControl
            id={id}
            mono
            value={String(form.value('chatId') ?? '')}
            disabled={form.disabled}
            placeholder="-100123456789"
            onChange={(next) => form.set('chatId', next)}
          />
        )}
      </SettingsField>

      <p className="text-2xs text-text-muted leading-150">
        The Telegram Worker ships in Phase 2. Configuration saved here is stored now and picked up
        when that service is deployed.
      </p>
    </SettingsPanel>
  );
}
