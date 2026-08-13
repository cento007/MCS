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
 * Integrations → Qdrant and Ollama (TDS 04 §7.2, TDS 06 §5.7.7).
 *
 * These two cards were written when both services were staging forms behind a phase notice:
 * "Semantic memory arrives in Phase 3 … nothing is indexed yet", and a Test Connection button
 * whose route answered `INTEGRATION_NOT_CONFIGURED` because there was no client to test with.
 * **Both halves of that have stopped being true.** The memory foundation ships the Qdrant and
 * Ollama adapters, the Services panel probes them, and the two test routes now run real checks.
 * Copy that describes a build from two phases ago is not a harmless leftover — it is the reason
 * an operator ignores a red cross that means something.
 *
 * Two rules the replacement copy follows:
 *
 *  1. **Say what the panel does, not what it will do.** Each note describes the check the button
 *     actually performs, including the one an operator would never guess at: a stamp mismatch is
 *     a *failure*, not a warning, because vectors from two models are not comparable and
 *     searching across them returns confident nonsense rather than an error.
 *  2. **Never state a temporary observation as a permanent fact.** "Nothing is indexed yet" was
 *     true when it was written and stops being true the first time anything is indexed. Index
 *     state is *reported by the test result*, which is measured; the copy only says where to
 *     look for it.
 *
 * The `P3` badge **stays** on both cards, for a narrower reason than before: the connection is
 * live, but the product surface these settings serve — retrieval, the Memory screen, memory in
 * a session — is Phase 3 work still landing. On the Ollama card it also covers the `enabled`
 * toggle, which offers Ollama as an *agent runtime* and is consumed by nothing in this build.
 * The badge now means "the feature is still arriving", not "this form does nothing".
 */

function integrationNote(text: string) {
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
          {/*
            The chip states the one fact this card can know for certain from its own document:
            whether an embedding model is set. That single field is what makes memory configured
            at all — the backend refuses to test either service without it, because the model is
            stamped permanently onto the collection and Mission Control will not choose it for
            you. "Not active" used to sit here and was simply wrong: the Services panel probes
            this host on every load.
          */}
          {String(form.value('embeddingModel') ?? '').trim().length > 0 ? (
            <PanelStatus glyph="●" label="Embedding model set" colorVar="--color-success" />
          ) : (
            <PanelStatus glyph="○" label="No embedding model" />
          )}
          <PhaseBadge phase={3} />
        </span>
      }
      actions={<TestConnection form={form} integration="qdrant" />}
    >
      {integrationNote(
        'Mission Control stores semantic memory as vectors here. Test Connection checks that ' +
          'Qdrant answers and that the mc_memory collection’s embedding stamp still matches ' +
          'the model below — a mismatch fails the test rather than warning, because vectors ' +
          'from two different models are not comparable and searching across them returns ' +
          'confident nonsense instead of an error. The check only reads: it reports how many ' +
          'points are indexed and creates nothing. Retrieval and the Memory screen are the ' +
          'Phase 3 work still landing.',
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
        clearConsequence="Clear Qdrant API key? Mission Control will then connect without one — indexing and search stop working if the server requires a key."
      />

      <SettingsField
        label="Embedding model"
        changed={form.isChanged('embeddingModel')}
        description="Run by Ollama, stamped onto the collection. Changing it after anything is indexed makes the stored vectors unusable until the collection is rebuilt — Test Connection is what tells you that has happened."
      >
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
          {/*
            Deliberately narrow wording. The toggle governs Ollama as an *agent runtime* and
            nothing else; embeddings go through this host whenever an embedding model is
            configured, whatever the toggle says. A chip reading "Disabled" beside a service
            Mission Control is actively embedding through would be the same class of untruth
            this card is being corrected for.
          */}
          {form.value('enabled') === true ? (
            <PanelStatus glyph="●" label="Agent runtime on" colorVar="--color-success" />
          ) : (
            <PanelStatus glyph="○" label="Agent runtime off" />
          )}
          <PhaseBadge phase={3} />
        </span>
      }
      actions={<TestConnection form={form} integration="ollama" />}
    >
      {integrationNote(
        'Ollama produces the embedding vectors for semantic memory, using the model set on the ' +
          'Qdrant card. Test Connection checks that Ollama is running and that the model is ' +
          'genuinely an embedder: asking a chat model to embed costs about half a minute before ' +
          'it fails, so the capability is read from the model manifest instead. On success the ' +
          'result reports the dimension — the number that has to match the collection.',
      )}

      <SettingsField
        label="Enabled"
        changed={form.isChanged('enabled')}
        description="Agent runtimes are a later phase, and nothing reads this flag yet. Embeddings do not depend on it: they use the host and port below whenever an embedding model is configured."
      >
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
        description="The model offered to agents that run on Ollama — not the embedding model, which is set on the Qdrant card and is what Test Connection checks."
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
