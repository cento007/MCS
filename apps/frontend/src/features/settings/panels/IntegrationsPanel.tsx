import { endpoints } from '../../../lib/api/index.js';
import { UnavailableNote } from '../components/Panel.js';
import { isEndpointMissing, useIntegrationsSettings } from '../queries.js';
import { ClaudeCodeCard } from './ClaudeCodeCard.js';
import { GithubCard } from './GithubCard.js';
import { ObsidianCard } from './ObsidianCard.js';
import { TelegramCard } from './TelegramCard.js';
import { OllamaCard, QdrantCard } from './VectorCards.js';

/**
 * Settings → Integrations (PRD §4.4.2, TDS 06 §5.7.2).
 *
 * Six cards, each with its own dirty state, its own `[Save changes]` and its own Test
 * Connection. They are separate panels rather than one giant form because the API writes them
 * separately (`PUT /settings/integrations/{integration}`) and because a single save bar
 * spanning six credentials would make "3 changes" ambiguous about *which* integration is about
 * to be rewritten.
 *
 * The bootstrap footnote is mandatory (§5.7.2). Without it the absence of a listen-port or
 * database field reads as an omission rather than as the deliberate F8.2 boundary it is —
 * these values are required *before* the database is reachable, so they cannot live in it.
 */
export function IntegrationsPanel() {
  // One read backs all six cards (§7.3), so one note explains all six unavailable states.
  const integrations = useIntegrationsSettings();
  const unavailable = integrations.isError && isEndpointMissing(integrations.error);

  return (
    <div className="flex flex-col gap-4">
      {unavailable ? <UnavailableNote endpoint={endpoints.settings.integrations} /> : null}

      <GithubCard />
      <ClaudeCodeCard />
      <TelegramCard />
      <ObsidianCard />
      <QdrantCard />
      <OllamaCard />

      <p className="text-2xs text-text-muted leading-150">
        Database connection, listen address, data directory and encryption key are{' '}
        <strong className="font-medium">bootstrap settings</strong> configured in the server
        environment file. They are required before the database is reachable, so they are
        deliberately not stored in it and never appear in Settings.
      </p>
    </div>
  );
}
