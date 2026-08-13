import {
  type Db,
  type IntegrationSlug,
  normalizeSetting,
  settingKey,
  type TestConnectionResult,
} from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { SecretUnreadableError, type SecretVault } from '../secrets.js';
import { findSecretRow } from '../store.js';
import { readCategoryValues } from '../values.js';
import {
  type ExecutorDeps,
  testClaudeCode,
  testGithub,
  testObsidian,
  testTelegram,
} from './executors.js';
import { createCommandProbe, createHttpProbe, createPathProbe } from './ports.js';

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
      default:
        // §7.4: "`qdrant`, `ollama` (Phase 3+ stubs — routes reserved, return
        // INTEGRATION_NOT_CONFIGURED until their phases land)". There is no client for either
        // in this build, so a green tick would be a fabrication and a red cross would blame
        // the operator's configuration for a feature that does not exist yet.
        throw new ApiError(
          'INTEGRATION_NOT_CONFIGURED',
          `${slug === 'qdrant' ? 'Qdrant' : 'Ollama'} is a Phase 3 integration — Mission Control has no client for it yet, so there is nothing to test. Settings saved here are stored and picked up when that phase ships.`,
          { integration: slug, phase: 3 },
        );
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
