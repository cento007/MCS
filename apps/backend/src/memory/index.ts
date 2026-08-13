import type { Db } from '@mc/shared';
import { type MemoryProvisionReport, provisionMemoryCollection } from '@mc/shared';
import type { SecretVault } from '../settings/secrets.js';
import {
  createMemoryClients,
  createMemoryProbes,
  type MemoryClients,
  type MemoryProbes,
} from './health.js';
import { describeMemoryConfig, type MemoryConfig, readMemoryConfig } from './settings.js';

/**
 * `memory/` — the Backend's half of the Phase 3 memory foundation (PRD §6).
 *
 * The ports, adapters, fakes and the embedding stamp live in `@mc/shared/memory`, because the
 * Sync Worker will index and the Backend will retrieve and F2.2 forbids a worker importing
 * Backend modules. What lives *here* is the part that needs the database: reading the
 * configuration out of `settings` / `secret_items`, the Services health rows, and the startup
 * verification.
 *
 * **No routes.** This is foundation only — ingestion, the search API and the Memory UI are the
 * follow-ups, and shipping an endpoint before there is anything to serve would be a promise the
 * product cannot keep.
 *
 * Layout:
 *   settings.ts  read the qdrant/ollama configuration; "configured" vs "not configured"
 *   health.ts    the two `GET /services/health` rows, bounded and never throwing
 *   index.ts     wiring: the probes the app installs, and the startup verification
 */

export * from './health.js';
export * from './settings.js';

export interface MemoryModuleOptions {
  readonly db: Db;
  readonly vault: SecretVault;
  /** Injected by tests so nothing reaches the network. */
  readonly build?: ((config: MemoryConfig) => MemoryClients) | undefined;
  readonly probeTimeoutMs?: number | undefined;
}

export interface MemoryModule {
  readonly probes: MemoryProbes;
  /**
   * Identify the model, then create-or-verify the stamped collection. Safe to call at startup
   * and safe to call again; returns a report and never throws.
   */
  verify(): Promise<
    MemoryProvisionReport | { readonly kind: 'not_configured'; readonly message: string }
  >;
}

export function createMemoryModule(options: MemoryModuleOptions): MemoryModule {
  const readConfig = () => readMemoryConfig({ db: options.db, vault: options.vault });
  const build = options.build ?? createMemoryClients;

  return {
    probes: createMemoryProbes({
      readConfig,
      build,
      ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }),
    }),

    async verify() {
      const result = await readConfig();
      if (result.kind !== 'configured') {
        return { kind: 'not_configured', message: result.reason };
      }
      const { embedder, store } = build(result.config);
      return provisionMemoryCollection({ embedder, store });
    },
  };
}

/**
 * Startup verification, as one call `main.ts` makes and logs.
 *
 * Never fatal, and that is the design: Phase 1 and Phase 2 do not need a vector store, so
 * refusing to boot because Qdrant is down would take out session management to protect a search
 * box that does not exist yet. A stamp mismatch is logged at `error` — the one condition here
 * that means "stop trusting this index" rather than "this dependency is offline".
 */
export async function verifyMemoryAtStartup(
  memory: MemoryModule,
  log: {
    info: (object: object, message: string) => void;
    warn: (object: object, message: string) => void;
    error: (object: object, message: string) => void;
  },
  config?: MemoryConfig,
): Promise<void> {
  const report = await memory.verify();
  // Never the API key — `describeMemoryConfig` has no field for it, only `qdrantApiKeySet`.
  const context = config === undefined ? {} : describeMemoryConfig(config);

  switch (report.kind) {
    case 'ready':
      log.info(
        {
          ...context,
          collection: report.collection,
          model: report.stamp.model,
          dimension: report.stamp.dimension,
          points: report.pointCount,
          created: report.created,
          adopted: report.adopted,
          stampPersisted: report.stampPersisted,
        },
        'memory collection verified',
      );
      return;
    case 'stamp_mismatch':
      log.error(
        { ...context, ...report.detail },
        'memory collection stamp does not match the configured embedding model — retrieval is disabled',
      );
      return;
    case 'not_configured':
      log.info({ ...context }, 'memory is not configured — no embedding model is set');
      return;
    default:
      log.warn({ ...context, reason: report.kind }, report.message);
  }
}
