import type { AppConfig, Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../events/index.js';
import { registerSettingsRoutes } from './routes.js';
import { type SecretUnreadableError, SecretVault } from './secrets.js';
import { SettingsService } from './service.js';
import type { ExecutorDeps } from './test-connection/executors.js';
import { TestConnectionService } from './test-connection/index.js';

/**
 * `settings/` — typed read/write over `settings` and `secret_items` (TDS 02 §2, TDS 04 §7,
 * PRD §4.4).
 *
 * Layout:
 *   values.ts          every read of `settings` / `secret_items` (presence, never plaintext)
 *   store.ts           every write, on a transaction handle
 *   secrets.ts         the only seal/unseal in the Backend; loud, specific decryption failure
 *   documents.ts       registry -> API document, and `PUT` body -> desired state (pure)
 *   service.ts         the §7.3 contract: one transaction per write, audit + `setting.updated`
 *   test-connection/   the §7.4 executors and their bounded ports
 *   routes.ts          `/api/v1/settings/*`
 *   general.ts, claude-code.ts, integrations.ts, notifications.ts, security.ts
 *                      the typed internal reads the Session domain and the read models use —
 *                      same registry, same defaults, no parallel source of truth
 *
 * Boundary reminder (F8.2): the seven bootstrap variables are env-only. They have no registry
 * entries by construction, and `registry.test.ts` asserts that mechanically.
 */

export * from './documents.js';
export * from './secrets.js';
export * from './service.js';
export * from './store.js';
export * from './test-connection/index.js';
export * from './values.js';

export interface RegisterSettingsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  /**
   * Bootstrap config, for `MC_ENCRYPTION_KEY`. Optional because `buildApp` allows a config-less
   * test app; without it, reads and non-secret writes work and a **secret** write fails with a
   * stated reason rather than silently storing nothing.
   */
  readonly config?: AppConfig | undefined;
  /**
   * The vault, when the caller already built one.
   *
   * Phase 3's memory layer needs to read `integrations.qdrant.apiKey` at a point in `app.ts`
   * that is *earlier* than settings registration (the Services health probes are registered
   * before it), and two vaults over one key would be two places to change a key-rotation
   * policy. `app.ts` therefore builds it once and hands it here; omitting it keeps the
   * self-constructing behaviour every existing caller relies on.
   */
  readonly vault?: SecretVault | undefined;
  /** Injected by unit tests to stub the network, filesystem and child-process edges. */
  readonly testConnectionDeps?: ExecutorDeps | undefined;
  readonly onSecretUnreadable?: ((error: SecretUnreadableError) => void) | undefined;
}

export interface SettingsModule {
  readonly settings: SettingsService;
  readonly testConnection: TestConnectionService;
  readonly vault: SecretVault;
}

export function registerSettings(
  app: FastifyInstance,
  options: RegisterSettingsOptions,
): SettingsModule {
  const vault =
    options.vault ?? new SecretVault({ encryptionKey: options.config?.encryptionKey ?? null });

  const settings = new SettingsService({ db: options.db, outbox: options.outbox, vault });

  const testConnection = new TestConnectionService({
    db: options.db,
    vault,
    ...(options.testConnectionDeps === undefined ? {} : { deps: options.testConnectionDeps }),
    onSecretUnreadable:
      options.onSecretUnreadable ??
      ((error) => {
        // The one place a decryption failure is logged. It names the coordinate and the key
        // version and nothing else — no ciphertext, no key material (TDS 07 §8).
        app.log.error(
          { category: error.category, key: error.key, keyVersion: error.keyVersion },
          'stored secret could not be decrypted — MC_ENCRYPTION_KEY does not match the stored rows',
        );
      }),
  });

  registerSettingsRoutes(app, { settings, testConnection });

  return { settings, testConnection, vault };
}
