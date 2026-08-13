import { PhaseBadge } from '../../../components/PhasePlaceholder.js';
import { endpoints } from '../../../lib/api/index.js';
import { NumberControl, SettingsField, TextControl, ToggleControl } from '../components/Field.js';
import { PanelStatus, SettingsPanel } from '../components/Panel.js';
import { SecretField } from '../components/SecretField.js';
import { TestConnection } from '../components/TestConnection.js';
import type { Draft } from '../dirty.js';
import type { OllamaSettings, QdrantSettings } from '../types.js';
import { numberOr, useIntegrationForm } from './integration-form.js';

/**
 * Integrations → Qdrant and Ollama (TDS 04 §7.2 Phase 3 stubs, TDS 06 §5.7.7).
 *
 * > "Both forms are wireframed … but render behind a phase notice; fields are editable so
 * > configuration can be staged, and Test Connection is present but returns the WS2 stub
 * > behavior until Phase 3."
 *
 * The phase notice is a **notice**, not a disablement: the card header carries a muted badge
 * and the fields stay live, because staging configuration ahead of the phase is the stated
 * purpose. Per §7.4 their test routes answer `INTEGRATION_NOT_CONFIGURED` until Phase 3, which
 * `TestConnection` renders as the refused-request case with its code and requestId — an honest
 * "not yet", not a fake pass.
 */

function phaseNote(text: string) {
  return (
    <p
      className="rounded-sm border p-3 text-2xs text-text-secondary leading-150"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-inset)' }}
    >
      <span aria-hidden="true">ⓘ</span> {text}
    </p>
  );
}

// ------------------------------------------------------------------------------------ qdrant

function qdrantDraft(document: QdrantSettings): Draft {
  return {
    host: document.host,
    port: document.port,
    embeddingModel: document.embeddingModel,
  };
}

function qdrantBody({
  draft,
  secrets,
}: {
  draft: Draft;
  secrets: Readonly<Record<string, string | null>>;
}): unknown {
  return {
    host: String(draft['host'] ?? ''),
    port: numberOr(draft['port'], 6333),
    embeddingModel: String(draft['embeddingModel'] ?? ''),
    ...('apiKey' in secrets ? { apiKey: secrets['apiKey'] ?? null } : {}),
  };
}

export function QdrantCard() {
  const form = useIntegrationForm<QdrantSettings>({
    slug: 'qdrant',
    label: 'Qdrant',
    toDraft: qdrantDraft,
    toBody: qdrantBody,
  });

  return (
    <SettingsPanel
      title="Qdrant"
      headingLevel={3}
      compactUnavailable
      form={form}
      endpoint={endpoints.settings.integration('qdrant')}
      status={
        <span className="flex items-center gap-2">
          <PanelStatus glyph="◌" label="Not active" />
          <PhaseBadge phase={3} />
        </span>
      }
      actions={<TestConnection form={form} integration="qdrant" />}
    >
      {phaseNote(
        'Semantic memory arrives in Phase 3. You can configure and test the connection now; nothing is indexed yet.',
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Host" changed={form.isChanged('host')}>
          {({ id }) => (
            <TextControl
              id={id}
              mono
              value={String(form.value('host') ?? '')}
              disabled={form.disabled}
              placeholder="127.0.0.1"
              onChange={(next) => form.set('host', next)}
            />
          )}
        </SettingsField>

        <SettingsField label="Port" changed={form.isChanged('port')}>
          {({ id }) => (
            <NumberControl
              id={id}
              min={1}
              max={65535}
              value={typeof form.value('port') === 'number' ? (form.value('port') as number) : ''}
              disabled={form.disabled}
              onChange={(next) => form.set('port', next)}
            />
          )}
        </SettingsField>
      </div>

      <SecretField
        form={form}
        name="apiKey"
        label="API key"
        current={form.document?.apiKey ?? null}
        clearConsequence="Clear Qdrant API key? Semantic search will lose access to the vector store when Phase 3 ships."
      />

      <SettingsField label="Embedding model" changed={form.isChanged('embeddingModel')}>
        {({ id }) => (
          <TextControl
            id={id}
            mono
            value={String(form.value('embeddingModel') ?? '')}
            disabled={form.disabled}
            placeholder="nomic-embed-text"
            onChange={(next) => form.set('embeddingModel', next)}
          />
        )}
      </SettingsField>
    </SettingsPanel>
  );
}

// ------------------------------------------------------------------------------------ ollama

function ollamaDraft(document: OllamaSettings): Draft {
  return {
    enabled: document.enabled,
    host: document.host,
    port: document.port,
    defaultModel: document.defaultModel,
  };
}

function ollamaBody({ draft }: { draft: Draft }): unknown {
  return {
    enabled: draft['enabled'] === true,
    host: String(draft['host'] ?? ''),
    port: numberOr(draft['port'], 11434),
    defaultModel: String(draft['defaultModel'] ?? ''),
  };
}

export function OllamaCard() {
  const form = useIntegrationForm<OllamaSettings>({
    slug: 'ollama',
    label: 'Ollama',
    toDraft: ollamaDraft,
    toBody: ollamaBody,
  });

  return (
    <SettingsPanel
      title="Ollama (optional)"
      headingLevel={3}
      compactUnavailable
      form={form}
      endpoint={endpoints.settings.integration('ollama')}
      status={
        <span className="flex items-center gap-2">
          <PanelStatus glyph="◌" label="Not active" />
          <PhaseBadge phase={3} />
        </span>
      }
      actions={<TestConnection form={form} integration="ollama" />}
    >
      {phaseNote(
        'Ollama is an optional local runtime from Phase 3+. Configuration can be staged now; no session runs on it yet.',
      )}

      <SettingsField label="Enabled" changed={form.isChanged('enabled')}>
        {({ id }) => (
          <ToggleControl
            id={id}
            label="Offer Ollama as an agent runtime"
            checked={form.value('enabled') === true}
            disabled={form.disabled}
            onChange={(next) => form.set('enabled', next)}
          />
        )}
      </SettingsField>

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Host" changed={form.isChanged('host')}>
          {({ id }) => (
            <TextControl
              id={id}
              mono
              value={String(form.value('host') ?? '')}
              disabled={form.disabled}
              placeholder="127.0.0.1"
              onChange={(next) => form.set('host', next)}
            />
          )}
        </SettingsField>

        <SettingsField label="Port" changed={form.isChanged('port')}>
          {({ id }) => (
            <NumberControl
              id={id}
              min={1}
              max={65535}
              value={typeof form.value('port') === 'number' ? (form.value('port') as number) : ''}
              disabled={form.disabled}
              onChange={(next) => form.set('port', next)}
            />
          )}
        </SettingsField>
      </div>

      <SettingsField
        label="Default model"
        changed={form.isChanged('defaultModel')}
        description="Populated from the server after a successful Test Connection, once Phase 3 ships."
      >
        {({ id }) => (
          <TextControl
            id={id}
            mono
            value={String(form.value('defaultModel') ?? '')}
            disabled={form.disabled}
            placeholder="llama3.1"
            onChange={(next) => form.set('defaultModel', next)}
          />
        )}
      </SettingsField>
    </SettingsPanel>
  );
}
