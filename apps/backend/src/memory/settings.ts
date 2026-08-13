import {
  type Db,
  type DbTransaction,
  normalizeSetting,
  type SettingsCategory,
  settingKey,
} from '@mc/shared';
import { SecretUnreadableError, type SecretVault } from '../settings/secrets.js';
import { findSecretRow } from '../settings/store.js';
import { readCategoryValues } from '../settings/values.js';

/**
 * Reading the Phase 3 memory configuration out of the settings store.
 *
 * The registry (`@mc/shared` §7.6) already owns the keys, their defaults and their validation;
 * this module owns exactly one question the registry cannot answer: **is memory configured at
 * all**, and if not, which field is missing. That distinction drives everything downstream —
 * "not configured" is a `disabled` health row and a silent no-op at startup, while "configured
 * and broken" is a red row and a logged failure.
 *
 * ## What counts as configured
 *
 * `integrations.qdrant.embeddingModel` defaults to `''`, exactly like `claudeCode.defaultModel`,
 * and `''` is the honest "the operator has not chosen yet". There is no safe fallback to invent:
 * picking `nomic-embed-text` on the operator's behalf would stamp a collection with a model they
 * never chose, and every vector in it would then be wrong the moment they chose differently.
 * So an empty model name means memory is off, full stop.
 *
 * Host and port both have real defaults (`127.0.0.1:6333`, `127.0.0.1:11434`), so they are never
 * the reason memory is unconfigured.
 *
 * ## The API key
 *
 * Read through the vault, held in memory only, and **never returned to a caller that is going
 * to serialize it**. `MemoryConfig` is an internal shape — nothing in this module puts it in a
 * response, a log line or an audit row, and `redactSecret` guards every string built from an
 * error in the adapters that receive it. A test scans serialized output for the key.
 */

export interface MemoryConfig {
  readonly qdrant: {
    readonly host: string;
    readonly port: number;
    /** Plaintext, or `null` when no key is stored (Qdrant may run without one). */
    readonly apiKey: string | null;
  };
  readonly ollama: {
    readonly host: string;
    readonly port: number;
  };
  /** The embedding model, guaranteed non-empty — an empty one means `not_configured`. */
  readonly embeddingModel: string;
}

export type MemoryConfigResult =
  | { readonly kind: 'configured'; readonly config: MemoryConfig }
  | {
      readonly kind: 'not_configured';
      readonly reason: string;
      readonly missing: readonly string[];
    }
  /**
   * Configured, but the stored API key cannot be decrypted — `MC_ENCRYPTION_KEY` does not match
   * the rows. Deliberately not folded into `not_configured`: the operator did configure this,
   * and telling them otherwise would send them to the wrong settings field.
   */
  | { readonly kind: 'secret_unreadable'; readonly reason: string; readonly keyVersion: number };

const CATEGORY: SettingsCategory = 'integrations';

export interface ReadMemoryConfigOptions {
  readonly db: Db | DbTransaction;
  readonly vault: SecretVault;
}

export async function readMemoryConfig(
  options: ReadMemoryConfigOptions,
): Promise<MemoryConfigResult> {
  const values = await readCategoryValues(options.db, CATEGORY);
  const read = <T>(path: string): T => normalizeSetting<T>(path, values.get(settingKey(path)));

  const embeddingModel = read<string>('integrations.qdrant.embeddingModel').trim();
  if (embeddingModel.length === 0) {
    return {
      kind: 'not_configured',
      reason:
        'No embedding model is configured. Set `integrations.qdrant.embeddingModel` to a model ' +
        'Ollama can embed with (for example `nomic-embed-text`) — Mission Control will not pick ' +
        'one on your behalf, because the choice is stamped permanently onto the vector collection.',
      missing: [settingKey('integrations.qdrant.embeddingModel')],
    };
  }

  const apiKeyKey = settingKey('integrations.qdrant.apiKey');
  let apiKey: string | null = null;
  const row = await findSecretRow(options.db, CATEGORY, apiKeyKey);
  if (row !== null) {
    try {
      apiKey = options.vault.open({ category: CATEGORY, key: apiKeyKey }, row);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      // `error.message` is written for an operator and contains no ciphertext, no key material
      // and no plaintext — see `SecretUnreadableError`.
      return { kind: 'secret_unreadable', reason: error.message, keyVersion: error.keyVersion };
    }
  }

  return {
    kind: 'configured',
    config: {
      qdrant: {
        host: read<string>('integrations.qdrant.host'),
        port: read<number>('integrations.qdrant.port'),
        apiKey,
      },
      ollama: {
        host: read<string>('integrations.ollama.host'),
        port: read<number>('integrations.ollama.port'),
      },
      embeddingModel,
    },
  };
}

/**
 * A one-line summary safe to log.
 *
 * Exists so that "log the memory config at startup" is a thing someone can do without thinking
 * about it. There is no `apiKey` field on the returned object at all — not a masked one, not a
 * length — because a masked field is still a field someone can widen later.
 */
export function describeMemoryConfig(config: MemoryConfig): Record<string, unknown> {
  return {
    qdrantHost: config.qdrant.host,
    qdrantPort: config.qdrant.port,
    qdrantApiKeySet: config.qdrant.apiKey !== null,
    ollamaHost: config.ollama.host,
    ollamaPort: config.ollama.port,
    embeddingModel: config.embeddingModel,
  };
}
