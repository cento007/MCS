import {
  type Db,
  type IntegrationSlug,
  normalizeSetting,
  settingKey,
  type TestConnectionResult,
} from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { readMemoryConfig } from '../../memory/settings.js';
import { SecretUnreadableError, type SecretVault } from '../secrets.js';
import { findSecretRow } from '../store.js';
import { readCategoryValues } from '../values.js';
import {
  type ExecutorDeps,
  testClaudeCode,
  testGithub,
  testObsidian,
  testOllama,
  testQdrant,
  testTelegram,
} from './executors.js';
import {
  createCommandProbe,
  createHttpProbe,
  createMemoryPortFactory,
  createPathProbe,
} from './ports.js';

/**
 * `POST /api/v1/settings/integrations/{integration}/test-connection` (TDS 04 §7.4).
 *
 * This service does three things and delegates the rest:
 *
 *  1. **Reads persisted settings** — never a request body. The route takes no body at all, so
 *     testing unsaved input is not merely discouraged, it is unrepresentable (WS5 §5.7.2: "a
 *     green check on unsaved input is a false pass on the exact question the operator asked").
 *  2. **Decides configured vs not.** A missing credential or path is the one case §7.4 makes
 *     an *error* rather than a result: `INTEGRATION_NOT_CONFIGURED` (409), because Mission
 *     Control declined to ask rather than the integration declining to answer. The UI renders
 *     the two differently on purpose.
 *  3. **Hands the plaintext to exactly one executor** and returns its result. A secret that
 *     cannot be decrypted is reported as `ok: false` with a specific, actionable message —
 *     the integration is configured; this process simply cannot read the credential, and a
 *     generic 500 would send the operator looking in the wrong place.
 */

export * from './executors.js';
export * from './ports.js';

export interface TestConnectionServiceOptions {
  readonly db: Db;
  readonly vault: SecretVault;
  /** Injected in tests; defaults to the real network, filesystem and child-process ports. */
  readonly deps?: ExecutorDeps;
  readonly onSecretUnreadable?: (error: SecretUnreadableError) => void;
}

export class TestConnectionService {
  readonly #db: Db;
  readonly #vault: SecretVault;
  readonly #deps: ExecutorDeps;
  readonly #onSecretUnreadable: ((error: SecretUnreadableError) => void) | undefined;

  constructor(options: TestConnectionServiceOptions) {
    this.#db = options.db;
    this.#vault = options.vault;
    this.#deps = options.deps ?? {
      http: createHttpProbe(),
      path: createPathProbe(),
      command: createCommandProbe(),
      memory: createMemoryPortFactory(),
    };
    this.#onSecretUnreadable = options.onSecretUnreadable;
  }

  async run(slug: IntegrationSlug): Promise<TestConnectionResult> {
    switch (slug) {
      case 'github':
        return this.#github();
      case 'telegram':
        return this.#telegram();
      case 'obsidian':
        return this.#obsidian();
      case 'claude-code':
        return this.#claudeCode();
      case 'qdrant':
        return this.#qdrant();
      case 'ollama':
        return this.#ollama();
    }
  }

  async #github(): Promise<TestConnectionResult> {
    const token = await this.#secret('integrations.github.token', 'a GitHub personal access token');
    if (typeof token !== 'string') return token.result;
    return testGithub(this.#deps, { token });
  }

  async #telegram(): Promise<TestConnectionResult> {
    const botToken = await this.#secret('integrations.telegram.botToken', 'a Telegram bot token');
    if (typeof botToken !== 'string') return botToken.result;

    const values = await readCategoryValues(this.#db, 'integrations');
    const chatId = normalizeSetting<string | null>(
      'integrations.telegram.chatId',
      values.get(settingKey('integrations.telegram.chatId')),
    );
    return testTelegram(this.#deps, { botToken, chatId });
  }

  async #obsidian(): Promise<TestConnectionResult> {
    const values = await readCategoryValues(this.#db, 'integrations');
    const vaultPath = normalizeSetting<string | null>(
      'integrations.obsidian.vaultPath',
      values.get(settingKey('integrations.obsidian.vaultPath')),
    );
    if (vaultPath === null) {
      throw new ApiError(
        'INTEGRATION_NOT_CONFIGURED',
        'No Obsidian vault path is saved. Enter the absolute path to the vault directory and save it first.',
        { integration: 'obsidian', missing: ['vaultPath'] },
      );
    }
    return testObsidian(this.#deps, { vaultPath });
  }

  async #claudeCode(): Promise<TestConnectionResult> {
    const values = await readCategoryValues(this.#db, 'integrations');
    const cliPath = normalizeSetting<string>(
      'integrations.claudeCode.cliPath',
      values.get(settingKey('integrations.claudeCode.cliPath')),
    );
    return testClaudeCode(this.#deps, { cliPath });
  }

  /**
   * Qdrant (§7.4, Phase 3).
   *
   * `readMemoryConfig` is the same read the Services panel and the startup verification make,
   * so this button cannot form a different opinion about the same machine than the health row
   * next to it. Its three answers map onto the three things that can be true:
   *
   *  - **not configured** — no embedding model. That is a refused request (409), not a failed
   *    check: without a model there is no stamp to compare a collection against, and answering
   *    "reachable ✓" while memory is switched off is precisely the dishonesty being removed
   *    here. Its `reason` explains why Mission Control will not pick a model on the operator's
   *    behalf.
   *  - **secret unreadable** — configured, but this process cannot decrypt the stored API key.
   *    A completed check that failed, exactly as for GitHub, because the fix is
   *    `MC_ENCRYPTION_KEY` and not a settings field.
   *  - **configured** — hand the plaintext to the executor and nowhere else.
   */
  async #qdrant(): Promise<TestConnectionResult> {
    const result = await readMemoryConfig({ db: this.#db, vault: this.#vault });

    if (result.kind === 'not_configured') {
      throw new ApiError('INTEGRATION_NOT_CONFIGURED', result.reason, {
        integration: 'qdrant',
        missing: [...result.missing],
      });
    }
    if (result.kind === 'secret_unreadable') {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        message: result.reason,
        detail: {
          reason: 'secret_unreadable',
          key: settingKey('integrations.qdrant.apiKey'),
          keyVersion: result.keyVersion,
        },
      };
    }

    const { config } = result;
    return testQdrant(this.#deps, {
      host: config.qdrant.host,
      port: config.qdrant.port,
      apiKey: config.qdrant.apiKey,
      model: config.embeddingModel,
      ollamaHost: config.ollama.host,
      ollamaPort: config.ollama.port,
    });
  }

  /**
   * Ollama (§7.4, Phase 3).
   *
   * Reads the settings directly rather than through `readMemoryConfig`, for one reason: that
   * helper opens the **Qdrant** API key, and a Qdrant key this process cannot decrypt would
   * then fail the Ollama check for a fault Ollama has nothing to do with. Ollama holds no
   * credential, so this path never touches the vault at all.
   *
   * The model under test is `integrations.qdrant.embeddingModel` — the embedder is configured on
   * the Qdrant card because it is stamped onto the Qdrant collection, and it is *that* name
   * whose capabilities decide whether anything can ever be indexed.
   * `integrations.ollama.defaultModel` is the agent-runtime choice and is a different question,
   * for a phase that has not shipped.
   */
  async #ollama(): Promise<TestConnectionResult> {
    const values = await readCategoryValues(this.#db, 'integrations');
    const read = <T>(path: string): T => normalizeSetting<T>(path, values.get(settingKey(path)));

    const model = read<string>('integrations.qdrant.embeddingModel').trim();
    if (model.length === 0) {
      throw new ApiError(
        'INTEGRATION_NOT_CONFIGURED',
        'No embedding model is configured, so there is nothing to ask Ollama about. Set the ' +
          'embedding model on the Qdrant card (`integrations.qdrant.embeddingModel`) to a model ' +
          'Ollama can embed with — for example `nomic-embed-text` — then test again.',
        {
          integration: 'ollama',
          missing: [settingKey('integrations.qdrant.embeddingModel')],
        },
      );
    }

    return testOllama(this.#deps, {
      host: read<string>('integrations.ollama.host'),
      port: read<number>('integrations.ollama.port'),
      model,
    });
  }

  /**
   * The stored plaintext, or the result to return instead.
   *
   * Returning a union rather than throwing keeps the two failure modes distinguishable at the
   * call site: "no credential saved" is a refused request (409), "saved but unreadable" is a
   * completed check that failed.
   */
  async #secret(
    path: string,
    description: string,
  ): Promise<string | { readonly result: TestConnectionResult }> {
    const key = settingKey(path);
    const row = await findSecretRow(this.#db, 'integrations', key);

    if (row === null) {
      throw new ApiError(
        'INTEGRATION_NOT_CONFIGURED',
        `No credential is saved for this integration. Save ${description} first, then test.`,
        { missing: [key] },
      );
    }

    try {
      return this.#vault.open({ category: 'integrations', key }, row);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      this.#onSecretUnreadable?.(error);
      return {
        result: {
          ok: false,
          checkedAt: new Date().toISOString(),
          latencyMs: null,
          // `error.message` is written for an operator and contains no ciphertext, no key
          // material and no plaintext — see `SecretUnreadableError`.
          message: error.message,
          detail: { reason: 'secret_unreadable', key, keyVersion: error.keyVersion },
        },
      };
    }
  }
}
